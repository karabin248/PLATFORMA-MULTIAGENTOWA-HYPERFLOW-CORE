from __future__ import annotations

from collections import deque
from typing import Dict, Iterable, List, Sequence, Tuple

from .contracts import ExecutableEdge, ExecutableWorkflowStep


class WorkflowGraph:
    def __init__(self, step_map: Dict[str, ExecutableWorkflowStep], edges: List[ExecutableEdge], levels: List[List[str]], order: List[str]):
        self.step_map = step_map
        self.edges = edges
        self.levels = levels
        self.order = order
        self.incoming: Dict[str, List[ExecutableEdge]] = {sid: [] for sid in step_map}
        self.outgoing: Dict[str, List[ExecutableEdge]] = {sid: [] for sid in step_map}
        for edge in edges:
            self.incoming[edge.to].append(edge)
            self.outgoing[edge.from_id].append(edge)


def _materialize_edges(steps: Sequence[ExecutableWorkflowStep], edges: Sequence[ExecutableEdge]) -> List[ExecutableEdge]:
    if edges:
        return list(edges)
    known_ids = {step.id for step in steps}
    derived: List[ExecutableEdge] = []
    for step in steps:
        for dep in step.dependsOn:
            if dep not in known_ids:
                raise ValueError(f"Step '{step.id}' depends on unknown step '{dep}'.")
            derived.append(ExecutableEdge.model_validate({"from": dep, "to": step.id}))
    return derived


def build_graph(steps: Sequence[ExecutableWorkflowStep], edges: Sequence[ExecutableEdge]) -> WorkflowGraph:
    step_map: Dict[str, ExecutableWorkflowStep] = {}
    for step in steps:
        if step.id in step_map:
            raise ValueError(f"Duplicate workflow step id '{step.id}'.")
        step_map[step.id] = step

    materialized_edges = _materialize_edges(steps, edges)
    for edge in materialized_edges:
        if edge.from_id not in step_map:
            raise ValueError(f"Workflow edge references unknown source '{edge.from_id}'.")
        if edge.to not in step_map:
            raise ValueError(f"Workflow edge references unknown target '{edge.to}'.")

    in_degree = {sid: 0 for sid in step_map}
    adjacency: Dict[str, List[str]] = {sid: [] for sid in step_map}
    for edge in materialized_edges:
        adjacency[edge.from_id].append(edge.to)
        in_degree[edge.to] += 1

    queue: deque[str] = deque([sid for sid, degree in in_degree.items() if degree == 0])
    order: List[str] = []
    levels: List[List[str]] = []

    while queue:
        current = list(queue)
        queue.clear()
        levels.append(current)
        for sid in current:
            order.append(sid)
            for child in adjacency[sid]:
                in_degree[child] -= 1
                if in_degree[child] == 0:
                    queue.append(child)

    if len(order) != len(step_map):
        raise ValueError("Workflow has a dependency cycle.")

    return WorkflowGraph(step_map=step_map, edges=materialized_edges, levels=levels, order=order)
