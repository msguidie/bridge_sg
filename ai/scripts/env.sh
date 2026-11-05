# Sourced by the PBS jobs: activate the environment that nscc_setup.sh built.
ENV_PREFIX="${ENV_PREFIX:-$HOME/scratch/conda-envs/bridge_ai}"
if ! command -v module >/dev/null 2>&1; then
    for f in /etc/profile.d/modules.sh /usr/share/Modules/init/bash; do
        [ -r "$f" ] && . "$f" && break
    done
fi
if command -v module >/dev/null 2>&1; then
    # the CUDA runtime ships inside the torch wheel; only the host driver is needed
    module load anaconda 2>/dev/null || module load anaconda3 2>/dev/null \
        || module load miniforge3 2>/dev/null || true
fi
if command -v conda >/dev/null 2>&1; then
    . "$(conda info --base)/etc/profile.d/conda.sh"
    conda activate "$ENV_PREFIX" || { echo "cannot activate $ENV_PREFIX: run scripts/nscc_setup.sh first"; exit 1; }
fi
export OMP_NUM_THREADS="${OMP_NUM_THREADS:-4}"
export PYTHONUNBUFFERED=1
echo "python $(command -v python) | $(python -V 2>&1) | node $(hostname) | $(date -Is)"
nvidia-smi -L 2>/dev/null || true
