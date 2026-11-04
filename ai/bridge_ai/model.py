"""Actor (imperfect information) and privileged critic: pre-LN residual MLPs."""
from __future__ import annotations

import contextlib
from pathlib import Path

import torch
import torch.nn as nn
import torch.nn.functional as F

from .engine import BID0, NUM_ACTIONS, NUM_BIDS, PASS
from .features import OBS_DIM, OBS_VERSION, PRIV_DIM


class Block(nn.Module):
    def __init__(self, width: int):
        super().__init__()
        self.norm = nn.LayerNorm(width)
        self.fc1 = nn.Linear(width, width)
        self.fc2 = nn.Linear(width, width)

    def forward(self, x: torch.Tensor) -> torch.Tensor:
        return x + self.fc2(F.gelu(self.fc1(self.norm(x))))


class Trunk(nn.Module):
    def __init__(self, inp: int, width: int, blocks: int):
        super().__init__()
        self.inp = nn.Linear(inp, width)
        self.blocks = nn.Sequential(*[Block(width) for _ in range(blocks)])
        self.norm = nn.LayerNorm(width)

    def forward(self, x: torch.Tensor) -> torch.Tensor:
        return self.norm(self.blocks(self.inp(x)))


class Actor(nn.Module):
    """Shared by all four seats; sees only features.actor_obs."""

    def __init__(self, width: int, blocks: int, pass_bias: float = 3.0, bid_slope: float = 0.3):
        super().__init__()
        self.trunk = Trunk(OBS_DIM, width, blocks)
        self.policy = nn.Linear(width, NUM_ACTIONS)
        self.belief = nn.Linear(width, 52 * 4)  # aux: which seat holds each hidden card
        self.loyal = nn.Linear(width, 4)        # aux: which seat is the Loyalist
        self.value = nn.Linear(width, 1)        # aux: imperfect-information value (for later search)
        with torch.no_grad():
            # Exploration prior only (learning overrides it): a fresh net passes
            # often and prefers low bids instead of racing to 7NT.
            self.policy.weight.mul_(0.01)
            self.policy.bias.zero_()
            self.policy.bias[PASS] = pass_bias
            levels = torch.arange(NUM_BIDS, dtype=torch.float32) // 5
            self.policy.bias[BID0:BID0 + NUM_BIDS] = -bid_slope * levels

    def policy_logits(self, obs: torch.Tensor) -> torch.Tensor:
        return self.policy(self.trunk(obs))

    def forward(self, obs: torch.Tensor):
        h = self.trunk(obs)
        return self.policy(h), self.belief(h).view(-1, 52, 4), self.loyal(h), self.value(h).squeeze(-1)


class Critic(nn.Module):
    """Training only: sees every hand; predicts the final reward of each seat (relative to the acting seat)."""

    def __init__(self, width: int, blocks: int):
        super().__init__()
        self.trunk = Trunk(OBS_DIM + PRIV_DIM, width, blocks)
        self.head = nn.Linear(width, 4)

    def forward(self, obs: torch.Tensor, priv: torch.Tensor) -> torch.Tensor:
        return self.head(self.trunk(torch.cat([obs, priv.to(obs.dtype)], -1)))


def sample(logits: torch.Tensor, mask: torch.Tensor, gen: torch.Generator | None = None,
           temperature: float = 1.0) -> tuple[torch.Tensor, torch.Tensor]:
    """One legal action per row (Gumbel-max; temperature <= 0 = greedy) and its log-prob at temperature 1."""
    masked = logits.float().masked_fill(~mask, -1e9)
    if temperature <= 0:
        action = masked.argmax(-1)
    else:
        u = torch.rand(masked.shape, generator=gen, device=masked.device).clamp_(1e-12, 1.0 - 1e-7)
        action = (masked / temperature - torch.log(-torch.log(u))).argmax(-1)
    logp = torch.log_softmax(masked, -1).gather(1, action.unsqueeze(1)).squeeze(1)
    return action, logp


def autocast(device: torch.device, enabled: bool):
    """bf16 autocast on CUDA, a no-op elsewhere."""
    if enabled and device.type == "cuda":
        return torch.autocast(device_type="cuda", dtype=torch.bfloat16)
    return contextlib.nullcontext()


def load_actor(path: str | Path, device: str | torch.device = "cpu") -> Actor:
    """Load an actor from a training checkpoint (latest.pt) or an export."""
    ck = torch.load(path, map_location="cpu", weights_only=False)
    if ck.get("obs_version") != OBS_VERSION:
        raise ValueError(f"{path}: obs_version {ck.get('obs_version')} != current {OBS_VERSION}")
    actor = Actor(ck["config"]["width"], ck["config"]["blocks"])
    actor.load_state_dict(ck["actor"])
    return actor.to(device).eval()
