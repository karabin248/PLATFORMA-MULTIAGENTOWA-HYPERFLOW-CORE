"""Tests for the intent classifier (_classify) in main.py.

Covers:
- Confirmed bug cases (false-positive fixes)
- Regression cases (must still classify correctly)
- Fallback behavior
- Tie-breaking by priority
"""

import sys
import os
import pytest

sys.path.insert(0, os.path.join(os.path.dirname(__file__), ".."))
from main import _classify


class TestConfirmedBugFixes:
    def test_plan_the_migration_to_microservices(self):
        intent, mode, output_type = _classify("plan the migration to microservices")
        assert intent == "plan", f"Expected 'plan', got '{intent}'"
        assert mode == "planning"
        assert output_type == "execution_plan"

    def test_monitor_disk_usage_during_scan(self):
        intent, mode, output_type = _classify("monitor disk usage during scan")
        assert intent == "monitor", f"Expected 'monitor', got '{intent}'"
        assert mode == "observational"
        assert output_type == "observation_log"


class TestRegressionCases:
    def test_migrate_database_schema(self):
        intent, _, _ = _classify("migrate database schema")
        assert intent == "transform", f"Expected 'transform', got '{intent}'"

    def test_scan_repository_dependencies(self):
        intent, _, _ = _classify("scan repository dependencies")
        assert intent == "query", f"Expected 'query', got '{intent}'"

    def test_monitor_cpu_usage(self):
        intent, mode, _ = _classify("monitor CPU usage")
        assert intent == "monitor", f"Expected 'monitor', got '{intent}'"
        assert mode == "observational"

    def test_plan_the_architecture(self):
        intent, mode, _ = _classify("plan the architecture")
        assert intent == "plan", f"Expected 'plan', got '{intent}'"
        assert mode == "planning"


class TestFallback:
    def test_no_matching_keywords_returns_process(self):
        intent, mode, output_type = _classify("hello world")
        assert intent == "process"
        assert mode == "analytical"
        assert output_type == "processed_output"

    def test_empty_string_returns_process(self):
        intent, _, _ = _classify("")
        assert intent == "process"


class TestTieBreaking:
    def test_plan_beats_monitor_on_tie(self):
        intent, _, _ = _classify("plan to monitor the system")
        assert intent == "plan", f"Expected 'plan' to win tie over 'monitor', got '{intent}'"

    def test_monitor_beats_query_on_tie(self):
        intent, _, _ = _classify("monitor and scan the logs")
        assert intent == "monitor", f"Expected 'monitor' to win tie over 'query', got '{intent}'"

    def test_plan_beats_transform_on_tie(self):
        intent, _, _ = _classify("plan the migration")
        assert intent == "plan", f"Expected 'plan' to win over 'transform', got '{intent}'"


class TestSingleIntentCases:
    def test_analyze(self):
        intent, _, _ = _classify("analyze the codebase for issues")
        assert intent == "analyze"

    def test_generate(self):
        intent, _, _ = _classify("generate a report from the data")
        assert intent == "generate"

    def test_explain(self):
        intent, _, _ = _classify("explain how authentication works")
        assert intent == "explain"

    def test_classify_intent(self):
        intent, _, _ = _classify("classify these items by topic")
        assert intent == "classify"

    def test_validate(self):
        intent, _, _ = _classify("validate the configuration file")
        assert intent == "validate"

    def test_optimize(self):
        intent, _, _ = _classify("optimize the database queries")
        assert intent == "optimize"
