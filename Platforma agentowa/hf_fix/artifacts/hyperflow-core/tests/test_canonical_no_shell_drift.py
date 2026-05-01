"""
Shell Drift Guard Tests

Verifies that the TypeScript shell (api-server) and operator panel
do NOT redefine canonical phases, canonical combo, or canonical trace
semantics. They may store and forward these values but must not own them.
"""

import re
from pathlib import Path

WORKSPACE_ROOT = Path(__file__).parent.parent.parent.parent

DRIFT_PATTERNS = [
    r"""["']perceive["'].*["']extract_essence["'].*["']sense_direction["'].*["']synthesize["'].*["']generate_options["'].*["']choose["']""",
    r"""canonical_combo\s*[:=]\s*["']🌈💎🔥🧠🔀⚡["']""",
    r"""CANONICAL_PHASES\s*[:=]""",
    r"""CANONICAL_COMBO\s*[:=]""",
    r"""canonical_phases\s*[:=]\s*\[""",
    r"""perceive.*["']\s*:\s*["']\\u\{?1[Ff]308""",
    r"""PHASE_EMOJI\s*[:=]""",
    r"""phaseEmoji\s*[:=]\s*\{""",
    r"""["']perceive["']\s*:\s*["']🌈["']""",
]

ALLOWED_FILES = {
    "runtime_contract.md",
    "AGENT_PLATFORM_ARCHITECTURE.md",
    "README.md",
    "canonical_semantics.json",
}


def _scan_directory(directory: Path, extension: str) -> list[tuple[str, int, str]]:
    violations = []
    if not directory.exists():
        return violations

    for filepath in directory.rglob(f"*{extension}"):
        if filepath.name in ALLOWED_FILES:
            continue
        if "node_modules" in str(filepath) or "dist" in str(filepath):
            continue

        try:
            content = filepath.read_text(errors="replace")
        except Exception:
            continue

        for line_num, line in enumerate(content.splitlines(), 1):
            for pattern in DRIFT_PATTERNS:
                if re.search(pattern, line):
                    rel_path = filepath.relative_to(WORKSPACE_ROOT)
                    violations.append((str(rel_path), line_num, line.strip()[:120]))
    return violations


class TestApiServerNoDrift:
    def test_no_canonical_redefinition_in_ts_files(self):
        api_server_dir = WORKSPACE_ROOT / "artifacts" / "api-server" / "src"
        violations = _scan_directory(api_server_dir, ".ts")
        assert violations == [], (
            f"Shell drift detected — api-server redefines canonical semantics:\n"
            + "\n".join(f"  {f}:{ln}: {line}" for f, ln, line in violations)
        )

    def test_no_canonical_redefinition_in_tsx_files(self):
        api_server_dir = WORKSPACE_ROOT / "artifacts" / "api-server" / "src"
        violations = _scan_directory(api_server_dir, ".tsx")
        assert violations == [], (
            f"Shell drift detected — api-server redefines canonical semantics:\n"
            + "\n".join(f"  {f}:{ln}: {line}" for f, ln, line in violations)
        )


class TestOperatorPanelNoDrift:
    def test_no_canonical_redefinition_in_tsx_files(self):
        panel_dir = WORKSPACE_ROOT / "artifacts" / "operator-panel" / "src"
        violations = _scan_directory(panel_dir, ".tsx")
        assert violations == [], (
            f"Shell drift detected — operator-panel redefines canonical semantics:\n"
            + "\n".join(f"  {f}:{ln}: {line}" for f, ln, line in violations)
        )

    def test_no_canonical_redefinition_in_ts_files(self):
        panel_dir = WORKSPACE_ROOT / "artifacts" / "operator-panel" / "src"
        violations = _scan_directory(panel_dir, ".ts")
        assert violations == [], (
            f"Shell drift detected — operator-panel redefines canonical semantics:\n"
            + "\n".join(f"  {f}:{ln}: {line}" for f, ln, line in violations)
        )


class TestLibDbNoDrift:
    def test_no_canonical_redefinition_in_db_schema(self):
        db_dir = WORKSPACE_ROOT / "lib" / "db" / "src"
        violations = _scan_directory(db_dir, ".ts")
        assert violations == [], (
            f"Shell drift detected — lib/db redefines canonical semantics:\n"
            + "\n".join(f"  {f}:{ln}: {line}" for f, ln, line in violations)
        )


class TestMiddlewareNoDrift:
    def test_no_canonical_redefinition_in_middleware(self):
        mw_dir = WORKSPACE_ROOT / "artifacts" / "api-server" / "src" / "middlewares"
        violations = _scan_directory(mw_dir, ".ts")
        assert violations == [], (
            f"Shell drift detected — middlewares redefine canonical semantics:\n"
            + "\n".join(f"  {f}:{ln}: {line}" for f, ln, line in violations)
        )


class TestScriptsNoDrift:
    def test_no_canonical_redefinition_in_scripts(self):
        scripts_dir = WORKSPACE_ROOT / "scripts" / "src"
        violations = _scan_directory(scripts_dir, ".ts")
        assert violations == [], (
            f"Shell drift detected — scripts redefine canonical semantics:\n"
            + "\n".join(f"  {f}:{ln}: {line}" for f, ln, line in violations)
        )


class TestGeneratedLibsNoDrift:
    def test_no_canonical_redefinition_in_api_zod(self):
        lib_dir = WORKSPACE_ROOT / "lib" / "api-zod" / "src"
        violations = _scan_directory(lib_dir, ".ts")
        assert violations == [], (
            f"Shell drift detected — api-zod redefines canonical semantics:\n"
            + "\n".join(f"  {f}:{ln}: {line}" for f, ln, line in violations)
        )

    def test_no_canonical_redefinition_in_api_client_react(self):
        lib_dir = WORKSPACE_ROOT / "lib" / "api-client-react" / "src"
        violations = _scan_directory(lib_dir, ".ts")
        assert violations == [], (
            f"Shell drift detected — api-client-react redefines canonical semantics:\n"
            + "\n".join(f"  {f}:{ln}: {line}" for f, ln, line in violations)
        )
