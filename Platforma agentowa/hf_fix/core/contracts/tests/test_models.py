"""Unit tests for Hyperflow Pydantic v2 contract models.

All models and enums must exactly mirror lib/api-spec/openapi.yaml.
Tests verify:
- All OpenAPI `required` fields are present (no defaults masking missing values)
- Nullable required fields accept None but reject missing key
- Enum values match spec exactly
- Range constraints (ge/le) reject out-of-range values
- Serialization roundtrips are lossless
"""

import json
import pytest
from datetime import datetime, timezone
from pydantic import ValidationError

from ..models import (
    AgentCapability,
    AgentDefinition,
    AgentStatus,
    CheckpointRecord,
    CheckpointStatus,
    DashboardSummary,
    LastRunStatus,
    LogEvent,
    LogSeverity,
    RepositoryClassification,
    RepositoryDefinition,
    RepositoryLastScanStatus,
    RunNodeStatus,
    RunNodeStatusEnum,
    RunStatus,
    RunStatusEnum,
    RunSummary,
    RunType,
    WorkflowDefinition,
    WorkflowStep,
)

NOW = datetime(2026, 4, 3, 12, 0, 0, tzinfo=timezone.utc)

# ---------------------------------------------------------------------------
# Helper factories — build fully-valid objects mirroring the spec
# ---------------------------------------------------------------------------

def make_agent(**overrides) -> dict:
    base = dict(
        id="agent-001",
        name="Inventory Agent",
        description="Scans repos",
        version="1.0.0",
        status=AgentStatus.active,
        capabilities=[],
        lastRunAt=None,
        lastRunStatus=None,
        createdAt=NOW,
    )
    base.update(overrides)
    return base


def make_workflow(**overrides) -> dict:
    base = dict(
        id="wf-001",
        name="Full Analysis",
        description="E2E pipeline",
        version="1.0.0",
        steps=[],
        lastRunAt=None,
        lastRunStatus=None,
        createdAt=NOW,
    )
    base.update(overrides)
    return base


def make_run_node(**overrides) -> dict:
    base = dict(nodeId="step-1", name="Inventory", status=RunNodeStatusEnum.completed,
                startedAt=NOW, completedAt=NOW)
    base.update(overrides)
    return base


def make_run_summary(**overrides) -> dict:
    base = dict(runId="run-001", type=RunType.workflow, name="Full Analysis",
                status=RunStatusEnum.completed, progress=100.0,
                startedAt=NOW, completedAt=NOW)
    base.update(overrides)
    return base


def make_run_status(**overrides) -> dict:
    base = dict(
        runId="run-001",
        workflowId="wf-001",
        agentId=None,
        type=RunType.workflow,
        status=RunStatusEnum.completed,
        progress=100.0,
        nodes=[],
        startedAt=NOW,
        completedAt=NOW,
        errorMessage=None,
    )
    base.update(overrides)
    return base


def make_log_event(**overrides) -> dict:
    base = dict(
        id="log-001",
        runId="run-001",
        correlationId="corr-001",
        severity=LogSeverity.info,
        message="Workflow started",
        summary="Workflow started successfully",
        context={},
        timestamp=NOW,
    )
    base.update(overrides)
    return base


def make_repo(**overrides) -> dict:
    base = dict(
        id="repo-001",
        name="api-gateway",
        url="https://github.com/org/api-gateway",
        language="TypeScript",
        classification=RepositoryClassification.service,
        lastScannedAt=None,
        lastScanStatus=None,
        dependencyCount=0,
        overlapScore=None,
    )
    base.update(overrides)
    return base


def make_checkpoint(**overrides) -> dict:
    base = dict(
        id="cp-001",
        runId="run-001",
        nodeId="step-1",
        nodeName="Inventory",
        status=CheckpointStatus.active,
        savedAt=NOW,
        resumable=True,
    )
    base.update(overrides)
    return base


# ---------------------------------------------------------------------------
# AgentDefinition
# ---------------------------------------------------------------------------

