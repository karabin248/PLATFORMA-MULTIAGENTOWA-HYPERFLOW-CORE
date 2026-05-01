from __future__ import annotations

import os
from typing import Any, Dict, List, Literal, Optional, Union

from pydantic import BaseModel, ConfigDict, Field, model_validator, field_validator

# M-06: server-side caps mirroring the TS compilation-time checks. These apply
# to *all* workflow execution paths (run, resume, approval continuation,
# human-input continuation) so a payload that somehow bypasses TS compilation
# still cannot exhaust the Python asyncio executor.
_MAX_STEPS: int = int(os.environ.get("MAX_WORKFLOW_STEPS", "50"))
_MAX_EDGES: int = int(os.environ.get("MAX_WORKFLOW_EDGES", "200"))


class AgentRef(BaseModel):
    id: str
    version: str = "1.0.0"
    role: Optional[str] = None
    capabilities: List[str] = Field(default_factory=list)
    runPolicy: Dict[str, Any] = Field(default_factory=dict)


class HandoffContract(BaseModel):
    schemaVersion: str = "1.0"
    intent: str = "node_result"
    targetHint: Optional[str] = None
    artifactKeys: List[str] = Field(default_factory=list)
    openQuestions: List[str] = Field(default_factory=list)
    successSignal: Optional[str] = None


class ExecutableEdge(BaseModel):
    model_config = ConfigDict(populate_by_name=True)

    from_id: str = Field(alias="from")
    to: str
    condition: Optional[str] = None


class WorkflowStepBase(BaseModel):
    id: str
    type: str
    name: str
    dependsOn: List[str] = Field(default_factory=list)
    input: Dict[str, Any] = Field(default_factory=dict)
    retryPolicy: Optional[Dict[str, Any]] = None
    inputSchema: Optional[Dict[str, Any]] = None
    outputSchema: Optional[Dict[str, Any]] = None


class AgentStep(WorkflowStepBase):
    type: Literal["agent"]
    prompt: str
    requiredCapabilities: List[str] = Field(default_factory=list)
    handoffContract: Optional[HandoffContract] = None
    agentRef: Optional[AgentRef] = None


class ToolStep(WorkflowStepBase):
    type: Literal["tool"]
    action: str


class ConditionStep(WorkflowStepBase):
    type: Literal["condition"]
    expression: str


class ApprovalStep(WorkflowStepBase):
    type: Literal["approval"]
    reason: str
    objective: Optional[str] = None
    metadata: Dict[str, Any] = Field(default_factory=dict)


class HumanStep(WorkflowStepBase):
    type: Literal["human"]
    instruction: str
    expectedInputSchema: Optional[Dict[str, Any]] = None


class JoinStep(WorkflowStepBase):
    type: Literal["join"]
    mergePolicy: str = "all_active"


class CompensationStep(WorkflowStepBase):
    type: Literal["compensation"]
    targetNodeId: str
    strategy: str = "record"


ExecutableWorkflowStep = Union[
    AgentStep,
    ToolStep,
    ConditionStep,
    ApprovalStep,
    HumanStep,
    JoinStep,
    CompensationStep,
]


class CompletedNode(BaseModel):
    nodeId: str
    name: str
    result: Optional[Dict[str, Any]] = None
    startedAt: Optional[str] = None
    completedAt: Optional[str] = None


def _normalize_step_payload(step: Dict[str, Any]) -> Dict[str, Any]:
    data = dict(step)
    step_type = data.get("type") or data.get("kind")
    if not step_type:
        if "prompt" in data:
            step_type = "agent"
        elif data.get("action"):
            step_type = "tool"
        else:
            step_type = "agent"

    # "parallel" was never a supported step type in this runtime.
    # memory-write and memory-query were removed from the schema in v0.4.0.
    if step_type in {"parallel", "memory-write", "memory-query"}:
        raise ValueError(
            f"Step type '{step_type}' is not supported by the runtime executor."
        )

    data["type"] = step_type
    data.setdefault("dependsOn", data.get("dependsOn") or [])
    raw_input = data.get("input")
    data["input"] = raw_input if isinstance(raw_input, dict) else {}
    if step_type == "agent":
        prompt = data.get("prompt")
        if not prompt:
            prompt = data["input"].get("prompt") or data["input"].get("text") or ""
        data["prompt"] = prompt
        required = data.get("requiredCapabilities") or data["input"].get("requiredCapabilities") or []
        data["requiredCapabilities"] = [str(item) for item in required] if isinstance(required, list) else []
        handoff = data.get("handoffContract") or data["input"].get("handoffContract")
        if isinstance(handoff, dict):
            data["handoffContract"] = handoff
    elif step_type == "tool":
        data.setdefault("action", data.get("action") or data["input"].get("action"))
    elif step_type == "condition":
        data.setdefault("expression", data.get("expression") or data["input"].get("expression") or data["input"].get("condition"))
    elif step_type == "approval":
        data.setdefault("reason", data.get("reason") or data["input"].get("reason") or f"Approval required for {data.get('name', data.get('id', 'node'))}")
        data.setdefault("objective", data.get("objective") or data["input"].get("objective"))
        metadata = data.get("metadata") or data["input"].get("metadata") or {}
        data["metadata"] = metadata if isinstance(metadata, dict) else {}
    elif step_type == "human":
        data.setdefault("instruction", data.get("instruction") or data["input"].get("instruction") or data["input"].get("prompt") or f"Human input required for {data.get('name', data.get('id', 'node'))}")
        expected = data.get("expectedInputSchema") or data["input"].get("expectedInputSchema")
        if expected is not None:
            data["expectedInputSchema"] = expected
    elif step_type == "join":
        data.setdefault("mergePolicy", data.get("mergePolicy") or data["input"].get("mergePolicy") or "all_active")
    elif step_type == "compensation":
        data.setdefault("targetNodeId", data.get("targetNodeId") or data["input"].get("targetNodeId"))
        data.setdefault("strategy", data.get("strategy") or data["input"].get("strategy") or "record")
    return data


