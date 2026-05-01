import sys
import os
import json
import tempfile
from pathlib import Path
import pytest

sys.path.insert(0, os.path.join(os.path.dirname(__file__), ".."))
from scanner.core import detect_classification as _detect_classification_from_tree


RATIONALE_KEYS = {"serverEntry", "libManifest", "cliEntry", "infraMarkers", "decision"}
SIGNAL_KEYS_SERVER = {"detected", "file", "pattern"}
SIGNAL_KEYS_LIB = {"detected", "file", "reason"}
SIGNAL_KEYS_CLI = {"detected", "file"}
SIGNAL_KEYS_INFRA = {"detected", "markers"}


class TestRationaleShape:
    def test_returns_tuple(self, tmp_path):
        result = _detect_classification_from_tree(tmp_path)
        assert isinstance(result, tuple)
        assert len(result) == 2

    def test_first_element_is_string(self, tmp_path):
        label, _ = _detect_classification_from_tree(tmp_path)
        assert isinstance(label, str)

    def test_second_element_is_dict(self, tmp_path):
        _, rationale = _detect_classification_from_tree(tmp_path)
        assert isinstance(rationale, dict)

    def test_rationale_has_all_keys(self, tmp_path):
        _, rationale = _detect_classification_from_tree(tmp_path)
        assert set(rationale.keys()) == RATIONALE_KEYS

    def test_decision_is_string(self, tmp_path):
        _, rationale = _detect_classification_from_tree(tmp_path)
        assert isinstance(rationale["decision"], str)
        assert len(rationale["decision"]) > 0

    def test_rationale_is_json_serializable(self, tmp_path):
        _, rationale = _detect_classification_from_tree(tmp_path)
        serialized = json.dumps(rationale)
        assert isinstance(serialized, str)


class TestUnknownRationale:
    def test_empty_dir_returns_unknown(self, tmp_path):
        label, rationale = _detect_classification_from_tree(tmp_path)
        assert label == "unknown"

    def test_all_signals_false_for_empty_dir(self, tmp_path):
        _, rationale = _detect_classification_from_tree(tmp_path)
        assert rationale["serverEntry"]["detected"] is False
        assert rationale["libManifest"]["detected"] is False
        assert rationale["cliEntry"]["detected"] is False
        assert rationale["infraMarkers"]["detected"] is False

    def test_decision_mentions_no_signals(self, tmp_path):
        _, rationale = _detect_classification_from_tree(tmp_path)
        assert "no server entry" in rationale["decision"].lower() or "no" in rationale["decision"].lower()


class TestLibraryRationale:
    def test_setup_py_detected(self, tmp_path):
        (tmp_path / "setup.py").write_text("from setuptools import setup")
        label, rationale = _detect_classification_from_tree(tmp_path)
        assert label == "library"
        assert rationale["libManifest"]["detected"] is True
        assert rationale["libManifest"]["file"] == "setup.py"

    def test_pyproject_with_project_section(self, tmp_path):
        (tmp_path / "pyproject.toml").write_text("[project]\nname = \"mypkg\"\n")
        label, rationale = _detect_classification_from_tree(tmp_path)
        assert label == "library"
        assert rationale["libManifest"]["detected"] is True
        assert rationale["libManifest"]["file"] == "pyproject.toml"
        assert "[project]" in rationale["libManifest"]["reason"]

    def test_package_json_with_main(self, tmp_path):
        (tmp_path / "package.json").write_text(json.dumps({"name": "foo", "main": "index.js"}))
        label, rationale = _detect_classification_from_tree(tmp_path)
        assert label == "library"
        assert rationale["libManifest"]["detected"] is True
        assert rationale["libManifest"]["file"] == "package.json"
        assert "main" in rationale["libManifest"]["reason"]

    def test_package_json_public_package(self, tmp_path):
        (tmp_path / "package.json").write_text(json.dumps({"name": "mypkg"}))
        label, rationale = _detect_classification_from_tree(tmp_path)
        assert label == "library"
        assert rationale["libManifest"]["detected"] is True
        assert "public" in rationale["libManifest"]["reason"].lower()

    def test_cargo_toml_with_lib(self, tmp_path):
        (tmp_path / "Cargo.toml").write_text("[package]\nname = \"mylib\"\n[lib]\n")
        label, rationale = _detect_classification_from_tree(tmp_path)
        assert label == "library"
        assert rationale["libManifest"]["detected"] is True
        assert rationale["libManifest"]["file"] == "Cargo.toml"

    def test_decision_mentions_file(self, tmp_path):
        (tmp_path / "setup.py").write_text("")
        _, rationale = _detect_classification_from_tree(tmp_path)
        assert "setup.py" in rationale["decision"]


