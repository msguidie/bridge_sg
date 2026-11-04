"""The torch engine must agree with server/gameLogic.js at every step.

The fixture is produced by scripts/gen_js_fixtures.mjs from the real JS engine:
same deals, same actions -> same acting seat, same legal-action set, same result.
"""
import gzip
import json
from pathlib import Path

import torch

from bridge_ai.engine import BridgeEnv

FIXTURE = Path(__file__).parent / "fixtures" / "js_games.jsonl.gz"


def load_games() -> list[dict]:
    with gzip.open(FIXTURE, "rt") as f:
        return [json.loads(line) for line in f if line.strip()]


def test_engine_matches_js():
    games = load_games()
    n = len(games)
    hands = torch.zeros(n, 4, 52, dtype=torch.bool)
    for i, g in enumerate(games):
        for s, cards in enumerate(g["hands"]):
            hands[i, s, cards] = True
    env = BridgeEnv(n)
    env.set_deal(hands, torch.tensor([g["first"] for g in games]))
    for t in range(max(len(g["steps"]) for g in games)):
        mask = env.legal_mask()
        actions = torch.zeros(n, dtype=torch.long)
        for i, g in enumerate(games):
            if t >= len(g["steps"]):
                assert bool(env.done[i]), f"game {i}: JS ended after {len(g['steps'])} steps, engine did not"
                continue
            seat, action, legal = g["steps"][t]
            assert not bool(env.done[i]), f"game {i} step {t}: engine ended early"
            assert int(env.cur[i]) == seat, f"game {i} step {t}: seat {int(env.cur[i])} != JS {seat}"
            got = torch.nonzero(mask[i]).flatten().tolist()
            assert got == sorted(legal), f"game {i} step {t}: legal {got} != JS {sorted(legal)}"
            actions[i] = action
        env.step(actions)
    for i, g in enumerate(games):
        assert bool(env.done[i])
        assert env.tricks_won[i].tolist() == g["tricksWon"], f"game {i}"
        assert env.rewards[i].tolist() == [float(x) for x in g["ratingChanges"]], f"game {i}"
        assert int(env.lord[i]) == g["declarer"] and int(env.loyalist[i]) == g["partner"], f"game {i}"
        assert int(env.level[i]) == g["level"] and int(env.strain[i]) == g["strain"], f"game {i}"
