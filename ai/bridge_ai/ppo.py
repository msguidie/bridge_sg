"""Rollouts, per-seat GAE on the global time axis, and the PPO update.

Every step each game has exactly one acting seat, so one actor forward pass
serves all games.  The privileged critic predicts the final reward of all four
seats at every state; GAE then runs as four reward channels along the global
time axis (other seats' moves are part of the environment from a seat's point
of view).  No per-seat trajectory bookkeeping is needed, and the bootstrap at
the end of a window is a state the critic is trained on.  The policy uses the
acting seat's channel; the critic regresses all four lambda-returns.
"""
from __future__ import annotations

import torch
import torch.nn.functional as F

from .config import Config
from .engine import NUM_ACTIONS, RESULT_LEN, BridgeEnv, summarize
from .features import OBS_DIM, PRIV_DIM, actor_obs, aux_targets, loyalist_candidates, priv_obs, rot
from .model import Actor, Critic, autocast, sample


def to_abs(v_rel: torch.Tensor, cur: torch.Tensor) -> torch.Tensor:
    """[...,4] indexed by seat relative to ``cur`` -> absolute seats."""
    return v_rel.gather(-1, (torch.arange(4, device=cur.device) - cur.unsqueeze(-1)) % 4)


def to_rel(v_abs: torch.Tensor, cur: torch.Tensor) -> torch.Tensor:
    """[...,4] indexed by absolute seat -> relative to ``cur``."""
    return v_abs.gather(-1, (cur.unsqueeze(-1) + torch.arange(4, device=cur.device)) % 4)


def gae(value: torch.Tensor, reward: torch.Tensor, done: torch.Tensor, lam: float):
    """value [T+1,B,4] (absolute seats; value[T] bootstraps unfinished games),
    reward [T,B,4], done [T,B] (the game ended at step t; row t+1 is a new deal).
    gamma = 1.  Returns (advantages, lambda-returns), both [T,B,4]."""
    T = reward.shape[0]
    adv = torch.zeros_like(reward)
    last = torch.zeros_like(value[0])
    for t in range(T - 1, -1, -1):
        live = (~done[t]).float().unsqueeze(-1)
        delta = reward[t] + live * value[t + 1] - value[t]
        last = delta + lam * live * last
        adv[t] = last
    return adv, adv + value[:T]


def sample_opp_seats(n: int, frac: float, gen: torch.Generator, device: torch.device) -> torch.Tensor:
    """[n,4] bool: with probability ``frac`` a game gets 1 or 2 random seats played by the pool opponent."""
    use = torch.rand(n, generator=gen, device=device) < frac
    k = 1 + (torch.rand(n, generator=gen, device=device) < 0.5).long()
    order = torch.rand(n, 4, generator=gen, device=device).argsort(1).argsort(1)
    return (order < k.unsqueeze(1)) & use.unsqueeze(1)


