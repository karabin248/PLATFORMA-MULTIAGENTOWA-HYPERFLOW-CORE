# =============================================================================
# Hyperflow Python Core — FastAPI runtime on port 8000
# =============================================================================
# Single-stage image. Uses requirements-ci.txt (same file as the CI pipeline)
# so the runtime deps always match what we test against in CI.
# =============================================================================
FROM python:3.12-slim AS base

ENV PYTHONDONTWRITEBYTECODE=1 \
    PYTHONUNBUFFERED=1 \
    PIP_NO_CACHE_DIR=1 \
    PIP_DISABLE_PIP_VERSION_CHECK=1 \
    PORT=8000 \
    HOST=0.0.0.0

WORKDIR /app

# System deps:
#  - build-essential: some wheels (e.g. pydantic extensions) may need to compile
#  - curl: used by HEALTHCHECK below
RUN apt-get update \
    && apt-get install -y --no-install-recommends build-essential curl \
    && rm -rf /var/lib/apt/lists/*

# Install deps first for better layer caching (pip layer is reused when only
# source code changes, not requirements-ci.txt)
COPY artifacts/hyperflow-core/requirements-ci.txt ./requirements-ci.txt
RUN pip install --upgrade pip==25.0.1 setuptools==80.10.2 wheel==0.45.1 \
    && pip install -r requirements-ci.txt

# Copy the core package and install it editable — same sequence as CI,
# keeps behavior identical between CI and the image runtime.
COPY artifacts/hyperflow-core/ /app/
RUN pip install -e .

# /v1/health is the canonical health endpoint (see README + replit.md)
HEALTHCHECK --interval=30s --timeout=5s --start-period=20s --retries=3 \
    CMD curl -fsS "http://127.0.0.1:${PORT}/v1/health" || exit 1

EXPOSE 8000
# Run uvicorn directly instead of `python main.py` so Docker can forward
# SIGTERM/SIGINT properly and uvicorn logs go straight to stdout.
CMD ["sh", "-c", "uvicorn main:app --host ${HOST} --port ${PORT}"]
