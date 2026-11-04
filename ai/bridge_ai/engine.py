"""Vectorised, device-agnostic rules engine for Singaporean (floating) bridge.

A port of ``server/gameLogic.js`` (the source of truth) that runs B games at
once with torch tensors, so the same code serves CPU tests and GPU self-play:

* a random first bidder must open (no pass before the first bid); bids strictly
  increase; a player who passed may bid again; three consecutive passes end the
  auction and the highest bidder becomes the Lord;
* the Lord calls any card not in their own hand; its holder is the secret
  Loyalist (revealed when that card is played); the Lord leads trick 1;
* follow suit if possible; a trump may not be led until any trump has been
  played, unless the leader holds nothing but trumps (NT has no trump);
* the game stops as soon as the Lord side reaches 6+level tricks or the Rebels
  reach 8-level (after trick 13 the Rebels win); every player scores +1 / -1.

Action ids (140): 0 pass | 1..35 bid k=(level-1)*5+strain | 36..87 call card |
88..139 play card, with card = suit*13 + rank-2, suits 0C 1D 2H 3S, strain 4 NT.
A trick is resolved the moment its 4th card lands (the JS 1.5 s pause is UI).
"""
from __future__ import annotations

import torch
import torch.nn.functional as F

NUM_ACTIONS = 140
PASS, BID0, CALL0, PLAY0 = 0, 1, 36, 88
NUM_BIDS = 35
NT = 4
AUCTION, CALL, PLAY, OVER = 0, 1, 2, 3
RESULT_LEN = 18  # layout of BridgeEnv.result_sums, decoded by summarize()


def onehot(idx: torch.Tensor, n: int) -> torch.Tensor:
    """Bool one-hot over a new last axis; negative indices give an all-False row."""
    return F.one_hot(idx.clamp(0, n - 1), n).bool() & (idx >= 0).unsqueeze(-1)