class Roller:
    """Keeps B games running across iterations and fills a [T,B] buffer per collect()."""

    def __init__(self, cfg: Config, device: torch.device, seed: int):
        T, B = cfg.rollout_len, cfg.num_envs
        self.cfg, self.device, self.T, self.B = cfg, device, T, B
        self.env = BridgeEnv(B, device, seed)
        self.gen = torch.Generator(device=device)
        self.gen.manual_seed(seed + 1)
        self.opp_seats = torch.zeros(B, 4, dtype=torch.bool, device=device)
        obs_dtype = torch.bfloat16 if (cfg.amp and device.type == "cuda") else torch.float32

        def buf(*shape: int, dtype: torch.dtype = torch.float32) -> torch.Tensor:
            return torch.zeros(shape, dtype=dtype, device=device)

        self.obs = buf(T, B, OBS_DIM, dtype=obs_dtype)
        self.priv = buf(T, B, PRIV_DIM, dtype=torch.bool)
        self.mask = buf(T, B, NUM_ACTIONS, dtype=torch.bool)
        self.cand = buf(T, B, 4, dtype=torch.bool)
        self.action = buf(T, B, dtype=torch.long)
        self.logp = buf(T, B)
        self.seat = buf(T, B, dtype=torch.long)
        self.phase = buf(T, B, dtype=torch.long)
        self.learner = buf(T, B, dtype=torch.bool)
        self.holder = buf(T, B, 52, dtype=torch.int8)
        self.loyal = buf(T, B, dtype=torch.long)
        self.value = buf(T + 1, B, 4)
        self.reward = buf(T, B, 4)
        self.done = buf(T, B, dtype=torch.bool)

    def _refresh(self, pool_on: bool) -> None:
        fresh = self.env.reset_done()
        if pool_on:
            new = sample_opp_seats(self.B, self.cfg.pool_frac, self.gen, self.device)
        else:
            new = torch.zeros_like(self.opp_seats)
        self.opp_seats = torch.where(fresh.unsqueeze(1), new, self.opp_seats)

    @torch.no_grad()
    def collect(self, actor: Actor, critic: Critic, opp: Actor | None) -> dict:
        env, amp = self.env, self.cfg.amp
        sums = torch.zeros(RESULT_LEN, device=self.device)
        for t in range(self.T):
            self._refresh(opp is not None)
            obs = actor_obs(env)
            priv = priv_obs(env, self.opp_seats)
            mask = env.legal_mask()
            cur = env.cur
            if opp is not None:
                by_opp = self.opp_seats[env.ar, cur]
            else:
                by_opp = torch.zeros_like(env.done)
            with autocast(self.device, amp):
                logits = actor.policy_logits(obs)
                if opp is not None:
                    logits = torch.where(by_opp.unsqueeze(1), opp.policy_logits(obs), logits)
                value = critic(obs, priv)
            action, logp = sample(logits, mask, self.gen)
            holder, loyal = aux_targets(env)
            self.obs[t] = obs.to(self.obs.dtype)
            self.priv[t] = priv
            self.mask[t] = mask
            self.cand[t] = rot(loyalist_candidates(env), cur)
            self.action[t] = action
            self.logp[t] = logp
            self.seat[t] = cur
            self.phase[t] = env.phase
            self.learner[t] = ~by_opp
            self.holder[t] = holder.to(torch.int8)
            self.loyal[t] = loyal
            self.value[t] = to_abs(value.float(), cur)
            reward, ended = env.step(action)
            self.reward[t] = reward
            self.done[t] = ended
            sums += env.result_sums(ended)
        self._refresh(opp is not None)
        with autocast(self.device, amp):
            value = critic(actor_obs(env), priv_obs(env, self.opp_seats))
        self.value[self.T] = to_abs(value.float(), env.cur)
        return summarize(sums)


