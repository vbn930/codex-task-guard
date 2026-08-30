# Checkpoint and notification inputs

Use a temporary JSON file or `--input -`. Do not store secrets in either payload.

## Checkpoint state

Required fields are `task_id`, `task_description`, `status`, and at least one `exact_next_actions` entry. Use `PAUSED_FOR_QUOTA` for quota pauses.

```json
{
  "task_id": "task-24",
  "task_description": "Implement Discord integration",
  "status": "PAUSED_FOR_QUOTA",
  "completed": ["Webhook config loader implemented"],
  "current_state": ["Resume notification is not connected"],
  "decisions": ["Webhook URL comes only from the environment"],
  "tests": [{ "command": "npm test", "result": "passed" }],
  "known_issues": [],
  "remaining_work": ["Connect the resume event"],
  "exact_next_actions": ["Run the integration test"],
  "quota": {
    "five_hour": {
      "available": true,
      "remaining_percent": 5,
      "reset_at": "2026-08-31T12:00:00.000Z"
    }
  },
  "resume_after": "2026-08-31T12:00:00.000Z",
  "thread_reference": "current",
  "heartbeat_automation_id": "automation-id-returned-by-codex"
}
```

Save it with:

```text
node <skill-root>/scripts/task-guard.mjs checkpoint save --project <project> --input <file>
```

The utility writes `<project>/.codex/task-guard-checkpoint.md`, adds it to the repository-local Git exclude file, and stores minimal lookup metadata under the Codex home directory.

Omit `heartbeat_automation_id` when no wake-up automation was created. When an automation is created after the initial save, add its returned ID to the same state JSON and save again. On a verified resume, mark the task as working with:

```text
node <skill-root>/scripts/task-guard.mjs checkpoint resume --project <project> --task-id <task-id>
```

## Discord event payload

Supported events are `TASK_STARTED`, `QUOTA_PAUSED`, `TASK_RESUMED`, `TASK_COMPLETED`, and `TASK_BLOCKED`.

```json
{
  "project": "project-name",
  "task": "Task 24",
  "thread": "current",
  "reason": "5-hour quota low",
  "checkpoint": "Saved",
  "reset": "2026-08-31T12:00:00.000Z",
  "status": "Waiting for quota reset"
}
```

Omit fields that do not apply to the event.
