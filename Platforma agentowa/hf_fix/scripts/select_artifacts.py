#!/usr/bin/env python3
from __future__ import annotations

import argparse
import json
from pathlib import Path


def load_manifests(artifacts_dir: Path):
    manifests = []
    for manifest_path in sorted(artifacts_dir.glob('*/artifact.manifest.json')):
        with manifest_path.open('r', encoding='utf-8') as f:
            data = json.load(f)
        manifests.append((manifest_path.parent.name, data))
    return manifests


def main() -> int:
    parser = argparse.ArgumentParser(description='Select artifact targets from artifact manifests.')
    parser.add_argument('--artifacts-dir', default='artifacts')
    parser.add_argument('--deployable-only', action='store_true')
    parser.add_argument('--runtime', choices=['node', 'python'])
    parser.add_argument('--format', choices=['json', 'lines'], default='json')
    args = parser.parse_args()

    manifests = load_manifests(Path(args.artifacts_dir))
    selected = []
    for name, manifest in manifests:
        if args.deployable_only and not manifest.get('deployable', False):
            continue
        if args.runtime and manifest.get('runtime') != args.runtime:
            continue
        selected.append({
            'name': name,
            'path': f"artifacts/{name}",
            **manifest,
        })

    if args.format == 'lines':
        for item in selected:
            print(item['name'])
    else:
        print(json.dumps(selected))
    return 0


if __name__ == '__main__':
    raise SystemExit(main())
