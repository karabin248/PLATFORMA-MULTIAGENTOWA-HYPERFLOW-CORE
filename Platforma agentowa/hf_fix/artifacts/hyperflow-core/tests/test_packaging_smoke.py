"""
Packaging smoke tests — verify the core modules are importable and
the package metadata is consistent.

These tests do NOT require pip install or build tools to run.
They verify: module importability, version consistency, and structural
integrity of the key public interfaces.
"""
from __future__ import annotations

import sys
import os
import importlib

import pytest

sys.path.insert(0, os.path.join(os.path.dirname(__file__), ".."))


class TestModuleImportability:
    def test_emoji_parser_importable(self):
        mod = importlib.import_module("language.emoji_parser")
        assert hasattr(mod, "parse")
        assert hasattr(mod, "CANONICAL_PHASES")
        assert hasattr(mod, "CANONICAL_COMBO")

    def test_intent_resolver_importable(self):
        mod = importlib.import_module("language.intent_resolver")
        assert hasattr(mod, "resolve")

    def test_mps_controller_importable(self):
        mod = importlib.import_module("control.mps_controller")
        assert hasattr(mod, "MPS_PROFILES")
        assert hasattr(mod, "build_mps_context")
        assert hasattr(mod, "resolve_mps_level")

    def test_edde_orchestrator_importable(self):
        mod = importlib.import_module("engine.edde_orchestrator")
        assert hasattr(mod, "run_edde")

    def test_memory_store_importable(self):
        mod = importlib.import_module("memory.store")
        assert hasattr(mod, "save_knowledge")
        assert hasattr(mod, "save_trace")
        assert hasattr(mod, "push_session")
        assert hasattr(mod, "get_session_summary")

    def test_openrouter_importable(self):
        mod = importlib.import_module("openrouter")
        assert hasattr(mod, "call_model")
        assert hasattr(mod, "OpenRouterUnavailable")


class TestCanonicalPhasesIntegrity:
    def test_six_phases(self):
        from language.emoji_parser import CANONICAL_PHASES
        assert len(CANONICAL_PHASES) == 6

    def test_phase_names_match_spec(self):
        from language.emoji_parser import CANONICAL_PHASES
        expected = [
            "perceive",
            "extract_essence",
            "sense_direction",
            "synthesize",
            "generate_options",
            "choose",
        ]
        assert list(CANONICAL_PHASES) == expected

    def test_canonical_combo_has_six_emoji(self):
        from language.emoji_parser import CANONICAL_COMBO
        import unicodedata
        emoji_chars = [c for c in CANONICAL_COMBO if unicodedata.category(c) == "So"]
        assert len(emoji_chars) == 6


class TestMPSProfilesIntegrity:
    def test_seven_profiles(self):
        from control.mps_controller import MPS_PROFILES
        assert len(MPS_PROFILES) == 7

    def test_levels_are_1_to_7(self):
        from control.mps_controller import MPS_PROFILES
        assert set(MPS_PROFILES.keys()) == {1, 2, 3, 4, 5, 6, 7}

    def test_all_profiles_have_required_fields(self):
        from control.mps_controller import MPS_PROFILES
        required = {"name", "depth", "observer_rigor", "risk_state",
                    "execution_policy", "llm_temperature", "max_candidates"}
        for level, profile in MPS_PROFILES.items():
            missing = required - set(profile.keys())
            assert not missing, f"Level {level} missing fields: {missing}"

    def test_temperature_in_valid_range(self):
        from control.mps_controller import MPS_PROFILES
        for level, profile in MPS_PROFILES.items():
            t = profile["llm_temperature"]
            assert 0.0 <= t <= 1.0, f"Level {level} temperature {t} out of range"


class TestPublicAPIShape:
    def test_classify_function_exists_in_main(self):
        import importlib.util
        spec = importlib.util.spec_from_file_location(
            "main_mod",
            os.path.join(os.path.dirname(__file__), "..", "main.py")
        )
        mod = importlib.util.module_from_spec(spec)
        spec.loader.exec_module(mod)
        assert hasattr(mod, "_classify"), "_classify must be importable from main.py"
        assert callable(mod._classify)

    def test_detect_classification_function_exists_in_scanner_core(self):
        from scanner.core import detect_classification
        assert callable(detect_classification)

    def test_classify_returns_three_tuple(self):
        import importlib.util
        spec = importlib.util.spec_from_file_location(
            "main_mod3",
            os.path.join(os.path.dirname(__file__), "..", "main.py")
        )
        mod = importlib.util.module_from_spec(spec)
        spec.loader.exec_module(mod)
        result = mod._classify("analyze the system")
        assert isinstance(result, tuple)
        assert len(result) == 3

    def test_openrouter_call_model_accepts_temperature(self):
        import inspect
        from openrouter import call_model
        sig = inspect.signature(call_model)
        assert "temperature" in sig.parameters, "call_model must accept temperature parameter"


class TestVersionConsistency:
    def test_pyproject_version_readable(self):
        import tomllib
        pyproject = os.path.join(os.path.dirname(__file__), "..", "pyproject.toml")
        if not os.path.exists(pyproject):
            pytest.skip("pyproject.toml not found in core directory")
        with open(pyproject, "rb") as f:
            data = tomllib.load(f)
        if "version" in data["project"]:
            version = data["project"]["version"]
        else:
            assert "version" in data["project"].get("dynamic", [])
            attr = data["tool"]["setuptools"]["dynamic"]["version"]["attr"]
            mod, var = attr.rsplit(".", 1)
            import importlib
            m = importlib.import_module(mod)
            version = getattr(m, var)
        assert isinstance(version, str)
        assert len(version) > 0
        parts = version.split(".")
        assert len(parts) >= 2, f"Version should be semver, got: {version}"
