"""
Export JSON schemas for all Hyperflow contract models.

Usage:
    python export_schemas.py [output_dir]

If output_dir is omitted, schemas are written to ./schemas/.
Each model gets its own <ModelName>.json file (JSON Schema draft 2020-12).
An index.json is also written listing all exported schema filenames.
"""

from __future__ import annotations

import json
import sys
from pathlib import Path

from models import (
    AgentDefinition,
    CheckpointRecord,
    DashboardSummary,
    LogEvent,
    RepositoryDefinition,
    ResponseMeta,
    RunNodeStatus,
    RunStatus,
    RunSummary,
    WorkflowDefinition,
    WorkflowStep,
)

MODELS = [
    AgentDefinition,
    WorkflowDefinition,
    RepositoryDefinition,
    RunStatus,
    RunSummary,
    RunNodeStatus,
    LogEvent,
    CheckpointRecord,
    DashboardSummary,
    ResponseMeta,
    WorkflowStep,
]


def export_schemas(output_dir: Path) -> None:
    output_dir.mkdir(parents=True, exist_ok=True)
    exported: list[str] = []

    for model in MODELS:
        schema = model.model_json_schema()
        filename = f"{model.__name__}.json"
        out_path = output_dir / filename
        out_path.write_text(json.dumps(schema, indent=2))
        exported.append(filename)
        print(f"  Wrote {out_path}")

    index = {"version": "1.0.0", "schemas": exported}
    index_path = output_dir / "index.json"
    index_path.write_text(json.dumps(index, indent=2))
    print(f"  Wrote {index_path}")
    print(f"\nExported {len(exported)} schemas to {output_dir}/")


if __name__ == "__main__":
    output = Path(sys.argv[1]) if len(sys.argv) > 1 else Path("schemas")
    export_schemas(output)
