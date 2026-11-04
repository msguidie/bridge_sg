"""Training configuration: one dataclass, named presets, ``--set key=value`` overrides."""
from __future__ import annotations

from dataclasses import dataclass, replace
from typing import Any


@dataclass
class Config:
    seed: int = 1
    device: str = "auto"            # auto | cuda | cpu
    train_hours: float = 23.3       # wall-clock budget, summed over resumed sessions
    max_iters: int = 0              # > 0: also stop after this many iterations
    num_envs: int = 4096            # games running in parallel on one GPU
    rollout_len: int = 64           # steps per game slot per iteration
    width: int = 1024
    blocks: int = 4
    pass_bias: float = 3.0          # initial policy prior (exploration only)
    bid_slope: float = 0.3
    lr: float = 3e-4
    lr_final_frac: float = 0.1      # linear decay to lr * this at the end of train_hours
    epochs: int = 2
    minibatch: int = 32768
    clip: float = 0.2
    lam: float = 0.95               # GAE lambda per global step; gamma = 1
    ent_start: float = 0.01
    ent_end: float = 0.003
    vf_coef: float = 1.0
    aux_coef: float = 0.1
    max_grad_norm: float = 1.0
    amp: bool = True                # bf16 autocast on CUDA
    pool_frac: float = 0.2          # share of games where 1-2 seats are a past snapshot
    pool_size: int = 24             # newest snapshots eligible as opponents
    snapshot_every_min: float = 20.0
    ckpt_every_min: float = 20.0
    arena_every_min: float = 60.0
    arena_deals: int = 2048
    log_every: int = 10


PRESETS: dict[str, dict[str, Any]] = {
    # the four variants of the 4-GPU run (one per GPU)
    "base": {},
    "wide": {"width": 1536, "blocks": 5, "seed": 2},
    "explore": {"ent_start": 0.02, "ent_end": 0.005, "pool_frac": 0.3, "seed": 3},
    "lam98": {"lam": 0.98, "lr": 2e-4, "epochs": 3, "seed": 4},
    # seconds on a CPU, used by the tests
    "smoke": {
        "num_envs": 32, "rollout_len": 16, "width": 64, "blocks": 1, "minibatch": 256,
        "epochs": 1, "amp": False, "max_iters": 2, "snapshot_every_min": 0.0,
        "ckpt_every_min": 0.0, "arena_every_min": 0.0, "arena_deals": 8, "log_every": 1,
    },
}


def make_config(preset: str) -> Config:
    if preset not in PRESETS:
        raise SystemExit(f"unknown preset {preset!r}; choose from {sorted(PRESETS)}")
    return replace(Config(), **PRESETS[preset])


def apply_overrides(cfg: Config, sets: list[str]) -> Config:
    changes: dict[str, Any] = {}
    for item in sets:
        key, _, raw = item.partition("=")
        if not hasattr(cfg, key):
            raise SystemExit(f"unknown config key {key!r}")
        old = getattr(cfg, key)
        if isinstance(old, bool):
            changes[key] = raw.lower() in ("1", "true", "yes", "on")
        elif isinstance(old, int):
            changes[key] = int(raw)
        elif isinstance(old, float):
            changes[key] = float(raw)
        else:
            changes[key] = raw
    return replace(cfg, **changes)
