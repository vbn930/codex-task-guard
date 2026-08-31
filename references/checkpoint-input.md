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
  "thread_reference": "current"
}
```

Save it with:

```text
node <skill-root>/scripts/task-guard.mjs checkpoint save --project <project> --input <file>
```

For a quota pause, wrap this object as `"checkpoint"` and the non-secret Discord fields as `"notification"`, then use `pause prepare` instead. It attempts one refresh and always attempts to save checkpoint schema v2. A refresh failure is stored as `quota_snapshot.freshness: "UNAVAILABLE"`; a cached snapshot may appear only as stale last-known context. In that case `resume_after` and `automation_schedule` are null, `resume_mode` is `MANUAL`, and Discord does not display cached quota or reset metadata as current.

When the snapshot is authoritative and has a verified 300-minute reset, `resume_mode` is `AUTOMATION_ELIGIBLE`; checkpoint, registry, `automation_intent`, and `automation_schedule` share that snapshot ID, observation time, and reset. Discord is deferred until verification is finalized. Scheduling failures are distinguished as `AUTHORITATIVE_QUOTA_REQUIRED`, `FIVE_HOUR_QUOTA_UNAVAILABLE`, or `VERIFIED_FIVE_HOUR_RESET_REQUIRED`, but none prevents checkpoint preservation.

The utility writes `<project>/.codex/task-guard-checkpoint.md`, adds it to the repository-local Git exclude file, and stores minimal lookup metadata under the Codex home directory.

Only one `WORKING` or `PAUSED_FOR_QUOTA` task may own a repository checkpoint. Saving a different `task_id` while one is active fails with `ACTIVE_CHECKPOINT_EXISTS` and leaves the first checkpoint untouched.

After the agent completes create/view/reconciliation, submit the sanitized result and final notification together:

```text
node <skill-root>/scripts/task-guard.mjs pause finalize --project <project> --task-id <task-id> --input <result.json>
```

`result.json` contains `resume_automation` plus non-secret `notification` fields. A verified state includes purpose, status, ID, attempts, verified time, target thread, resume time, snapshot ID, fingerprint, and boolean verification results. Do not include raw tool output or private fields. The narrow patch preserves quota snapshot, reset, exact next actions, task ID, thread reference, repository fingerprint, and pause metadata. `VERIFIED` is rejected unless persisted, identity, heartbeat kind, thread, schedule, and active-status checks are true.

## Resume lifecycle input

After the Codex app has deleted or disabled the stored heartbeat, run the atomic resume boundary:

```json
{
  "heartbeat_cleanup_confirmed": true,
  "notification": {
    "project": "project-name",
    "task": "Task 24",
    "checkpoint": "Verified",
    "repository": "No external changes",
    "status": "Working"
  },
  "blocked_notification": {
    "project": "project-name",
    "task": "Task 24",
    "action_required": "Review repository changes",
    "checkpoint": "Preserved",
    "status": "Blocked"
  }
}
```

```text
node <skill-root>/scripts/task-guard.mjs resume prepare --project <project> --task-id <task-id> --input <resume.json>
```

The command refreshes once, verifies checkpoint ownership and repository state, clears confirmed heartbeat metadata, marks the checkpoint working, and sends `TASK_RESUMED` from that same snapshot. It derives `resume_point` from the checkpoint. Optional `phases` and `safety_reserve_percent` use the same snapshot for an immediate next budget decision. If repository or heartbeat cleanup verification fails, it leaves the checkpoint incomplete, does not transition to `WORKING`, and returns `TASK_BLOCKED`.

## Discord event payload

Supported events are `TASK_STARTED`, `QUOTA_PAUSED`, `TASK_RESUMED`, `TASK_COMPLETED`, and `TASK_BLOCKED`.

```json
{
  "project": "project-name",
  "task": "Task 24",
  "reason": "5-hour quota low",
  "five_hour_remaining": "5%",
  "checkpoint": "Saved",
  "reset": "2026-08-31T12:00:00.000Z",
  "resume": "Same-thread automation verified",
  "automation": "Verified · Attempt 1/2",
  "next_wake": "2026-08-31T12:00:00.000Z",
  "status": "Waiting for quota reset"
}
```

`reset` accepts an ISO 8601 timestamp and is rendered as localized absolute and relative Discord timestamps. Omit fields that do not apply to the event. Use these event-specific fields in addition to `project` and `task`:

| Event | Fields |
|---|---|
| `TASK_STARTED` | `thread`, `quota`, `reset`, `status` |
| `QUOTA_PAUSED` | `reason`, `five_hour_remaining`, `reset`, `checkpoint`, `resume`, `automation`, `next_wake`, `status` |
| `TASK_RESUMED` | `quota`, `reset`, `checkpoint`, `repository`, `resume_point`, `status` |
| `TASK_COMPLETED` | `validation`, `quota_used`, `checkpoint`, `status` |
| `TASK_BLOCKED` | `reason`, `detected`, `action_required`, `checkpoint`, `status` |

For `TASK_RESUMED`, copy `resume_point` from the checkpoint's actual `exact_next_actions`. For `TASK_COMPLETED`, `quota_used` is displayed as **Quota Resets** and should use a compact value such as `1 × 5h window`; set `checkpoint` to `Cleared` only after checkpoint cleanup succeeds.