def update(actor: Actor, critic: Critic, opt: torch.optim.Optimizer, ro: Roller, cfg: Config,
           ent_coef: float) -> dict:
    """PPO epochs over the last rollout. Pool-opponent moves feed the critic and aux heads only."""
    T, B = ro.T, ro.B
    N = T * B
    adv, ret = gae(ro.value, ro.reward, ro.done, cfg.lam)
    seat = ro.seat.unsqueeze(2)
    v_pi = ro.value[:T].gather(2, seat).squeeze(2)
    r_pi = ret.gather(2, seat).squeeze(2)
    ev = float(1 - (r_pi - v_pi).var() / r_pi.var().clamp(min=1e-8))

    def flat(x: torch.Tensor) -> torch.Tensor:
        return x.reshape(N, *x.shape[2:])

    adv_pi = flat(adv.gather(2, seat).squeeze(2))
    ret_rel = flat(to_rel(ret, ro.seat))
    obs, priv, mask, action = flat(ro.obs), flat(ro.priv), flat(ro.mask), flat(ro.action)
    old_logp, learner, phase = flat(ro.logp), flat(ro.learner), flat(ro.phase)
    holder, loyal, cand = flat(ro.holder), flat(ro.loyal), flat(ro.cand)
    device = obs.device
    params_a, params_c = list(actor.parameters()), list(critic.parameters())
    acc: dict[str, torch.Tensor] = {}

    def add(name: str, x: torch.Tensor) -> None:
        acc[name] = acc[name] + x.detach().float() if name in acc else x.detach().float()

    n_mb = 0
    for epoch in range(cfg.epochs):
        perm = torch.randperm(N, device=device)
        for start in range(0, N, cfg.minibatch):
            i = perm[start:start + cfg.minibatch]
            m, lrn = mask[i], learner[i].float()
            with autocast(device, cfg.amp):
                logits, belief, loyal_logits, v_aux = actor(obs[i])
                v = critic(obs[i], priv[i])
            logp_all = torch.log_softmax(logits.float().masked_fill(~m, -1e9), -1)
            logp = logp_all.gather(1, action[i].unsqueeze(1)).squeeze(1)
            log_ratio = logp - old_logp[i]
            ratio = log_ratio.exp()
            n_l = lrn.sum().clamp(min=1.0)
            a = adv_pi[i]
            mean = (a * lrn).sum() / n_l
            std = (((a - mean) ** 2) * lrn).sum().div(n_l).sqrt()
            a = (a - mean) / (std + 1e-8)
            surr = torch.min(ratio * a, ratio.clamp(1 - cfg.clip, 1 + cfg.clip) * a)
            pg_loss = -(surr * lrn).sum() / n_l
            ent = -(logp_all.exp() * logp_all).sum(-1)
            ent_mean = (ent * lrn).sum() / n_l
            h = holder[i].long()
            h_mask = (h >= 0).float()
            b_ce = F.cross_entropy(belief.float().reshape(-1, 4), h.clamp(min=0).reshape(-1),
                                   reduction="none").view(-1, 52)
            belief_loss = (b_ce * h_mask).sum() / h_mask.sum().clamp(min=1.0)
            ly = loyal[i]
            l_mask = (ly >= 0).float()
            l_ce = F.cross_entropy(loyal_logits.float(), ly.clamp(min=0), reduction="none")
            loyal_loss = (l_ce * l_mask).sum() / l_mask.sum().clamp(min=1.0)
            r = ret_rel[i]
            vaux_loss = F.mse_loss(v_aux.float(), r[:, 0])
            v_loss = F.mse_loss(v.float(), r)
            loss = (pg_loss - ent_coef * ent_mean + cfg.vf_coef * v_loss
                    + cfg.aux_coef * (belief_loss + loyal_loss + vaux_loss))
            opt.zero_grad(set_to_none=True)
            loss.backward()
            torch.nn.utils.clip_grad_norm_(params_a, cfg.max_grad_norm)
            torch.nn.utils.clip_grad_norm_(params_c, cfg.max_grad_norm)
            opt.step()
            with torch.no_grad():
                add("pg_loss", pg_loss)
                add("v_loss", v_loss)
                add("belief_loss", belief_loss)
                add("loyal_loss", loyal_loss)
                add("vaux_loss", vaux_loss)
                add("kl", (((ratio - 1) - log_ratio) * lrn).sum() / n_l)
                add("clipfrac", (((ratio - 1).abs() > cfg.clip).float() * lrn).sum() / n_l)
                if epoch == 0:
                    for p, name in enumerate(("auction", "call", "play")):
                        pm = (phase[i] == p).float() * lrn
                        add(f"ent_{name}_sum", (ent * pm).sum())
                        add(f"ent_{name}_n", pm.sum())
                    add("belief_hit", ((belief.argmax(-1) == h).float() * h_mask).sum())
                    add("belief_n", h_mask.sum())
                    add("loyal_hit", ((loyal_logits.argmax(-1) == ly).float() * l_mask).sum())
                    add("loyal_n", l_mask.sum())
                    add("loyal_base", (l_mask / cand[i].float().sum(-1).clamp(min=1.0)).sum())
            n_mb += 1
    out = {k: float(v) for k, v in acc.items()}
    res = {k: out[k] / n_mb for k in ("pg_loss", "v_loss", "belief_loss", "loyal_loss", "vaux_loss", "kl", "clipfrac")}
    for name in ("auction", "call", "play"):
        res[f"ent_{name}"] = out[f"ent_{name}_sum"] / max(out[f"ent_{name}_n"], 1.0)
    res["belief_acc"] = out["belief_hit"] / max(out["belief_n"], 1.0)
    res["loyal_acc"] = out["loyal_hit"] / max(out["loyal_n"], 1.0)
    res["loyal_base"] = out["loyal_base"] / max(out["loyal_n"], 1.0)
    res["ev"] = ev
    return res
