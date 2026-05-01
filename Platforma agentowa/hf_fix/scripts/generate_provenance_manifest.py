#!/usr/bin/env python3
from __future__ import annotations

import argparse
import hashlib
import json
import os
import subprocess
from datetime import datetime, timezone
from pathlib import Path
from typing import Any


def sha256_file(path: Path) -> str:
    h = hashlib.sha256()
    with path.open('rb') as f:
        for chunk in iter(lambda: f.read(1024 * 1024), b''):
            h.update(chunk)
    return h.hexdigest()


def try_git_rev() -> str | None:
    for env_key in ('GITHUB_SHA', 'CI_COMMIT_SHA'):
        value = os.environ.get(env_key)
        if value:
            return value
    try:
        return subprocess.check_output(['git', 'rev-parse', 'HEAD'], text=True, stderr=subprocess.DEVNULL).strip()
    except Exception:
        return None


def build_manifest(component: str, output_dir: Path) -> dict[str, Any]:
    lock_candidates = [
        Path('pnpm-lock.yaml'),
        Path('uv.lock'),
        Path('pyproject.toml'),
        Path('package.json'),
        Path('artifacts/hyperflow-core/pyproject.toml'),
        Path('artifacts/api-server/package.json'),
    ]
    locks = []
    for candidate in lock_candidates:
        if candidate.exists():
            locks.append({
                'path': candidate.as_posix(),
                'sha256': sha256_file(candidate),
            })

    subjects = []
    if output_dir.exists():
        for artifact in sorted(output_dir.rglob('*')):
            if artifact.is_file():
                subjects.append({
                    'path': artifact.relative_to(output_dir).as_posix(),
                    'sha256': sha256_file(artifact),
                    'size': artifact.stat().st_size,
                })

    return {
        'component': component,
        'generatedAt': datetime.now(timezone.utc).isoformat(),
        'revision': try_git_rev(),
        'ci': {
            'github_run_id': os.environ.get('GITHUB_RUN_ID'),
            'github_workflow': os.environ.get('GITHUB_WORKFLOW'),
            'gitlab_pipeline_id': os.environ.get('CI_PIPELINE_ID'),
            'gitlab_job_id': os.environ.get('CI_JOB_ID'),
        },
        'lockfiles': locks,
        'subjects': subjects,
    }


def main() -> None:
    parser = argparse.ArgumentParser()
    parser.add_argument('--component', required=True)
    parser.add_argument('--output-dir', required=True)
    parser.add_argument('--output-file', required=True)
    args = parser.parse_args()

    output_dir = Path(args.output_dir)
    output_file = Path(args.output_file)
    output_file.parent.mkdir(parents=True, exist_ok=True)
    manifest = build_manifest(args.component, output_dir)
    output_file.write_text(json.dumps(manifest, indent=2) + '\n')


if __name__ == '__main__':
    main()
