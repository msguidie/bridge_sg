"""Self-play PPO training on one device.

    python -m bridge_ai.train --preset base --run-dir runs/base [--set key=value ...]

Resumes automatically from <run-dir>/latest.pt (its saved config, then --set on
top).  Stops after train_hours of wall clock (summed over sessions), after
max_iters, or on SIGTERM/SIGINT, saving first.  Writes metrics.jsonl, a short
log line on stdout, and actor snapshots (the opponent pool) in snapshots/.
"""
from __future__ import annotations

import argparse
import json
import os
import signal
import time
from dataclasses import asdict
from pathlib import Path

import torch

from . import arena
from .config import Config, apply_overrides, make_config
from .features import OBS_DIM, OBS_VERSION
from .model import Actor, Critic
from .ppo import Roller, update
from .report import fmt_arena, fmt_train


class Pool:
    """Actor snapshots on disk (snapshots/actor_<minute>.pt); the newest ``size`` are the opponents."""

    def __init__(self, folder: Path, size: int):
        self.folder, self.size = folder, size
        folder.mkdir(parents=True, exist_ok=True)
        self.files = {int(p.stem.split("_")[1]): p for p in folder.glob("actor_*.pt")}
        self.cache: dict[int, dict] = {}

    def _recent(self) -> list[int]:
        return sorted(self.files)[-self.size:]

    def _trim(self) -> None:
        keep = set(self._recent())
        for m in [m for m in self.cache if m not in keep]:
            del self.cache[m]

    def add(self, actor: Actor, minute: int) -> None:
        sd = {k: v.detach().to("cpu", copy=True) for k, v in actor.state_dict().items()}
        path = self.folder / f"actor_{minute:05d}.pt"
        tmp = path.with_suffix(".tmp")
        torch.save(sd, tmp)
        os.replace(tmp, path)
        self.files[minute] = path
        self.cache[minute] = sd
        self._trim()

    def _load(self, minute: int) -> dict:
        if minute not in self.cache:
            self.cache[minute] = torch.load(self.files[minute], map_location="cpu", weights_only=True)
        return self.cache[minute]

    def sample(self, gen: torch.Generator) -> dict | None:
        recent = self._recent()
        if not recent:
            return None
        return self._load(recent[int(torch.randint(len(recent), (1,), generator=gen))])

    def at_or_before(self, minute: int) -> dict | None:
        older = [m for m in self.files if m <= minute]
        if not older:
            return None
        sd = self._load(max(older))
        self._trim()
        return sd