class TestAgentDefinition:
    def test_valid_full(self):
        agent = AgentDefinition(**make_agent(
            capabilities=[AgentCapability(name="repo-scan", description="Scan")],
            lastRunAt=NOW,
            lastRunStatus=LastRunStatus.completed,
        ))
        assert agent.id == "agent-001"
        assert agent.status == AgentStatus.active
        assert len(agent.capabilities) == 1
        assert agent.createdAt == NOW

    def test_nullable_fields_accept_none(self):
        agent = AgentDefinition(**make_agent(lastRunAt=None, lastRunStatus=None))
        assert agent.lastRunAt is None
        assert agent.lastRunStatus is None

    def test_missing_created_at_raises(self):
        data = make_agent()
        del data["createdAt"]
        with pytest.raises(ValidationError):
            AgentDefinition(**data)

    def test_missing_capabilities_raises(self):
        data = make_agent()
        del data["capabilities"]
        with pytest.raises(ValidationError):
            AgentDefinition(**data)

    def test_invalid_status_raises(self):
        with pytest.raises(ValidationError):
            AgentDefinition(**make_agent(status="invalid_status"))

    def test_last_run_status_enum_values(self):
        for value in ("pending", "running", "completed", "failed", "cancelled"):
            agent = AgentDefinition(**make_agent(lastRunStatus=value))
            assert agent.lastRunStatus.value == value

    def test_serialization_roundtrip(self):
        agent = AgentDefinition(**make_agent())
        rehydrated = AgentDefinition.model_validate_json(agent.model_dump_json())
        assert rehydrated.id == agent.id
        assert rehydrated.status == agent.status


# ---------------------------------------------------------------------------
# WorkflowStep
# ---------------------------------------------------------------------------

class TestWorkflowStep:
    def test_required_fields(self):
        step = WorkflowStep(id="step-1", name="Inventory", agentId="agent-1", dependsOn=[])
        assert step.id == "step-1"
        assert step.dependsOn == []

    def test_no_default_for_depends_on(self):
        with pytest.raises(ValidationError):
            WorkflowStep(id="step-1", name="Inventory", agentId="agent-1")

    def test_depends_on_list(self):
        step = WorkflowStep(id="step-2", name="Classify", agentId="agent-2", dependsOn=["step-1"])
        assert step.dependsOn == ["step-1"]


# ---------------------------------------------------------------------------
# WorkflowDefinition
# ---------------------------------------------------------------------------

class TestWorkflowDefinition:
    def test_valid_full(self):
        wf = WorkflowDefinition(**make_workflow(
            steps=[WorkflowStep(id="step-1", name="Inventory", agentId="agent-1", dependsOn=[])],
        ))
        assert len(wf.steps) == 1
        assert wf.createdAt == NOW

    def test_missing_created_at_raises(self):
        data = make_workflow()
        del data["createdAt"]
        with pytest.raises(ValidationError):
            WorkflowDefinition(**data)

    def test_nullable_last_run_at_accepts_none(self):
        wf = WorkflowDefinition(**make_workflow(lastRunAt=None))
        assert wf.lastRunAt is None


# ---------------------------------------------------------------------------
# RunNodeStatus
# ---------------------------------------------------------------------------

class TestRunNodeStatus:
    def test_field_name_is_name_not_nodename(self):
        node = RunNodeStatus(**make_run_node())
        assert node.name == "Inventory"
        assert not hasattr(node, "nodeName")

    def test_nullable_timestamps_required_but_accept_none(self):
        node = RunNodeStatus(**make_run_node(startedAt=None, completedAt=None))
        assert node.startedAt is None
        assert node.completedAt is None

    def test_missing_started_at_raises(self):
        data = make_run_node()
        del data["startedAt"]
        with pytest.raises(ValidationError):
            RunNodeStatus(**data)

    def test_skipped_status(self):
        node = RunNodeStatus(**make_run_node(status=RunNodeStatusEnum.skipped,
                                             startedAt=None, completedAt=None))
        assert node.status == RunNodeStatusEnum.skipped

    def test_invalid_status_raises(self):
        with pytest.raises(ValidationError):
            RunNodeStatus(**make_run_node(status="error"))


# ---------------------------------------------------------------------------
# RunSummary
# ---------------------------------------------------------------------------

class TestRunSummary:
    def test_valid(self):
        summary = RunSummary(**make_run_summary())
        assert summary.runId == "run-001"
        assert summary.completedAt == NOW

    def test_nullable_completed_at_accepts_none(self):
        summary = RunSummary(**make_run_summary(completedAt=None))
        assert summary.completedAt is None

    def test_missing_completed_at_raises(self):
        data = make_run_summary()
        del data["completedAt"]
        with pytest.raises(ValidationError):
            RunSummary(**data)


