"""
Hyperflow shared contract models — Pydantic v2.

These models mirror the OpenAPI spec in lib/api-spec/openapi.yaml exactly.
Field names, enum values, required/optional status, and nullability all
match the spec so that cross-language contract parity is guaranteed.

A field listed in the OpenAPI `required` array is always required here,
even if the schema type is a nullable union like `["string", "null"]`.
Nullable required fields use `Optional[X]` with no default (callers must
explicitly supply None or a value).

When the OpenAPI spec changes, update this file to match.
Run `python export_schemas.py` to regenerate JSON Schema artifacts.
Run `python -m pytest tests/` to verify all models validate correctly.
"""

from __future__ import annotations

from datetime import datetime
from enum import Enum
from typing import Any, Dict, List, Optional

from pydantic import BaseModel, Field


# ---------------------------------------------------------------------------
# Enums — values match OpenAPI enum arrays exactly
# ---------------------------------------------------------------------------


class AgentStatus(str, Enum):
    active = "active"
    inactive = "inactive"
    error = "error"


class LastRunStatus(str, Enum):
    """Shared last-run status for agents and workflows."""
    pending = "pending"
    running = "running"
    completed = "completed"
    failed = "failed"
    cancelled = "cancelled"


class RunStatusEnum(str, Enum):
    """M-5: Includes all runtime workflow statuses from workflowRuns.ts / WORKFLOW_RUN_STATUSES."""
    pending = "pending"
    queued = "queued"
    running = "running"
    completed = "completed"
    failed = "failed"
    waiting_approval = "waiting_approval"
    waiting_input = "waiting_input"
    cancelled = "cancelled"


class RunNodeStatusEnum(str, Enum):
    pending = "pending"
    running = "running"
    completed = "completed"
    failed = "failed"
    skipped = "skipped"


class RunType(str, Enum):
    workflow = "workflow"
    agent = "agent"
    scan = "scan"


class LogSeverity(str, Enum):
    debug = "debug"
    info = "info"
    warn = "warn"
    error = "error"


class CheckpointStatus(str, Enum):
    """Matches OpenAPI enum: active | resumed | rolled_back."""
    active = "active"
    resumed = "resumed"
    rolled_back = "rolled_back"


class RepositoryClassification(str, Enum):
    service = "service"
    library = "library"
    tool = "tool"
    infrastructure = "infrastructure"
    unknown = "unknown"


class RepositoryLastScanStatus(str, Enum):
    pending = "pending"
    running = "running"
    completed = "completed"
    failed = "failed"


# ---------------------------------------------------------------------------
# Sub-models
# ---------------------------------------------------------------------------


class AgentCapability(BaseModel):
    """Mirrors AgentCapability OpenAPI schema. Required: name, description."""
    name: str
    description: str


class ExecutableStepType(str, Enum):
    """M-5: Runtime-compatible step types matching workflow/contracts.py ExecutableWorkflowStep."""
    agent = "agent"
    tool = "tool"
    condition = "condition"
    approval = "approval"
    human = "human"
    join = "join"
    compensation = "compensation"


class WorkflowStep(BaseModel):
    """
    Mirrors WorkflowStep OpenAPI schema.
    Required: id, name, agentId, dependsOn.

    DEPRECATED: Legacy agent-only step from OpenAPI 0.x spec.
    Does not cover tool/condition/approval/human/join/compensation step types.
    Use ExecutableStepType for runtime-compatible step type enumeration.
    """
    id: str
    name: str
    agentId: str
    dependsOn: List[str]


class ResponseMeta(BaseModel):
    """Mirrors ResponseMeta OpenAPI schema. Required: requestId, timestamp, version."""
    requestId: str
    timestamp: str
    version: str


class RunNodeStatus(BaseModel):
    """
    Mirrors RunNodeStatus OpenAPI schema.
    Field is 'name' (not 'nodeName') per spec.
    Required: nodeId, name, status, startedAt (nullable), completedAt (nullable).
    """
    nodeId: str
    name: str
    status: RunNodeStatusEnum
    startedAt: Optional[datetime]
    completedAt: Optional[datetime]


