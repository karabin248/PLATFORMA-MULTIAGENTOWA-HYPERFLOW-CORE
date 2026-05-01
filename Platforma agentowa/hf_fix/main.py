from __future__ import annotations

import importlib.util
import os
import sys
from pathlib import Path


def main() -> None:
    repo_root = Path(__file__).resolve().parent
    core_dir = repo_root / "artifacts" / "hyperflow-core"
    core_main = core_dir / "main.py"
    if not core_main.exists():
        raise RuntimeError(f"Hyperflow core entrypoint not found: {core_main}")

    # Load the core app by absolute file path to avoid shadowing this root main.py.
    sys.path.insert(0, str(core_dir))
    spec = importlib.util.spec_from_file_location("hyperflow_core_entrypoint", core_main)
    if spec is None or spec.loader is None:
        raise RuntimeError(f"Unable to load Hyperflow core entrypoint: {core_main}")
    module = importlib.util.module_from_spec(spec)
    sys.modules[spec.name] = module
    spec.loader.exec_module(module)
    app = module.app

    import uvicorn

    port = int(os.environ.get("PORT", "8000"))
    host = os.environ.get("HOST", "127.0.0.1")
    uvicorn.run(app, host=host, port=port, reload=False)


if __name__ == "__main__":
    main()
