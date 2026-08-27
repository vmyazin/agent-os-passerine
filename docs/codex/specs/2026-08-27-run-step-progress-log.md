# Run step progress log

Status: Approved design

## Context

The run detail page currently reduces each step to its key, terminal state, and model. During a long model session that leaves the operator unable to distinguish setup, request delivery, model work, tool activity, response collection, validation, and retry recovery.

## Goals

- Give every recorded step a concise, current one-line activity sentence.
- Let the operator expand a step to inspect its chronological operational history.
- Keep the history durable across refreshes and terminal run states.
- Record only bounded, allowlisted operational phases. Never record model text, hidden reasoning, tool arguments, tool results, credentials, or raw provider payloads.
- Reuse the run page's existing live refresh so new progress appears without a new client transport.

## Non-goals

- Streaming tokens or chain-of-thought.
- A general-purpose log viewer, search, download, or retention system.
- A schema migration or Trigger.dev metadata channel.
- Changing retry policy, model behavior, workflow outputs, or the sanitized run timeline outside of hiding duplicate step-progress entries.

## Scope and implementation boundary

- `packages/adapters/src/trigger/workflow.ts`: emit deterministic `step.progress` domain events at meaningful lifecycle and provider-event boundaries inside `runAgentStep` and `consumeEvents`. Persist only `stepRunId`, `stepKey`, `attempt`, `phase`, and a fixed human-readable message.
- Repetitive provider streams retain at most three samples per provider event type and attempt, keeping the operational history below the existing run-event page cap without dropping lifecycle milestones.
- `apps/control-plane/src/application/control-plane-service.ts`: allowlist and group `step.progress` payloads into the matching step projection, capped at the newest 100 entries per attempt. Exclude those entries from the general sanitized timeline because the step log is their canonical presentation.
- `apps/control-plane/src/ui/run-step-timeline.tsx`: render native expandable `details` rows with the latest sentence visible at rest and the chronological event list inside.
- `apps/control-plane/app/runs/[id]/page.tsx` and `app/globals.css`: adopt and style the component without changing page data loading or refresh behavior.

The implementation must not expose runtime event payloads, source content, prompts, model responses, tool input/output, or secrets. Event identity must remain deterministic so durable workflow replay does not duplicate progress.

## Acceptance criteria

- A running step can visibly move through messages such as “Sending request to the model” and “Waiting on response.”
- Clicking or keyboard-activating the step expands a timestamped, ordered history.
- Completed and failed attempts retain their history.
- A transient attempt records its retry transition and the next attempt has its own history.
- Tests prove provider payload content is absent from persisted and projected progress.
