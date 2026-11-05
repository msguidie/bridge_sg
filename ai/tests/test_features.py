"""The actor must not see hidden cards; the Loyalist deduction must never exclude the truth."""
import torch

from bridge_ai.bots import random_actions
from bridge_ai.engine import PLAY, BridgeEnv
from bridge_ai.features import OBS_DIM, PRIV_DIM, actor_obs, loyalist_candidates, priv_obs


def _states():
    gen = torch.Generator().manual_seed(0)
    env = BridgeEnv(256, seed=1)
    for t in range(70):
        env.step(random_actions(env.legal_mask(), gen))
        if t % 7 == 3:
            yield env


def test_shapes():
    env = BridgeEnv(3)
    assert actor_obs(env).shape == (3, OBS_DIM)
    assert priv_obs(env, torch.zeros(3, 4, dtype=torch.bool)).shape == (3, PRIV_DIM)


def test_deduction_keeps_the_true_loyalist():
    for env in _states():
        live = (env.phase == PLAY) & ~env.done
        cand = loyalist_candidates(env)
        hit = cand.gather(1, env.loyalist.clamp(min=0).unsqueeze(1)).squeeze(1)
        assert bool((hit | ~live).all())


def test_actor_obs_ignores_hidden_cards():
    """Swapping the hands of two other seats (moving the hidden Loyalist with its card)
    must leave the acting seat's observation unchanged."""
    for env in _states():
        obs = actor_obs(env)
        for j, k in ((1, 2), (1, 3), (2, 3)):
            other = env.clone()
            a, b = (env.cur + j) % 4, (env.cur + k) % 4
            ha, hb = env.hands[env.ar, a], env.hands[env.ar, b]
            other.hands[env.ar, a] = hb
            other.hands[env.ar, b] = ha
            hidden = ~env.revealed
            loy = env.loyalist
            other.loyalist = torch.where(hidden & (loy == a), b, torch.where(hidden & (loy == b), a, loy))
            assert torch.equal(actor_obs(other), obs)