class WorkflowRunRequest(BaseModel):
    workflowId: str
    name: str
    input: Dict[str, Any] = Field(default_factory=dict)
    steps: List[ExecutableWorkflowStep]
    edges: List[ExecutableEdge] = Field(default_factory=list)

    @model_validator(mode="before")
    @classmethod
    def normalize_payload(cls, data: Any) -> Any:
        if not isinstance(data, dict):
            return data
        normalized = dict(data)
        normalized_steps = []
        for raw_step in normalized.get("steps", []):
            if isinstance(raw_step, dict):
                normalized_steps.append(_normalize_step_payload(raw_step))
            else:
                normalized_steps.append(raw_step)
        normalized["steps"] = normalized_steps
        return normalized

    @field_validator("steps")
    @classmethod
    def validate_step_count(cls, v: list) -> list:
        if len(v) > _MAX_STEPS:
            raise ValueError(
                f"Workflow exceeds maximum step count ({len(v)} > {_MAX_STEPS}). "
                "Reduce the number of steps or raise MAX_WORKFLOW_STEPS."
            )
        return v

    @field_validator("edges")
    @classmethod
    def validate_edge_count(cls, v: list) -> list:
        if len(v) > _MAX_EDGES:
            raise ValueError(
                f"Workflow exceeds maximum edge count ({len(v)} > {_MAX_EDGES}). "
                "Reduce the number of edges or raise MAX_WORKFLOW_EDGES."
            )
        return v


class WorkflowResumeRequest(BaseModel):
    runId: str
    workflowId: str
    name: str
    input: Dict[str, Any] = Field(default_factory=dict)
    steps: List[ExecutableWorkflowStep]
    edges: List[ExecutableEdge] = Field(default_factory=list)
    completedNodes: List[CompletedNode]
    checkpointId: Optional[str] = None

    @model_validator(mode="before")
    @classmethod
    def normalize_payload(cls, data: Any) -> Any:
        if not isinstance(data, dict):
            return data
        normalized = dict(data)
        normalized_steps = []
        for raw_step in normalized.get("steps", []):
            if isinstance(raw_step, dict):
                normalized_steps.append(_normalize_step_payload(raw_step))
            else:
                normalized_steps.append(raw_step)
        normalized["steps"] = normalized_steps
        return normalized


class ApprovalContinuationRequest(BaseModel):
    """
    Python-owned approval continuation payload.
    Carries all state needed for Python to advance workflow execution
    after an approval node has been decided approved.
    Python decides the resulting execution snapshot — TS projects it only.
    """
    runId: str
    nodeId: str
    workflowId: str
    name: str
    input: Dict[str, Any] = Field(default_factory=dict)
    steps: List[ExecutableWorkflowStep]
    edges: List[ExecutableEdge] = Field(default_factory=list)
    completedNodes: List[CompletedNode]
    approvedBy: Optional[str] = None
    note: Optional[str] = None

    @model_validator(mode="before")
    @classmethod
    def normalize_payload(cls, data: Any) -> Any:
        if not isinstance(data, dict):
            return data
        normalized = dict(data)
        normalized_steps = []
        for raw_step in normalized.get("steps", []):
            if isinstance(raw_step, dict):
                normalized_steps.append(_normalize_step_payload(raw_step))
            else:
                normalized_steps.append(raw_step)
        normalized["steps"] = normalized_steps
        return normalized


class HumanInputContinuationRequest(BaseModel):
    """
    Python-owned human-input continuation payload.
    Carries all state needed for Python to advance workflow execution
    after a human node has received its input.
    Python decides the resulting execution snapshot — TS projects it only.
    """
    runId: str
    nodeId: str
    workflowId: str
    name: str
    input: Dict[str, Any] = Field(default_factory=dict)
    steps: List[ExecutableWorkflowStep]
    edges: List[ExecutableEdge] = Field(default_factory=list)
    completedNodes: List[CompletedNode]
    humanInput: Dict[str, Any]
    actorId: Optional[str] = None

    @model_validator(mode="before")
    @classmethod
    def normalize_payload(cls, data: Any) -> Any:
        if not isinstance(data, dict):
            return data
        normalized = dict(data)
        normalized_steps = []
        for raw_step in normalized.get("steps", []):
            if isinstance(raw_step, dict):
                normalized_steps.append(_normalize_step_payload(raw_step))
            else:
                normalized_steps.append(raw_step)
        normalized["steps"] = normalized_steps
        return normalized
