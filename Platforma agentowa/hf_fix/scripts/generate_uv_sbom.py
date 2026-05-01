#!/usr/bin/env python3
from __future__ import annotations
import argparse, hashlib, json, tomllib
from pathlib import Path
from datetime import datetime, timezone


def sha256_bytes(data: bytes) -> str:
    return hashlib.sha256(data).hexdigest()


def _packages_from_uv_lock(lock_path: Path) -> tuple[list[dict], bytes, str]:
    data = tomllib.loads(lock_path.read_text())
    packages = []
    for pkg in data.get("package", []):
        name = pkg.get("name")
        version = pkg.get("version")
        if name and version:
            packages.append({"name": name, "version": version, "dependencies": pkg.get("dependencies", [])})
    return packages, lock_path.read_bytes(), "uv.lock"


def _packages_from_pip_list(pip_list_path: Path) -> tuple[list[dict], bytes, str]:
    raw = pip_list_path.read_bytes()
    data = json.loads(raw.decode("utf-8"))
    packages = [
        {"name": pkg.get("name"), "version": pkg.get("version"), "dependencies": []}
        for pkg in data
        if pkg.get("name") and pkg.get("version")
    ]
    return packages, raw, "pip-list"


def main() -> None:
    parser = argparse.ArgumentParser(description="Generate a CycloneDX JSON SBOM from uv.lock or installed pip packages")
    source = parser.add_mutually_exclusive_group(required=True)
    source.add_argument("--lock", help="Path to uv.lock")
    source.add_argument("--pip-list-json", help="Path to `pip list --format=json` output")
    parser.add_argument("--component", required=True, help="Top-level component name")
    parser.add_argument("--output", required=True, help="Output JSON file")
    args = parser.parse_args()

    if args.pip_list_json:
        packages, source_bytes, source_name = _packages_from_pip_list(Path(args.pip_list_json))
    else:
        packages, source_bytes, source_name = _packages_from_uv_lock(Path(args.lock))

    components = []
    dependencies = []
    for pkg in packages:
        name = pkg.get("name")
        version = pkg.get("version")
        if not name or not version:
            continue
        bom_ref = f"pkg:pypi/{name}@{version}"
        components.append({
            "type": "library",
            "bom-ref": bom_ref,
            "name": name,
            "version": version,
            "purl": bom_ref,
        })
        deps = []
        for dep in pkg.get("dependencies", []):
            dep_name = dep.get("name") if isinstance(dep, dict) else None
            if dep_name:
                deps.append(dep_name)
        dependencies.append({
            "ref": bom_ref,
            "dependsOn": sorted({f"pkg:pypi/{dep}@unknown" for dep in deps}),
        })

    document = {
        "bomFormat": "CycloneDX",
        "specVersion": "1.5",
        "serialNumber": f"urn:uuid:{sha256_bytes(source_bytes)[:32]}",
        "version": 1,
        "metadata": {
            "timestamp": datetime.now(timezone.utc).isoformat(),
            "component": {
                "type": "application",
                "name": args.component,
                "version": source_name,
            },
            "tools": [{
                "vendor": "OpenAI",
                "name": "generate_uv_sbom.py",
                "version": "2",
            }],
        },
        "components": components,
        "dependencies": dependencies,
    }

    out = Path(args.output)
    out.parent.mkdir(parents=True, exist_ok=True)
    out.write_text(json.dumps(document, indent=2) + "\n")


if __name__ == "__main__":
    main()