class TestToolRationale:
    def test_cli_py_detected(self, tmp_path):
        (tmp_path / "cli.py").write_text("import click")
        label, rationale = _detect_classification_from_tree(tmp_path)
        assert label == "tool"
        assert rationale["cliEntry"]["detected"] is True
        assert rationale["cliEntry"]["file"] == "cli.py"

    def test_bin_dir_detected(self, tmp_path):
        (tmp_path / "bin").mkdir()
        label, rationale = _detect_classification_from_tree(tmp_path)
        assert label == "tool"
        assert rationale["cliEntry"]["detected"] is True
        assert "bin" in rationale["cliEntry"]["file"]

    def test_cmd_dir_detected(self, tmp_path):
        (tmp_path / "cmd").mkdir()
        label, rationale = _detect_classification_from_tree(tmp_path)
        assert label == "tool"
        assert rationale["cliEntry"]["detected"] is True
        assert "cmd" in rationale["cliEntry"]["file"]

    def test_cargo_bin_detected(self, tmp_path):
        (tmp_path / "Cargo.toml").write_text("[package]\nname = \"mytool\"\n[[bin]]\nname = \"mytool\"\n")
        label, rationale = _detect_classification_from_tree(tmp_path)
        assert label == "tool"
        assert rationale["cliEntry"]["detected"] is True
        assert rationale["cliEntry"]["file"] == "Cargo.toml"

    def test_decision_mentions_cli(self, tmp_path):
        (tmp_path / "cli.py").write_text("")
        _, rationale = _detect_classification_from_tree(tmp_path)
        assert "cli" in rationale["decision"].lower()


class TestServiceRationale:
    def test_server_js_with_express(self, tmp_path):
        (tmp_path / "server.js").write_text("const app = express();\napp.listen(3000);")
        label, rationale = _detect_classification_from_tree(tmp_path)
        assert label == "service"
        assert rationale["serverEntry"]["detected"] is True
        assert rationale["serverEntry"]["file"] == "server.js"

    def test_decision_mentions_server(self, tmp_path):
        (tmp_path / "server.js").write_text("const app = express();\napp.listen(3000);")
        _, rationale = _detect_classification_from_tree(tmp_path)
        assert "server" in rationale["decision"].lower()


class TestInfrastructureRationale:
    def test_terraform_dir_detected(self, tmp_path):
        (tmp_path / "terraform").mkdir()
        label, rationale = _detect_classification_from_tree(tmp_path)
        assert label == "infrastructure"
        assert rationale["infraMarkers"]["detected"] is True
        assert "terraform" in rationale["infraMarkers"]["markers"]

    def test_two_infra_files_detected(self, tmp_path):
        (tmp_path / "Dockerfile").write_text("FROM node")
        (tmp_path / "docker-compose.yml").write_text("version: '3'")
        label, rationale = _detect_classification_from_tree(tmp_path)
        assert label == "infrastructure"
        assert rationale["infraMarkers"]["detected"] is True
        assert len(rationale["infraMarkers"]["markers"]) >= 2

    def test_decision_mentions_markers(self, tmp_path):
        (tmp_path / "terraform").mkdir()
        _, rationale = _detect_classification_from_tree(tmp_path)
        assert "infrastructure" in rationale["decision"].lower()