def run_arena(actor: Actor, pool: Pool, cfg: Config, device: torch.device, now: float, seed: int) -> dict:
    """In-training check: vs the heuristic (1+3) and vs our own past self (2+2, 2 h and 6 h ago)."""
    me = arena.NetPolicy(actor, amp=cfg.amp)
    rec: dict = {"type": "arena", "hours": now / 3600,
                 "vs_heuristic": arena.duplicate(me, arena.HeuristicPolicy(), "1+3", cfg.arena_deals, device, seed)}
    for hours in (2, 6):
        sd = pool.at_or_before(int((now - hours * 3600) // 60))
        if sd is not None:
            old = Actor(cfg.width, cfg.blocks).to(device).eval()
            old.load_state_dict(sd)
            rec[f"vs_{hours}h_ago"] = arena.duplicate(
                me, arena.NetPolicy(old, amp=cfg.amp), "2+2", cfg.arena_deals, device, seed + hours)
    return rec


def resolve_device(name: str) -> torch.device:
    if name == "auto":
        return torch.device("cuda" if torch.cuda.is_available() else "cpu")
    return torch.device(name)


def main(argv: list[str] | None = None) -> None:
    ap = argparse.ArgumentParser(description=__doc__, formatter_class=argparse.RawDescriptionHelpFormatter)
    ap.add_argument("--preset", default="base", help="config preset for a NEW run (see config.py)")
    ap.add_argument("--run-dir", required=True)
    ap.add_argument("--set", dest="sets", action="append", default=[], metavar="KEY=VALUE")
    args = ap.parse_args(argv)
    run = Path(args.run_dir)
    run.mkdir(parents=True, exist_ok=True)
    latest = run / "latest.pt"
    ck = torch.load(latest, map_location="cpu", weights_only=False) if latest.exists() else None
    cfg = apply_overrides(Config(**ck["config"]) if ck else make_config(args.preset), args.sets)
    device = resolve_device(cfg.device)
    torch.set_float32_matmul_precision("high")
    state: dict = dict(ck["state"]) if ck else {
        "iteration": 0, "elapsed": 0.0, "env_steps": 0, "games": 0.0,
        "last_ckpt": 0.0, "last_snap": 0.0, "last_arena": 0.0}
    seed = cfg.seed * 100003 + int(state["iteration"])
    torch.manual_seed(seed)

    actor = Actor(cfg.width, cfg.blocks, cfg.pass_bias, cfg.bid_slope).to(device)
    critic = Critic(cfg.width, cfg.blocks).to(device)
    opt = torch.optim.Adam([*actor.parameters(), *critic.parameters()], lr=cfg.lr)
    if ck:
        actor.load_state_dict(ck["actor"])
        critic.load_state_dict(ck["critic"])
        opt.load_state_dict(ck["opt"])
    n_params = sum(p.numel() for p in actor.parameters()) / 1e6
    print(f"run {run} | device {device} | actor {n_params:.1f}M params | obs {OBS_DIM} | "
          + (f"resumed at iteration {state['iteration']} ({state['elapsed'] / 3600:.2f} h)" if ck else "new run"),
          flush=True)
    print(json.dumps(asdict(cfg)), flush=True)

    roller = Roller(cfg, device, seed)
    opp = Actor(cfg.width, cfg.blocks).to(device).eval()
    pool = Pool(run / "snapshots", cfg.pool_size)
    pool_gen = torch.Generator().manual_seed(seed)
    stop: list[int] = []
    handlers = {s: signal.signal(s, lambda signum, frame: stop.append(signum))
                for s in (signal.SIGTERM, signal.SIGINT)}
    t0, base = time.time(), float(state["elapsed"])

    def elapsed() -> float:
        return base + time.time() - t0

    def save() -> None:
        state["elapsed"] = state["last_ckpt"] = elapsed()
        tmp = run / "latest.pt.tmp"
        torch.save({"config": asdict(cfg), "obs_version": OBS_VERSION, "actor": actor.state_dict(),
                    "critic": critic.state_dict(), "opt": opt.state_dict(), "state": state}, tmp)
        os.replace(tmp, latest)

    log = (run / "metrics.jsonl").open("a")

    def emit(rec: dict, line: str) -> None:
        log.write(json.dumps(rec) + "\n")
        log.flush()
        print(line, flush=True)

    budget = cfg.train_hours * 3600
    try:
        while not stop:
            now = elapsed()
            progress = min(now / budget, 1.0)
            if progress >= 1.0 or (cfg.max_iters > 0 and state["iteration"] >= cfg.max_iters):
                break
            lr = cfg.lr * (1 - (1 - cfg.lr_final_frac) * progress)
            for g in opt.param_groups:
                g["lr"] = lr
            ent_coef = cfg.ent_start + (cfg.ent_end - cfg.ent_start) * progress
            sd = pool.sample(pool_gen) if cfg.pool_frac > 0 else None
            if sd is not None:
                opp.load_state_dict(sd)
            tic = time.time()
            results = roller.collect(actor, critic, opp if sd is not None else None)
            stats = update(actor, critic, opt, roller, cfg, ent_coef)
            dt = time.time() - tic
            state["iteration"] += 1
            state["env_steps"] += roller.T * roller.B
            state["games"] += results["games"]
            now = elapsed()
            if state["iteration"] % cfg.log_every == 0 or state["iteration"] == 1:
                rec = {"type": "train", "it": state["iteration"], "hours": now / 3600, "progress": progress,
                       "lr": lr, "ent_coef": ent_coef, "env_steps": state["env_steps"],
                       "games_total": state["games"], "sps": roller.T * roller.B / dt, **results, **stats}
                emit(rec, fmt_train(rec))
            if now - state["last_snap"] >= cfg.snapshot_every_min * 60:
                pool.add(actor, int(now // 60))
                state["last_snap"] = now
            if now - state["last_arena"] >= cfg.arena_every_min * 60:
                rec = run_arena(actor, pool, cfg, device, now, seed + int(state["iteration"]))
                emit(rec, fmt_arena(rec))
                state["last_arena"] = now
            if now - state["last_ckpt"] >= cfg.ckpt_every_min * 60:
                save()
        save()
        print(f"saved {latest} at iteration {state['iteration']} ({elapsed() / 3600:.2f} h)", flush=True)
    finally:
        log.close()
        for s, h in handlers.items():
            signal.signal(s, h)


if __name__ == "__main__":
    main()
