"""Duplicate evaluation: the same deals replayed with the contestants rotated through the seats.

    python -m bridge_ai.arena --runs runs/base runs/wide runs/explore runs/lam98 \
        [--deals 8192] [--out runs/eval.json] [--export-dir exports]

Scores are a contestant's mean reward per seat (+1 win / -1 loss) with a 95%
interval over deals: "1+3" puts it in one seat (all 4 rotations), "2+2" in two
seats (all 6 pairs).  Zero-sum, so 0 means equal strength.
"""
from __future__ import annotations

import argparse
import itertools
import json
import math
from pathlib import Path

import torch

from . import bots
from .engine import BridgeEnv
from .features import actor_obs
from .model import Actor, autocast, load_actor, sample


class NetPolicy:
    def __init__(self, actor: Actor, temperature: float = 1.0, amp: bool = True):
        self.actor, self.temperature, self.amp = actor, temperature, amp

    def __call__(self, env: BridgeEnv, obs: torch.Tensor, mask: torch.Tensor, gen: torch.Generator) -> torch.Tensor:
        with autocast(obs.device, self.amp):
            logits = self.actor.policy_logits(obs)
        return sample(logits, mask, gen, self.temperature)[0]


class HeuristicPolicy:
    def __call__(self, env: BridgeEnv, obs: torch.Tensor, mask: torch.Tensor, gen: torch.Generator) -> torch.Tensor:
        return bots.heuristic_actions(env, mask)


class RandomPolicy:
    def __call__(self, env: BridgeEnv, obs: torch.Tensor, mask: torch.Tensor, gen: torch.Generator) -> torch.Tensor:
        return bots.random_actions(mask, gen)


@torch.no_grad()
def play(policies: list, seating: list[int], hands: torch.Tensor, first: torch.Tensor,
         device: torch.device, seed: int) -> torch.Tensor:
    """Play every deal once, seat s controlled by policies[seating[s]]; returns final rewards [n,4]."""
    n = hands.shape[0]
    env = BridgeEnv(n, device, seed)
    env.set_deal(hands, first)
    gen = torch.Generator(device=device)
    gen.manual_seed(seed)
    owner = torch.tensor(seating, device=device)
    while not bool(env.done.all()):
        obs, mask = actor_obs(env), env.legal_mask()
        who = owner[env.cur]
        action = torch.zeros(n, dtype=torch.long, device=device)
        for i, pol in enumerate(policies):
            if bool((who == i).any()):
                action = torch.where(who == i, pol(env, obs, mask, gen), action)
        env.step(action)
    return env.rewards


def duplicate(a, b, mode: str, deals: int, device: torch.device, seed: int = 0, batch: int = 8192) -> dict:
    """Mean reward per seat of policy ``a`` against ``b``, mode "1+3" or "2+2"."""
    groups = [(k,) for k in range(4)] if mode == "1+3" else list(itertools.combinations(range(4), 2))
    dealer = BridgeEnv(1, device, seed)
    scores = []
    for start in range(0, deals, batch):
        n = min(batch, deals - start)
        hands, first = dealer.deal(n)
        per_deal = torch.zeros(n, device=device)
        for j, g in enumerate(groups):
            seating = [0 if s in g else 1 for s in range(4)]
            rewards = play([a, b], seating, hands, first, device, seed + 1000 * start + j)
            per_deal += rewards[:, list(g)].mean(1)
        scores.append(per_deal / len(groups))
    s = torch.cat(scores)
    ci = 1.96 * float(s.std()) / math.sqrt(len(s)) if len(s) > 1 else 0.0
    return {"score": float(s.mean()), "ci95": ci, "deals": len(s)}


def main(argv: list[str] | None = None) -> None:
    ap = argparse.ArgumentParser(description=__doc__, formatter_class=argparse.RawDescriptionHelpFormatter)
    ap.add_argument("--runs", nargs="+", required=True, help="run directories containing latest.pt")
    ap.add_argument("--deals", type=int, default=8192)
    ap.add_argument("--device", default="auto")
    ap.add_argument("--temperature", type=float, default=1.0)
    ap.add_argument("--out", default="runs/eval.json")
    ap.add_argument("--export-dir", default="", help="also export every actor and the best one here")
    args = ap.parse_args(argv)
    device = torch.device(("cuda" if torch.cuda.is_available() else "cpu") if args.device == "auto" else args.device)
    runs = {Path(r).name: Path(r) / "latest.pt" for r in args.runs if (Path(r) / "latest.pt").exists()}
    if not runs:
        raise SystemExit("no <run>/latest.pt found")
    pols = {k: NetPolicy(load_actor(p, device), args.temperature) for k, p in runs.items()}
    table: dict[str, dict[str, dict]] = {k: {} for k in pols}
    for k, p in pols.items():
        table[k]["heuristic"] = duplicate(p, HeuristicPolicy(), "1+3", args.deals, device, seed=1)
        print(f"{k:>10} vs heuristic (1+3): {table[k]['heuristic']['score']:+.4f} ± {table[k]['heuristic']['ci95']:.4f}", flush=True)
    for x, y in itertools.combinations(pols, 2):
        r = duplicate(pols[x], pols[y], "2+2", args.deals, device, seed=2)
        table[x][y], table[y][x] = r, {**r, "score": -r["score"]}
        print(f"{x:>10} vs {y:<10} (2+2): {r['score']:+.4f} ± {r['ci95']:.4f}", flush=True)

    def strength(k: str) -> tuple[float, float]:
        rr = [v["score"] for o, v in table[k].items() if o != "heuristic"]
        return (sum(rr) / len(rr) if rr else 0.0, table[k]["heuristic"]["score"])

    best = max(table, key=strength)
    print(f"best: {best}  (mean round-robin score {strength(best)[0]:+.4f})", flush=True)
    out = Path(args.out)
    out.parent.mkdir(parents=True, exist_ok=True)
    out.write_text(json.dumps({"best": best, "deals": args.deals, "table": table}, indent=2))
    if args.export_dir:
        from .export import export
        folder = Path(args.export_dir)
        for k, p in runs.items():
            export(p, folder / f"actor_{k}.pt")
        export(runs[best], folder / "actor_best.pt")
        print(f"exported to {folder}/", flush=True)


if __name__ == "__main__":
    main()
