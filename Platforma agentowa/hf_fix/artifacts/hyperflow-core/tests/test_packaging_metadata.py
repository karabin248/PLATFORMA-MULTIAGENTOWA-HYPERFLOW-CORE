from __future__ import annotations

import tomllib
from pathlib import Path

import hyperflow

CORE_ROOT = Path(__file__).resolve().parents[1]


def test_pyproject_build_backend_is_correct() -> None:
    data = tomllib.loads((CORE_ROOT / "pyproject.toml").read_text(encoding="utf-8"))
    assert data["build-system"]["build-backend"] == "setuptools.build_meta"


def test_pyproject_declares_dynamic_version() -> None:
    data = tomllib.loads((CORE_ROOT / "pyproject.toml").read_text(encoding="utf-8"))
    assert "version" in data["project"]["dynamic"]
    assert data["tool"]["setuptools"]["dynamic"]["version"]["attr"] == "hyperflow.__version__"


def test_pyproject_entrypoint_is_cli() -> None:
    data = tomllib.loads((CORE_ROOT / "pyproject.toml").read_text(encoding="utf-8"))
    assert data["project"]["scripts"]["hyperflow"] == "hyperflow.cli:main"


def test_pyproject_includes_all_packages() -> None:
    data = tomllib.loads((CORE_ROOT / "pyproject.toml").read_text(encoding="utf-8"))
    include = data["tool"]["setuptools"]["packages"]["find"]["include"]
    for pkg in ["hyperflow*", "language*", "control*", "engine*", "memory*", "scanner*"]:
        assert pkg in include


def test_version_constant_matches_get_version() -> None:
    assert hyperflow.__version__ == hyperflow.get_version()


def test_pyproject_has_test_extras() -> None:
    data = tomllib.loads((CORE_ROOT / "pyproject.toml").read_text(encoding="utf-8"))
    extras = data["project"]["optional-dependencies"]
    assert "test" in extras
    assert any(dep.startswith("pytest>=") or dep.startswith("pytest==") for dep in extras["test"])