# ---------------------------------------------------------------------------
# RunStatus
# ---------------------------------------------------------------------------

class TestRunStatus:
    def test_full_required_fields(self):
        run = RunStatus(**make_run_status())
        assert run.progress == 100.0
        assert run.nodes == []
        assert run.errorMessage is None

    def test_nullable_fields_accept_none(self):
        run = RunStatus(**make_run_status(workflowId=None, agentId=None,
                                          completedAt=None, errorMessage=None))
        assert run.workflowId is None
        assert run.agentId is None

    def test_missing_workflow_id_raises(self):
        data = make_run_status()
        del data["workflowId"]
        with pytest.raises(ValidationError):
            RunStatus(**data)

    def test_missing_error_message_raises(self):
        data = make_run_status()
        del data["errorMessage"]
        with pytest.raises(ValidationError):
            RunStatus(**data)

    def test_progress_out_of_range_raises(self):
        with pytest.raises(ValidationError):
            RunStatus(**make_run_status(progress=150.0))

    def test_with_nodes(self):
        run = RunStatus(**make_run_status(nodes=[
            RunNodeStatus(**make_run_node(nodeId="step-1", name="Inventory")),
            RunNodeStatus(**make_run_node(nodeId="step-2", name="Classify",
                                          status=RunNodeStatusEnum.running,
                                          completedAt=None)),
        ]))
        assert len(run.nodes) == 2
        assert run.nodes[0].name == "Inventory"


# ---------------------------------------------------------------------------
# LogEvent
# ---------------------------------------------------------------------------

class TestLogEvent:
    def test_full_required_fields(self):
        log = LogEvent(**make_log_event())
        assert log.severity == LogSeverity.info
        assert log.correlationId == "corr-001"
        assert log.summary == "Workflow started successfully"
        assert log.context == {}

    def test_run_id_nullable_accepts_none(self):
        log = LogEvent(**make_log_event(runId=None))
        assert log.runId is None

    def test_missing_correlation_id_raises(self):
        data = make_log_event()
        del data["correlationId"]
        with pytest.raises(ValidationError):
            LogEvent(**data)

    def test_missing_summary_raises(self):
        data = make_log_event()
        del data["summary"]
        with pytest.raises(ValidationError):
            LogEvent(**data)

    def test_missing_context_raises(self):
        data = make_log_event()
        del data["context"]
        with pytest.raises(ValidationError):
            LogEvent(**data)

    def test_context_accepts_arbitrary_keys(self):
        log = LogEvent(**make_log_event(
            context={"reason": "no manifest found", "repo": "infra-terraform"}
        ))
        assert log.context["reason"] == "no manifest found"

    def test_invalid_severity_raises(self):
        with pytest.raises(ValidationError):
            LogEvent(**make_log_event(severity="trace"))


# ---------------------------------------------------------------------------
# CheckpointRecord
# ---------------------------------------------------------------------------

class TestCheckpointRecord:
    def test_field_name_is_node_name(self):
        cp = CheckpointRecord(**make_checkpoint())
        assert cp.nodeName == "Inventory"

    def test_status_enum_values_match_openapi(self):
        for status in ("active", "resumed", "rolled_back"):
            cp = CheckpointRecord(**make_checkpoint(status=status))
            assert cp.status.value == status

    def test_rolled_back(self):
        cp = CheckpointRecord(**make_checkpoint(status=CheckpointStatus.rolled_back,
                                                resumable=False))
        assert cp.status == CheckpointStatus.rolled_back
        assert cp.resumable is False

    def test_invalid_status_raises(self):
        with pytest.raises(ValidationError):
            CheckpointRecord(**make_checkpoint(status="superseded"))

    def test_no_state_ref_field(self):
        cp = CheckpointRecord(**make_checkpoint())
        assert not hasattr(cp, "stateRef")


# ---------------------------------------------------------------------------
# RepositoryDefinition
# ---------------------------------------------------------------------------

