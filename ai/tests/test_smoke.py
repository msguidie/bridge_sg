"""End to end on CPU: train, resume, export, duplicate arena."""
import torch

from bridge_ai import arena, export, train
from bridge_ai.model import load_actor


def test_train_resume_export_arena(tmp_path):
    run = tmp_path / "run"
    train.main(["--preset", "smoke", "--run-dir", str(run), "--set", "device=cpu"])
    ck = torch.load(run / "latest.pt", map_location="cpu", weights_only=False)
    assert ck["state"]["iteration"] == 2
    train.main(["--preset", "smoke", "--run-dir", str(run), "--set", "max_iters=3"])
    ck = torch.load(run / "latest.pt", map_location="cpu", weights_only=False)
    assert ck["state"]["iteration"] == 3
    assert (run / "metrics.jsonl").read_text().count('"type": "train"') == 3
    assert list((run / "snapshots").glob("actor_*.pt"))

    out = tmp_path / "actor.pt"
    export.export(run / "latest.pt", out)
    me = arena.NetPolicy(load_actor(out), amp=False)
    cpu = torch.device("cpu")
    r1 = arena.duplicate(me, arena.HeuristicPolicy(), "1+3", 8, cpu)
    r2 = arena.duplicate(me, arena.RandomPolicy(), "2+2", 8, cpu)
    assert -1.0 <= r1["score"] <= 1.0 and -1.0 <= r2["score"] <= 1.0
