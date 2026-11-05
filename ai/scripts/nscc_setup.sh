#!/usr/bin/env bash
# One-time environment setup on NSCC ASPIRE 2A.  Run it on the LOGIN node
# (it is not a PBS job), from anywhere:
#
#     bash ai/scripts/nscc_setup.sh
#
# Creates a conda env on scratch ($HOME's quota is too small for torch),
# installs torch built for CUDA 12.8 (the cluster driver; the default PyPI
# wheel would silently fall back to CPU) and ai/requirements.txt.
# Safe to re-run: an existing env is reused.
set -eo pipefail

AI_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
SCRATCH="${SCRATCH:-$HOME/scratch}"
ENV_PREFIX="${ENV_PREFIX:-$SCRATCH/conda-envs/bridge_ai}"
PY_VERSION="${PY_VERSION:-3.11}"
TORCH_INDEX="${TORCH_INDEX:-https://download.pytorch.org/whl/cu128}"
export CONDA_PKGS_DIRS="${CONDA_PKGS_DIRS:-$SCRATCH/conda-pkgs}"
export PIP_CACHE_DIR="${PIP_CACHE_DIR:-$SCRATCH/pip-cache}"
export TMPDIR="${TMPDIR:-$SCRATCH/tmp}"
mkdir -p "$CONDA_PKGS_DIRS" "$PIP_CACHE_DIR" "$TMPDIR" "$(dirname "$ENV_PREFIX")"

if ! command -v module >/dev/null 2>&1; then
    for f in /etc/profile.d/modules.sh /usr/share/Modules/init/bash /opt/pbs/etc/profile.d/modules.sh; do
        [ -r "$f" ] && . "$f" && break
    done
fi
if command -v module >/dev/null 2>&1; then
    module load anaconda 2>/dev/null || module load anaconda3 2>/dev/null \
        || module load miniforge3 2>/dev/null || module load miniforge 2>/dev/null || true
fi
if ! command -v conda >/dev/null 2>&1; then
    echo "ERROR: no conda on PATH. Run 'module avail' and load the anaconda/miniforge module, then re-run." >&2
    exit 1
fi
. "$(conda info --base)/etc/profile.d/conda.sh"

if [ -x "$ENV_PREFIX/bin/python" ]; then
    echo "--- reusing $ENV_PREFIX"
else
    echo "--- creating $ENV_PREFIX (python $PY_VERSION)"
    conda create -y -p "$ENV_PREFIX" "python=$PY_VERSION"
fi
conda activate "$ENV_PREFIX"

python -m pip install --upgrade pip
python -m pip install torch --index-url "$TORCH_INDEX"
python -m pip install -r "$AI_DIR/requirements.txt"

cd "$AI_DIR"
python - <<'PY'
import torch
from bridge_ai.features import OBS_DIM, PRIV_DIM
print(f"torch {torch.__version__} (CUDA build {torch.version.cuda}); OBS_DIM {OBS_DIM}, PRIV_DIM {PRIV_DIM}")
print("cuda available here:", torch.cuda.is_available(), "(False is normal on a login node)")
PY
echo "--- ready: $ENV_PREFIX"
echo "next: cd $AI_DIR && qsub -P <project> scripts/nscc_smoke.pbs"
