from __future__ import annotations

import shutil
import subprocess
import sys
from pathlib import Path

import pytest

from hyperflow import __version__


def _resolve_console_script() -> str | None:
    direct = Path(sys.executable).with_name("hyperflow")
    if direct.exists():
        return str(direct)
    scripts_dir = Path(__import__("sysconfig").get_path("scripts")) / "hyperflow"
    if scripts_dir.exists():
        return str(scripts_dir)
    return shutil.which("hyperflow")


def test_cli_version_output() -> None:
    result = subprocess.run(
        [sys.executable, "-m", "hyperflow.cli", "--version"],
        check=True,
        capture_output=True,
        text=True,
    )
    assert __version__ in result.stdout.strip()


def test_console_script_version() -> None:
    console_script = _resolve_console_script()
    if console_script is None:
        pytest.skip("hyperflow console script is not installed")

    result = subprocess.run(
        [console_script, "--version"],
        check=True,
        capture_output=True,
        text=True,
    )
    assert __version__ in result.stdout.strip()


def test_cli_help_shows_usage() -> None:
    result = subprocess.run(
        [sys.executable, "-m", "hyperflow.cli", "--help"],
        check=True,
        capture_output=True,
        text=True,
    )
    assert "hyperflow" in result.stdout.lower()
