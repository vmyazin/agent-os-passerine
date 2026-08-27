# User timezone preference

Status: Approved design

## Context

Agent OS currently formats absolute timestamps inconsistently: some surfaces force UTC, one uses the browser timezone, and the home greeting uses US Eastern time. The Configuration page is project-scoped, but timezone is an operator preference that must remain consistent while moving between projects and devices.

## Goals

- Add a durable, authenticated user-preferences record keyed by login.
- Add an Operator time section to Configuration with a searchable IANA timezone selector, an immediate preview, and an explicit save action.
- Apply the selected timezone to every absolute date/time shown in the control-plane UI and to the time-of-day greeting.
- Preserve UTC as the default when no preference exists.
- Establish a typed table and repository boundary that can accept more user preference columns later.

## Non-goals

- Do not add locale, date-format, theme, or notification preferences.
- Do not put operator preferences into project configuration YAML.
- Do not change stored timestamps; persistence remains canonical ISO instants.
- Do not change relative elapsed-time calculations such as “10h ago.”
- Do not infer or silently save the browser timezone.

## Scope and implementation boundary

- The durable record lives in `packages/core/src/persistence.ts` and the adapter implementations under `packages/adapters/src/persistence/`, backed by a new `user_preferences` migration.
- The application boundary lives in `ControlPlaneService`; only an authenticated session may read or update its own preference through the control-plane API.
- Timezone validation and formatting live in shared UI modules under `apps/control-plane/src/ui/`. Call sites may pass the selected timezone, but must not create new ad-hoc `Intl.DateTimeFormat` instances.
- The selector lives on `apps/control-plane/app/configuration/page.tsx` as a global Operator time section, visually separate from project configuration.
- The change must not alter project configuration schemas, workflow execution, model requests, or authentication semantics.

## Acceptance criteria

- Saving `America/Sao_Paulo` creates or updates the signed-in operator’s preference and survives a page reload.
- A second login retains an independent preference.
- Invalid timezone identifiers are rejected without changing the stored preference.
- Inbox absolute timestamps, run activity times, directory dates, and the home greeting use the stored timezone.
- A missing preference renders all affected surfaces in UTC.
- Existing relative age labels continue to describe elapsed time independent of timezone.
