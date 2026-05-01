import os

# Test suite runs in explicit local-dev mode unless individual tests override it.
os.environ.setdefault("HYPERFLOW_LOCAL_DEV_MODE", "true")
