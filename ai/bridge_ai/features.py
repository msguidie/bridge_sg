"""Observation encoders.

``actor_obs`` uses only what the acting seat may know: its own hand plus the
public record (auction, contract, called card, every card played and the
circumstances of each play), with all seats relative to the acting seat
(index 0 = me, 1 = next to act, ...).  ``priv_obs`` adds the hidden truth for
the training-only critic.  Change anything here -> bump OBS_VERSION.
"""
from __future__ import annotations

import torch

from .engine import NUM_BIDS, PLAY, BridgeEnv, onehot

OBS_VERSION = 1
_HCP = (0, 0, 0, 0, 0, 0, 0, 0, 0, 1, 2, 3, 4)  # by rank index (2..A)


def rel(seat: torch.Tensor, cur: torch.Tensor) -> torch.Tensor:
    """Absolute seat(s) -> seat relative to ``cur`` (broadcastable); -1 stays -1."""
    return ((seat - cur) % 4).masked_fill(seat < 0, -1)


def rot(x: torch.Tensor, cur: torch.Tensor) -> torch.Tensor:
    """Reorder an absolute seat axis (dim 1) so that index j is the seat j places after ``cur``."""
    idx = (cur.unsqueeze(1) + torch.arange(4, device=x.device)) % 4
    idx = idx.view(x.shape[0], 4, *([1] * (x.dim() - 2))).expand_as(x)
    return x.gather(1, idx)


def _split_tricks(env: BridgeEnv) -> tuple[torch.Tensor, torch.Tensor]:
    """For every seat s taken as the Loyalist: (Lord + s tricks, tricks of the other two seats)."""
    t = env.tricks_won
    side = t.gather(1, env.lord.clamp(min=0).unsqueeze(1)) + t
    return side, t.sum(1, keepdim=True) - side


