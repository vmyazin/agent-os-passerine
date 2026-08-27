Refer to AGENTS.md for the agent instructions.

## Auto-load routing

- Project import, repository trust, source identity, or commit browsing → first
  read `docs/architecture/project-sources.md`, because the import registry grants
  inspection only and must not be mistaken for runtime or publication authority.
- Operator preferences, timezone selection, or UI timestamp formatting → first
  read `docs/codex/specs/2026-08-27-user-timezone-preference.md`, because these
  settings are user-scoped database records and must not leak into project YAML.

<!-- TRIGGER.DEV SKILLS START -->

## Trigger.dev agent skills

This project has Trigger.dev agent skills installed in `.claude/skills/`. Before writing or changing Trigger.dev code (background tasks, scheduled tasks, realtime, or chat.agent AI agents), load the most relevant skill: `trigger-realtime-and-frontend`.
<!-- TRIGGER.DEV SKILLS END -->
