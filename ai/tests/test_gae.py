"""Vectorised 4-channel GAE == the lambda-return definition computed one scalar at a time."""
import torch

from bridge_ai.ppo import gae, to_abs, to_rel


def naive_lambda_returns(value, reward, done, lam):
    T, B, S = reward.shape
    ret = torch.zeros(T, B, S)
    for b in range(B):
        for s in range(S):
            g = float(value[T, b, s])
            for t in range(T - 1, -1, -1):
                if bool(done[t, b]):
                    g = float(reward[t, b, s])
                else:
                    g = float(reward[t, b, s]) + (1 - lam) * float(value[t + 1, b, s]) + lam * g
                ret[t, b, s] = g
    return ret


def test_gae_matches_lambda_returns():
    torch.manual_seed(0)
    T, B, lam = 12, 5, 0.9
    value = torch.randn(T + 1, B, 4)
    done = torch.rand(T, B) < 0.2
    reward = torch.randn(T, B, 4) * done.unsqueeze(-1)
    adv, ret = gae(value, reward, done, lam)
    expect = naive_lambda_returns(value, reward, done, lam)
    assert torch.allclose(ret, expect, atol=1e-5)
    assert torch.allclose(adv, expect - value[:T], atol=1e-5)


def test_seat_frames():
    cur = torch.tensor([0, 1, 2, 3])
    v_abs = torch.arange(16.0).view(4, 4)
    assert torch.equal(to_abs(to_rel(v_abs, cur), cur), v_abs)
    assert torch.equal(to_rel(v_abs, cur)[:, 0], v_abs[torch.arange(4), cur])