def loyalist_candidates(env: BridgeEnv) -> torch.Tensor:
    """[B,4] bool over ABSOLUTE seats: who can still be the Loyalist, by exact logic
    from the acting seat's knowledge only:

    * never the Lord; never me unless I hold (or held) the called card;
    * nobody who has shown out of the called card's suit;
    * proof by contradiction: the game is still running, so the true Loyalist L
      has Lord+L tricks < Lord target and the other two < Rebel target; a seat
      that would break either cannot be L (e.g. two seats whose tricks already
      add up to the Rebel target cannot both be Rebels);
    * once revealed (or if I am the Loyalist) it is exactly that seat.
    All-False outside the play phase."""
    play = env.phase == PLAY
    known = env.revealed | (env.loyalist == env.cur)
    cand = ~onehot(env.lord, 4) & ~onehot(env.cur, 4)
    suit = (env.called.clamp(min=0) // 13).view(-1, 1, 1).expand(-1, 4, 1)
    cand = cand & ~env.voids.gather(2, suit).squeeze(2)
    side, others = _split_tricks(env)
    cand = cand & (side < env.lord_target.unsqueeze(1)) & (others < env.rebel_target.unsqueeze(1))
    cand = torch.where(known.unsqueeze(1), onehot(env.loyalist, 4), cand)
    return cand & play.unsqueeze(1)


def actor_obs(env: BridgeEnv) -> torch.Tensor:
    """[B, OBS_DIM] float32 observation of the seat to act."""
    B, cur = env.B, env.cur
    cur1 = cur.unsqueeze(1)
    play = env.phase == PLAY
    own_b = env.hands[env.ar, cur]
    own = own_b.float()
    suits = own.view(B, 4, 13)
    hcp = suits * torch.tensor(_HCP, dtype=torch.float32, device=own.device)
    me_loyal = play & (env.loyalist == cur)
    known = play & (env.revealed | me_loyal)
    side, others = _split_tricks(env)
    not_lord = (~onehot(env.lord, 4) & play.unsqueeze(1)).float()
    needs = torch.stack([
        (env.lord_target.unsqueeze(1) - side).clamp(min=0),
        (env.rebel_target.unsqueeze(1) - others).clamp(min=0),
    ], 2).float() / 13 * not_lord.unsqueeze(2)
    pb = env.played_by
    played = (pb >= 0).float().unsqueeze(2)
    per_card = torch.cat([
        played,
        onehot(rel(pb, cur1), 4).float(),                               # who played it
        env.played_trick.clamp(min=0).float().unsqueeze(2) / 12 * played,
        onehot(env.played_pos, 4).float(),                              # position in its trick
        env.played_lead.float().unsqueeze(2),
        env.played_won.float().unsqueeze(2),
        env.played_overtook.float().unsqueeze(2),                       # beat the winning card
        env.played_ruff.float().unsqueeze(2),
        onehot(rel(env.played_prev, cur1), 4).float(),                  # whose card it had to beat
    ], 2)
    held_left = 13 - onehot(pb, 4).long().sum(1)
    parts = [
        own,                                                            # 52 my hand
        suits.sum(2) / 13,                                              # 4 suit lengths
        hcp.sum(2) / 10,                                                # 4 HCP per suit
        hcp.sum((1, 2)).unsqueeze(1) / 37,                              # 1 HCP
        onehot(env.phase.clamp(max=PLAY), 3).float(),                   # 3 phase
        onehot(rel(env.bid_by, cur1), 4).float().reshape(B, -1),        # 140 who made each bid
        rot(env.passed_on.transpose(1, 2), cur).float().reshape(B, -1),  # 140 who passed over it
        onehot(rel(env.first, cur), 4).float(),                         # 4 first bidder
        onehot(env.best_bid, NUM_BIDS).float(),                         # 35 standing bid
        (env.best_bid < 0).float().unsqueeze(1),                        # 1 no bid yet
        env.passes.float().unsqueeze(1) / 3,                            # 1 passes since
        onehot(env.level - 1, 7).float(),                               # 7 contract level
        onehot(env.strain, 5).float(),                                  # 5 strain
        onehot(rel(env.lord, cur), 4).float(),                          # 4 Lord
        torch.stack([env.lord_target, env.rebel_target], 1).float() / 13,  # 2 targets
        onehot(env.called, 52).float(),                                 # 52 called card
        me_loyal.float().unsqueeze(1),                                  # 1 I am the Loyalist
        env.revealed.float().unsqueeze(1),                              # 1 Loyalist revealed
        onehot(rel(env.loyalist, cur).masked_fill(~known, -1), 4).float(),  # 4 Loyalist, if I know
        per_card.reshape(B, -1),                                        # 52*18 play history
        onehot(rot(env.trick_cards, cur), 52).float().reshape(B, -1),   # 208 current trick by seat
        onehot(env.led_suit, 4).float(),                                # 4 led suit
        onehot(rel(env.win_seat, cur), 4).float(),                      # 4 winning so far
        rot(env.tricks_won, cur).float() / 13,                          # 4 tricks won
        rot(held_left, cur).float() / 13,                               # 4 cards left
        (env.trick_no.float() / 12).unsqueeze(1),                       # 1 trick number
        env.trump_broken.float().unsqueeze(1),                          # 1 trump broken
        rot(env.voids, cur).float().reshape(B, -1),                     # 16 known voids
        ((pb < 0) & ~own_b).float(),                                    # 52 unseen cards
        rot(loyalist_candidates(env), cur).float(),                     # 4 possible Loyalists
        rot(needs, cur).reshape(B, -1),                                 # 8 tricks still needed per hypothesis
    ]
    return torch.cat(parts, 1)


def priv_obs(env: BridgeEnv, opp_seats: torch.Tensor) -> torch.Tensor:
    """[B, PRIV_DIM] bool, critic only: all four hands, the true Loyalist, which seats a pool opponent plays."""
    cur = env.cur
    return torch.cat([
        rot(env.hands, cur).reshape(env.B, -1),
        onehot(rel(env.loyalist, cur), 4),
        rot(opp_seats, cur),
    ], 1)


def aux_targets(env: BridgeEnv) -> tuple[torch.Tensor, torch.Tensor]:
    """Holder (relative seat) of every card hidden from the acting seat, else -1 [B,52];
    the true Loyalist (relative seat) during play, else -1 [B]."""
    cur = env.cur
    hidden = env.hands.any(1) & ~env.hands[env.ar, cur]
    holder = ((env.hands.long().argmax(1) - cur.unsqueeze(1)) % 4).masked_fill(~hidden, -1)
    loyal = rel(env.loyalist, cur).masked_fill(env.phase != PLAY, -1)
    return holder, loyal


def _dims() -> tuple[int, int]:
    env = BridgeEnv(1)
    return actor_obs(env).shape[1], priv_obs(env, torch.zeros(1, 4, dtype=torch.bool)).shape[1]


OBS_DIM, PRIV_DIM = _dims()