class RunSummary(BaseModel):
    """
    Mirrors RunSummary OpenAPI schema (used in lists and dashboard).
    Required: runId, type, name, status, progress, startedAt, completedAt (nullable).
    """
    runId: str
    type: RunType
    name: str
    status: RunStatusEnum
    progress: float = Field(ge=0, le=100)
    startedAt: datetime
    completedAt: Optional[datetime]


# ---------------------------------------------------------------------------
# Primary contract models
# ---------------------------------------------------------------------------


class AgentDefinition(BaseModel):
    """
    Mirrors AgentDefinition OpenAPI schema.
    Required: id, name, description, version, status, capabilities,
              lastRunAt (nullable), lastRunStatus (nullable), createdAt.
    All fields in the OpenAPI `required` array are required here.
    """
    id: str
    name: str
    description: str
    version: str
    status: AgentStatus
    capabilities: List[AgentCapability]
    lastRunAt: Optional[datetime]
    lastRunStatus: Optional[LastRunStatus]
    createdAt: datetime


class WorkflowDefinition(BaseModel):
    """
    Mirrors WorkflowDefinition OpenAPI schema.
    Required: id, name, description, version, steps,
              lastRunAt (nullable), lastRunStatus (nullable), createdAt.
    """
    id: str
    name: str
    description: str
    version: str
    steps: List[WorkflowStep]
    lastRunAt: Optional[datetime]
    lastRunStatus: Optional[LastRunStatus]
    createdAt: datetime


class RepositoryDefinition(BaseModel):
    """
    Mirrors RepositoryDefinition OpenAPI schema.
    Required: id, name, url, language, classification,
              lastScannedAt (nullable), lastScanStatus (nullable),
              dependencyCount, overlapScore (nullable).
    """
    id: str
    name: str
    url: str
    language: str
    classification: RepositoryClassification
    lastScannedAt: Optional[datetime]
    lastScanStatus: Optional[RepositoryLastScanStatus]
    dependencyCount: int
    overlapScore: Optional[float] = Field(ge=0, le=1)


class RunStatus(BaseModel):
    """
    Mirrors RunStatus OpenAPI schema (full run detail).
    Required: runId, workflowId (nullable), agentId (nullable), type,
              status, progress, nodes, startedAt,
              completedAt (nullable), errorMessage (nullable).
    """
    runId: str
    workflowId: Optional[str]
    agentId: Optional[str]
    type: RunType
    status: RunStatusEnum
    progress: float = Field(ge=0, le=100)
    nodes: List[RunNodeStatus]
    startedAt: datetime
    completedAt: Optional[datetime]
    errorMessage: Optional[str]


class LogEvent(BaseModel):
    """
    Mirrors LogEvent OpenAPI schema.
    Required: id, runId (nullable), correlationId, severity,
              message, summary, context, timestamp.
    All fields are required per OpenAPI spec (some have nullable types).
    """
    id: str
    runId: Optional[str]
    correlationId: str
    severity: LogSeverity
    message: str
    summary: str
    context: Dict[str, Any]
    timestamp: datetime


class CheckpointRecord(BaseModel):
    """
    Mirrors CheckpointRecord OpenAPI schema.
    Status enum: active | resumed | rolled_back.
    Required: id, runId, nodeId, nodeName, status, savedAt, resumable.
    Note: field is 'nodeName' per OpenAPI spec (not 'name').
    """
    id: str
    runId: str
    nodeId: str
    nodeName: str
    status: CheckpointStatus
    savedAt: datetime
    resumable: bool


class DashboardSummary(BaseModel):
    """
    Mirrors DashboardSummary OpenAPI schema.
    Required: all integer counts, recentRuns, recentLogs.
    """
    activeRuns: int = Field(ge=0)
    completedRuns: int = Field(ge=0)
    failedRuns: int = Field(ge=0)
    totalAgents: int = Field(ge=0)
    activeAgents: int = Field(ge=0)
    totalWorkflows: int = Field(ge=0)
    totalRepositories: int = Field(ge=0)
    recentRuns: List[RunSummary]
    recentLogs: List[LogEvent]
