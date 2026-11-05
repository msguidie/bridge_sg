"""Fixed opponents used only as evaluation anchors (never for training)."""
from __future__ import annotations

import torch

from .engine import AUCTION, BID0, CALL, CALL0, NT, PLAY, PLAY0, BridgeEnv
from .model import sample

_HCP = (0, 0, 0, 0, 0, 0, 0, 0, 0, 1, 2, 3, 4)


def random_actions(mask: torch.Tensor, gen: torch.Generator | None = None, pass_logit: float = 1.0) -> torch.Tensor:
    """Uniform over legal actions, passing somewhat more often in the auction."""
    logits = torch.zeros(mask.shape, device=mask.device)
    logits[:, 0] = pass_logit
    return sample(logits, mask, gen)[0]


def _best(score: torch.Tensor, ok: torch.Tensor) -> torch.Tensor:
    return score.float().masked_fill(~ok, -1e9).argmax(1)


def _known_partner(env: BridgeEnv) -> torch.Tensor:
    """Partner seat the acting player provably knows, else -1."""
    cur, lord, loy = env.cur, env.lord, env.loyalist
    none = torch.full_like(cur, -1)
    other_rebel = 6 - cur - lord - loy
    mate = torch.where(cur == loy, lord,
                       torch.where(cur == lord, torch.where(env.revealed, loy, none),
                                   torch.where(env.revealed, other_rebel, none)))
    return mate.masked_fill(env.phase != PLAY, -1)


def heuristic_actions(env: BridgeEnv, mask: torch.Tensor) -> torch.Tensor:
    """A simple rule-based player using only the acting seat's information."""
    B, dev = env.B, mask.device
    suit, rank = env.suit_of.unsqueeze(0), env.rank_of.unsqueeze(0)
    own = env.hands[env.ar, env.cur]
    by_suit = own.view(B, 4, 13).long()
    lens = by_suit.sum(2)
    hcp = (by_suit * torch.tensor(_HCP, device=dev)).sum((1, 2))

    # auction: points + length give a ceiling; bid the cheapest legal bid in the best strain
    longest = lens.argmax(1)
    max_len = lens.max(1).values
    ceiling = ((hcp + 2 * (max_len - 4).clamp(min=0) - 10) // 3 + 1).clamp(0, 7)
    balanced = (lens.min(1).values >= 2) & (max_len <= 4)
    strain = torch.where(balanced & (hcp >= 15), torch.full_like(longest, NT), longest)
    ks = strain.unsqueeze(1) + 5 * torch.arange(7, device=dev)
    ok = ks > env.best_bid.unsqueeze(1)
    lowest = ok.long().argmax(1)
    k_min = ks.gather(1, lowest.unsqueeze(1)).squeeze(1)
    bid = ok.any(1) & ((lowest + 1 <= ceiling) | (env.best_bid < 0))
    auction = torch.where(bid, BID0 + k_min, torch.zeros_like(k_min))

    # partner call: the highest trump not held (NT: the highest card not held)
    is_trump = suit == env.trump().unsqueeze(1)
    call = CALL0 + _best(rank * 4 + suit + 1000 * is_trump.long(), mask[:, CALL0:PLAY0])

    # play: lead the top of the longest side suit; follow cheaply when partner wins,
    # else win as cheaply as possible, else throw the lowest card
    legal = mask[:, PLAY0:]
    power = rank + 13 * (suit == env.led_suit.unsqueeze(1)).long() + 26 * is_trump.long()
    suit_len = lens.gather(1, env.suit_of.unsqueeze(0).expand(B, 52))
    lead_c = _best(100 * suit_len + rank - 10000 * is_trump.long(), legal)
    low_c = _best(-(rank + 50 * is_trump.long()), legal)
    beats = legal & (power > env.win_power.unsqueeze(1))
    beat_c = _best(-power, beats)
    mate = _known_partner(env)
    partner_wins = (mate >= 0) & (env.win_seat == mate)
    follow_c = torch.where(partner_wins | ~beats.any(1), low_c, beat_c)
    play = PLAY0 + torch.where(env.trick_len == 0, lead_c, follow_c)

    action = torch.where(env.phase == AUCTION, auction, torch.where(env.phase == CALL, call, play))
    return action.masked_fill(env.done, 0)