class TestRepositoryDefinition:
    def test_valid_full(self):
        repo = RepositoryDefinition(**make_repo(
            language="Python",
            classification=RepositoryClassification.service,
            dependencyCount=12,
            overlapScore=0.67,
            lastScanStatus=RepositoryLastScanStatus.completed,
        ))
        assert repo.overlapScore == pytest.approx(0.67)
        assert repo.dependencyCount == 12

    def test_nullable_fields_accept_none(self):
        repo = RepositoryDefinition(**make_repo(lastScannedAt=None, lastScanStatus=None,
                                                overlapScore=None))
        assert repo.lastScannedAt is None
        assert repo.overlapScore is None

    def test_missing_language_raises(self):
        data = make_repo()
        del data["language"]
        with pytest.raises(ValidationError):
            RepositoryDefinition(**data)

    def test_missing_classification_raises(self):
        data = make_repo()
        del data["classification"]
        with pytest.raises(ValidationError):
            RepositoryDefinition(**data)

    def test_missing_dependency_count_raises(self):
        data = make_repo()
        del data["dependencyCount"]
        with pytest.raises(ValidationError):
            RepositoryDefinition(**data)

    def test_overlap_score_out_of_range_raises(self):
        with pytest.raises(ValidationError):
            RepositoryDefinition(**make_repo(overlapScore=1.5))


# ---------------------------------------------------------------------------
# DashboardSummary
# ---------------------------------------------------------------------------

class TestDashboardSummary:
    def test_valid_empty_lists(self):
        summary = DashboardSummary(
            activeRuns=0,
            completedRuns=0,
            failedRuns=0,
            totalAgents=0,
            activeAgents=0,
            totalWorkflows=0,
            totalRepositories=0,
            recentRuns=[],
            recentLogs=[],
        )
        assert summary.recentRuns == []
        assert summary.recentLogs == []

    def test_missing_recent_runs_raises(self):
        with pytest.raises(ValidationError):
            DashboardSummary(
                activeRuns=0, completedRuns=0, failedRuns=0,
                totalAgents=0, activeAgents=0, totalWorkflows=0, totalRepositories=0,
                recentLogs=[],
            )

    def test_negative_count_raises(self):
        with pytest.raises(ValidationError):
            DashboardSummary(
                activeRuns=-1, completedRuns=0, failedRuns=0,
                totalAgents=5, activeAgents=4, totalWorkflows=3, totalRepositories=6,
                recentRuns=[], recentLogs=[],
            )


# ---------------------------------------------------------------------------
# M-5: RunStatusEnum runtime alignment + ExecutableStepType
# ---------------------------------------------------------------------------

class TestRunStatusEnumRuntimeAlignment:
    """Verify RunStatusEnum includes all workflow runtime statuses."""

    def test_includes_queued(self):
        run = RunStatus(**make_run_status(status="queued"))
        assert run.status.value == "queued"

    def test_includes_waiting_approval(self):
        run = RunStatus(**make_run_status(status="waiting_approval"))
        assert run.status.value == "waiting_approval"

    def test_includes_waiting_input(self):
        run = RunStatus(**make_run_status(status="waiting_input"))
        assert run.status.value == "waiting_input"

    def test_all_runtime_statuses_valid(self):
        runtime_statuses = [
            "pending", "queued", "running", "completed",
            "failed", "waiting_approval", "waiting_input", "cancelled",
        ]
        for status in runtime_statuses:
            run = RunStatus(**make_run_status(status=status))
            assert run.status.value == status

    def test_invalid_status_still_raises(self):
        from pydantic import ValidationError
        with pytest.raises(ValidationError):
            RunStatus(**make_run_status(status="unknown_status"))


class TestExecutableStepType:
    """Verify ExecutableStepType covers all runtime step types."""

    def test_all_runtime_types_present(self):
        from ..models import ExecutableStepType
        expected = {"agent", "tool", "condition", "approval", "human", "join", "compensation"}
        actual = {e.value for e in ExecutableStepType}
        assert expected == actual, f"Missing: {expected - actual}"

    def test_memory_write_not_in_executable(self):
        """memory-write is defined in schema but unsupported at runtime — must not be in enum."""
        from ..models import ExecutableStepType
        assert "memory-write" not in {e.value for e in ExecutableStepType}
        assert "memory-query" not in {e.value for e in ExecutableStepType}
