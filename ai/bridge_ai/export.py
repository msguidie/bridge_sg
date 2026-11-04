"""Write the actor of a run for deployment (fp32 weights + model config + OBS_VERSION).

    python -m bridge_ai.export --run runs/base [--out exports/actor_base.pt]

Load it with bridge_ai.model.load_actor; observations must come from the same
features.py (checked through OBS_VERSION).
"""
from __future__ import annotations

import argparse
from pathlib import Path

import torch


def export(ckpt: Path, out: Path) -> None:
    ck = torch.load(ckpt, map_location="cpu", weights_only=False)
    out.parent.mkdir(parents=True, exist_ok=True)
    torch.save({
        "obs_version": ck["obs_version"],
        "config": {"width": ck["config"]["width"], "blocks": ck["config"]["blocks"]},
        "actor": {k: v.float() for k, v in ck["actor"].items()},
        "source": str(ckpt),
        "iteration": ck.get("state", {}).get("iteration"),
    }, out)


def main(argv: list[str] | None = None) -> None:
    ap = argparse.ArgumentParser(description=__doc__, formatter_class=argparse.RawDescriptionHelpFormatter)
    ap.add_argument("--run", required=True)
    ap.add_argument("--out", default="")
    args = ap.parse_args(argv)
    run = Path(args.run)
    out = Path(args.out) if args.out else Path("exports") / f"actor_{run.name}.pt"
    export(run / "latest.pt", out)
    print(f"wrote {out}")


if __name__ == "__main__":
    main()
