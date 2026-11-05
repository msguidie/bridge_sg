"""Latest training and arena numbers of each run (reads metrics.jsonl only, no torch).

    python -m bridge_ai.report [runs ...]
"""
from __future__ import annotations

import argparse
import json
from pathlib import Path


def fmt_train(r: dict) -> str:
    return (f"it {r['it']} | {r['hours']:.2f}h {100 * r['progress']:.1f}% | "
            f"{r['env_steps'] / 1e6:.1f}M steps {r['sps'] / 1e3:.0f}k/s | "
            f"lord {r['lord_win']:.3f} lvl {r['level']:.2f} auc {r['auction_len']:.1f} len {r['game_len']:.1f} | "
            f"ent {r['ent_auction']:.2f}/{r['ent_call']:.2f}/{r['ent_play']:.2f} "
            f"kl {r['kl']:.4f} clip {r['clipfrac']:.3f} ev {r['ev']:.3f} | "
            f"loyal {r['loyal_acc']:.3f}/{r['loyal_base']:.3f} belief {r['belief_acc']:.3f}")


def fmt_arena(r: dict) -> str:
    parts = [f"arena {r['hours']:.2f}h"]
    parts += [f"{k} {v['score']:+.3f}±{v['ci95']:.3f}" for k, v in r.items() if isinstance(v, dict)]
    return " | ".join(parts)


def main(argv: list[str] | None = None) -> None:
    ap = argparse.ArgumentParser(description=__doc__, formatter_class=argparse.RawDescriptionHelpFormatter)
    ap.add_argument("paths", nargs="*", default=["runs"])
    args = ap.parse_args(argv)
    runs: list[Path] = []
    for p in map(Path, args.paths):
        runs += [p] if (p / "metrics.jsonl").exists() else sorted(q.parent for q in p.glob("*/metrics.jsonl"))
    for run in runs:
        last: dict[str, dict] = {}
        for line in (run / "metrics.jsonl").read_text().splitlines():
            try:
                rec = json.loads(line)
            except ValueError:
                continue  # a line cut off by a kill
            last[rec.get("type", "")] = rec
        print(f"== {run}")
        if "train" in last:
            print("   " + fmt_train(last["train"]))
        if "arena" in last:
            print("   " + fmt_arena(last["arena"]))


if __name__ == "__main__":
    main()
