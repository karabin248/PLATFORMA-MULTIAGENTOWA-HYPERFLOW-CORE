# Orchestration scaffold patch

This patch intentionally adds only the minimum orchestration surface needed to turn the current platform into a credible merge base for a later full multi-agent orchestration migration.

## Added platform seams

- Workflow persistence tables
- Workflow run persistence
- Workflow node persistence
- Approval queue persistence
- Checkpoint persistence
- TS routes for workflows and approvals
- Python core client hooks for `/v1/workflow/run` and `/v1/workflow/resume`

## Deliberate non-goals

- No second execution authority in TypeScript
- No planner migration from ai-orchestra yet
- No worker marketplace/runtime transplant yet
- No UI migration yet
- No OpenAPI regeneration yet

## Why this patch exists

The current platform already has the right deployment shell, auth boundary, DB, and operator-facing structure.
What it lacked was an orchestration persistence/model surface.
This patch adds that surface without changing the canonical rule:

- Python core owns execution semantics
- TypeScript owns public API, persistence, and operator lifecycle