class BridgeEnv:
    """B independent games. Every state tensor has leading dim B; seats are absolute 0..3."""

    FIELDS = (
        "hands", "phase", "cur", "first", "best_bid", "best_bidder", "passes",
        "bid_by", "passed_on", "lord", "level", "strain", "lord_target",
        "rebel_target", "called", "loyalist", "revealed", "reveal_trick",
        "trick_no", "trick_len", "leader", "led_suit", "win_seat", "win_power",
        "trick_cards", "tricks_won", "trump_broken", "voids", "played_by",
        "played_trick", "played_pos", "played_prev", "played_lead",
        "played_won", "played_overtook", "played_ruff", "done", "lord_win",
        "rewards", "n_actions", "n_auction",
    )
    hands: torch.Tensor            # [B,4,52] bool, cards still held
    phase: torch.Tensor            # [B] AUCTION / CALL / PLAY / OVER
    cur: torch.Tensor              # [B] seat to act
    first: torch.Tensor            # [B] first bidder
    best_bid: torch.Tensor         # [B] standing bid index 0..34, -1 none
    best_bidder: torch.Tensor      # [B]
    passes: torch.Tensor           # [B] consecutive passes
    bid_by: torch.Tensor           # [B,35] seat that made bid k, -1
    passed_on: torch.Tensor        # [B,35,4] bool: seat passed while bid k stood
    lord: torch.Tensor             # [B] -1 until the auction ends
    level: torch.Tensor            # [B] 1..7, 0 none
    strain: torch.Tensor           # [B] 0..4, -1 none
    lord_target: torch.Tensor      # [B] 6+level
    rebel_target: torch.Tensor     # [B] 8-level
    called: torch.Tensor           # [B] called card, -1
    loyalist: torch.Tensor         # [B] holder of the called card (hidden), -1
    revealed: torch.Tensor         # [B] bool: called card has been played
    reveal_trick: torch.Tensor     # [B] trick index of the reveal, -1
    trick_no: torch.Tensor         # [B] 0..12
    trick_len: torch.Tensor        # [B] cards in the current trick 0..3
    leader: torch.Tensor           # [B]
    led_suit: torch.Tensor         # [B] -1 before the lead
    win_seat: torch.Tensor         # [B] seat currently winning the trick, -1
    win_power: torch.Tensor        # [B] its power: rank + 13*led + 26*trump
    trick_cards: torch.Tensor      # [B,4] card played by each seat this trick, -1
    tricks_won: torch.Tensor       # [B,4]
    trump_broken: torch.Tensor     # [B] bool
    voids: torch.Tensor            # [B,4,4] bool: seat showed out of suit
    played_by: torch.Tensor        # [B,52] seat that played the card, -1
    played_trick: torch.Tensor     # [B,52] trick index, -1
    played_pos: torch.Tensor       # [B,52] position in its trick 0..3, -1
    played_prev: torch.Tensor      # [B,52] seat winning the trick just before it, -1
    played_lead: torch.Tensor      # [B,52] bool
    played_won: torch.Tensor       # [B,52] bool: took its trick
    played_overtook: torch.Tensor  # [B,52] bool: beat the card winning at that moment
    played_ruff: torch.Tensor      # [B,52] bool: trump on a non-trump lead
    done: torch.Tensor             # [B] bool
    lord_win: torch.Tensor         # [B] bool
    rewards: torch.Tensor          # [B,4] final +1/-1 (0 while running)
    n_actions: torch.Tensor        # [B]
    n_auction: torch.Tensor        # [B]

    def __init__(self, num_envs: int, device: str | torch.device = "cpu", seed: int = 0):
        self.B = num_envs
        self.device = torch.device(device)
        self.gen = torch.Generator(device=self.device)
        self.gen.manual_seed(seed)
        self.ar = torch.arange(num_envs, device=self.device)
        cards = torch.arange(52, device=self.device)
        self.suit_of = cards // 13
        self.rank_of = cards % 13
        for k, v in self._fresh(*self.deal(num_envs)).items():
            setattr(self, k, v)

    # ------------------------------------------------------------------ setup
    def _fresh(self, hands: torch.Tensor, first: torch.Tensor) -> dict[str, torch.Tensor]:
        B, dev = hands.shape[0], self.device

        def full(*shape: int, value: int = -1) -> torch.Tensor:
            return torch.full(shape, value, dtype=torch.long, device=dev)

        def no(*shape: int) -> torch.Tensor:
            return torch.zeros(shape, dtype=torch.bool, device=dev)

        first = first.to(dev).long()
        return {
            "hands": hands.to(dev).bool(),
            "phase": full(B, value=AUCTION),
            "cur": first.clone(),
            "first": first.clone(),
            "best_bid": full(B),
            "best_bidder": full(B),
            "passes": full(B, value=0),
            "bid_by": full(B, NUM_BIDS),
            "passed_on": no(B, NUM_BIDS, 4),
            "lord": full(B),
            "level": full(B, value=0),
            "strain": full(B),
            "lord_target": full(B, value=0),
            "rebel_target": full(B, value=0),
            "called": full(B),
            "loyalist": full(B),
            "revealed": no(B),
            "reveal_trick": full(B),
            "trick_no": full(B, value=0),
            "trick_len": full(B, value=0),
            "leader": full(B),
            "led_suit": full(B),
            "win_seat": full(B),
            "win_power": full(B),
            "trick_cards": full(B, 4),
            "tricks_won": full(B, 4, value=0),
            "trump_broken": no(B),
            "voids": no(B, 4, 4),
            "played_by": full(B, 52),
            "played_trick": full(B, 52),
            "played_pos": full(B, 52),
            "played_prev": full(B, 52),
            "played_lead": no(B, 52),
            "played_won": no(B, 52),
            "played_overtook": no(B, 52),
            "played_ruff": no(B, 52),
            "done": no(B),
            "lord_win": no(B),
            "rewards": torch.zeros(B, 4, device=dev),
            "n_actions": full(B, value=0),
            "n_auction": full(B, value=0),
        }

    def _reset(self, m: torch.Tensor, hands: torch.Tensor, first: torch.Tensor) -> None:
        for k, v in self._fresh(hands, first).items():
            setattr(self, k, torch.where(m.view(-1, *([1] * (v.dim() - 1))), v, getattr(self, k)))

    def deal(self, n: int) -> tuple[torch.Tensor, torch.Tensor]:
        """n random deals: hands [n,4,52] bool and a random first bidder [n]."""
        perm = torch.argsort(torch.rand(n, 52, generator=self.gen, device=self.device), dim=1)
        seat = (torch.arange(52, device=self.device) // 13).expand(n, 52)
        flat = torch.zeros(n, 4 * 52, dtype=torch.bool, device=self.device)
        flat.scatter_(1, seat * 52 + perm, torch.ones(n, 52, dtype=torch.bool, device=self.device))
        first = torch.randint(0, 4, (n,), generator=self.gen, device=self.device)
        return flat.view(n, 4, 52), first

    def reset_done(self) -> torch.Tensor:
        """Re-deal every finished game in place; returns the mask of re-dealt games."""
        m = self.done.clone()
        self._reset(m, *self.deal(self.B))
        return m

    def set_deal(self, hands: torch.Tensor, first: torch.Tensor) -> None:
        """Restart all B games from the given deals (duplicate play, tests)."""
        self._reset(torch.ones(self.B, dtype=torch.bool, device=self.device), hands, first)

    def clone(self) -> BridgeEnv:
        other = object.__new__(BridgeEnv)
        other.__dict__.update(self.__dict__)
        for k in self.FIELDS:
            setattr(other, k, getattr(self, k).clone())
        other.gen = torch.Generator(device=self.device)
        other.gen.set_state(self.gen.get_state())
        return other

    # ------------------------------------------------------------------ rules
    def trump(self) -> torch.Tensor:
        """Trump suit per game; -1 for NT or before the contract exists."""
        return self.strain.masked_fill(self.strain >= NT, -1)

    def legal_mask(self) -> torch.Tensor:
        """[B,140] bool. A finished game gets a dummy legal PASS so sampling never sees an empty row."""
        auc = self.phase == AUCTION
        bids = torch.arange(NUM_BIDS, device=self.device)
        m_pass = (auc & (self.best_bid >= 0)) | self.done
        m_bid = auc.unsqueeze(1) & (bids.unsqueeze(0) > self.best_bid.unsqueeze(1))
        own = self.hands[self.ar, self.cur]
        m_call = (self.phase == CALL).unsqueeze(1) & ~own
        trump_card = self.suit_of.unsqueeze(0) == self.trump().unsqueeze(1)
        non_trump = own & ~trump_card
        restrict = (self.trump() >= 0) & ~self.trump_broken & non_trump.any(1)
        lead_ok = torch.where(restrict.unsqueeze(1), non_trump, own)
        same = own & (self.suit_of.unsqueeze(0) == self.led_suit.unsqueeze(1))
        follow_ok = torch.where(same.any(1, keepdim=True), same, own)
        play_ok = torch.where((self.trick_len == 0).unsqueeze(1), lead_ok, follow_ok)
        m_play = (self.phase == PLAY).unsqueeze(1) & play_ok
        return torch.cat([m_pass.unsqueeze(1), m_bid, m_call, m_play], 1)

    def step(self, actions: torch.Tensor) -> tuple[torch.Tensor, torch.Tensor]:
        """Apply one (legal) action per game; finished games ignore theirs.

        Returns (rewards [B,4], non-zero only where a game just ended; ended [B] bool)."""
        a = actions.to(self.device).long()
        live = ~self.done
        auc = live & (self.phase == AUCTION)
        cal = live & (self.phase == CALL)
        ply = live & (self.phase == PLAY)
        cur = self.cur
        me = onehot(cur, 4)
        nxt = (cur + 1) % 4

        # ---- auction ----------------------------------------------------------
        is_pass = auc & (a == PASS)
        is_bid = auc & (a >= BID0) & (a < CALL0)
        k = (a - BID0).clamp(0, NUM_BIDS - 1)
        self.passed_on = self.passed_on | (
            onehot(self.best_bid, NUM_BIDS).unsqueeze(2) & me.unsqueeze(1) & is_pass.view(-1, 1, 1))
        self.bid_by = torch.where(onehot(k, NUM_BIDS) & is_bid.unsqueeze(1), cur.unsqueeze(1), self.bid_by)
        self.best_bid = torch.where(is_bid, k, self.best_bid)
        self.best_bidder = torch.where(is_bid, cur, self.best_bidder)
        self.passes = (self.passes + is_pass.long()).masked_fill(is_bid, 0)
        ended = is_pass & (self.passes >= 3)
        lvl = self.best_bid.clamp(min=0) // 5 + 1
        self.lord = torch.where(ended, self.best_bidder, self.lord)
        self.level = torch.where(ended, lvl, self.level)
        self.strain = torch.where(ended, self.best_bid.clamp(min=0) % 5, self.strain)
        self.lord_target = torch.where(ended, 6 + lvl, self.lord_target)
        self.rebel_target = torch.where(ended, 8 - lvl, self.rebel_target)
        self.phase = self.phase.masked_fill(ended, CALL)
        self.n_auction = self.n_auction + auc.long()
        new_cur = torch.where(auc, torch.where(ended, self.best_bidder, nxt), cur)

        # ---- partner call -------------------------------------------------------
        c_call = (a - CALL0).clamp(0, 51)
        holder = self.hands[self.ar, :, c_call].long().argmax(1)
        self.called = torch.where(cal, c_call, self.called)
        self.loyalist = torch.where(cal, holder, self.loyalist)
        self.leader = torch.where(cal, self.lord, self.leader)
        self.phase = self.phase.masked_fill(cal, PLAY)
        new_cur = torch.where(cal, self.lord, new_cur)

        # ---- card play ------------------------------------------------------------
        c = (a - PLAY0).clamp(0, 51)
        suit, rank = self.suit_of[c], self.rank_of[c]
        trump = self.trump()
        lead = ply & (self.trick_len == 0)
        led = torch.where(lead, suit, self.led_suit)
        is_trump = (trump >= 0) & (suit == trump)
        power = rank + 13 * (suit == led).long() + 26 * is_trump.long()
        follow = ply & ~lead
        off = follow & (suit != led)
        over = follow & (power > self.win_power)
        take = lead | over
        card = onehot(c, 52) & ply.unsqueeze(1)
        self.hands = self.hands & ~(me.unsqueeze(2) & card.unsqueeze(1))
        self.voids = self.voids | (me.unsqueeze(2) & onehot(led, 4).unsqueeze(1) & off.view(-1, 1, 1))
        self.played_by = torch.where(card, cur.unsqueeze(1), self.played_by)
        self.played_trick = torch.where(card, self.trick_no.unsqueeze(1), self.played_trick)
        self.played_pos = torch.where(card, self.trick_len.unsqueeze(1), self.played_pos)
        self.played_prev = torch.where(card, self.win_seat.unsqueeze(1), self.played_prev)
        self.played_lead = self.played_lead | (card & lead.unsqueeze(1))
        self.played_overtook = self.played_overtook | (card & over.unsqueeze(1))
        self.played_ruff = self.played_ruff | (card & (off & is_trump).unsqueeze(1))
        self.trick_cards = torch.where(me & ply.unsqueeze(1), c.unsqueeze(1), self.trick_cards)
        self.trump_broken = self.trump_broken | (ply & is_trump)
        shown = ply & (c == self.called)
        self.revealed = self.revealed | shown
        self.reveal_trick = torch.where(shown, self.trick_no, self.reveal_trick)
        self.win_seat = torch.where(take, cur, self.win_seat)
        self.win_power = torch.where(take, power, self.win_power)
        self.led_suit = led
        count = self.trick_len + ply.long()
        full = ply & (count == 4)
        new_cur = torch.where(ply & ~full, nxt, new_cur)

        # ---- trick resolution ---------------------------------------------------
        w = self.win_seat
        self.tricks_won = self.tricks_won + (onehot(w, 4) & full.unsqueeze(1)).long()
        win_card = self.trick_cards.gather(1, w.clamp(min=0).unsqueeze(1)).squeeze(1)
        self.played_won = self.played_won | (onehot(win_card, 52) & full.unsqueeze(1))
        side = onehot(self.lord, 4) | onehot(self.loyalist, 4)
        lord_tricks = (self.tricks_won * side.long()).sum(1)
        rebel_tricks = self.tricks_won.sum(1) - lord_tricks
        lord_won = full & (lord_tricks >= self.lord_target)
        rebel_won = full & ~lord_won & ((rebel_tricks >= self.rebel_target) | (self.trick_no >= 12))
        fin = lord_won | rebel_won
        go_on = full & ~fin
        self.trick_no = self.trick_no + go_on.long()
        self.trick_len = count.masked_fill(full, 0)
        self.leader = torch.where(go_on, w, self.leader)
        new_cur = torch.where(go_on, w, new_cur)
        self.led_suit = self.led_suit.masked_fill(full, -1)
        self.win_seat = self.win_seat.masked_fill(full, -1)
        self.win_power = self.win_power.masked_fill(full, -1)
        self.trick_cards = self.trick_cards.masked_fill(full.unsqueeze(1), -1)

        # ---- game end -------------------------------------------------------------
        sign = (side.float() * 2 - 1) * (lord_won.float() * 2 - 1).unsqueeze(1)
        self.rewards = torch.where(fin.unsqueeze(1), sign, self.rewards)
        self.lord_win = self.lord_win | lord_won
        self.done = self.done | fin
        self.phase = self.phase.masked_fill(fin, OVER)
        self.n_actions = self.n_actions + live.long()
        self.cur = new_cur
        return sign * fin.unsqueeze(1).float(), fin

    # ---------------------------------------------------------------- logging
    def result_sums(self, ended: torch.Tensor) -> torch.Tensor:
        """Sums over the games that just ended (fixed layout, decoded by summarize)."""
        f = ended.float()
        shown = ((self.reveal_trick >= 0) & ended).float()
        return torch.cat([
            f.sum().view(1),
            (self.lord_win.float() * f).sum().view(1),
            (onehot(self.level - 1, 7).float() * f.unsqueeze(1)).sum(0),
            (onehot(self.strain, 5).float() * f.unsqueeze(1)).sum(0),
            (self.n_auction.float() * f).sum().view(1),
            (self.n_actions.float() * f).sum().view(1),
            shown.sum().view(1),
            ((self.reveal_trick + 1).float() * shown).sum().view(1),
        ])


def summarize(sums: torch.Tensor) -> dict:
    s = [float(x) for x in sums.tolist()]
    n = max(s[0], 1.0)
    levels, strains = s[2:9], s[9:14]
    return {
        "games": s[0],
        "lord_win": s[1] / n,
        "level": sum((i + 1) * x for i, x in enumerate(levels)) / n,
        "level_hist": [round(x / n, 4) for x in levels],
        "strain_hist": [round(x / n, 4) for x in strains],
        "auction_len": s[14] / n,
        "game_len": s[15] / n,
        "revealed": s[16] / n,
        "reveal_trick": s[17] / max(s[16], 1.0),
    }
