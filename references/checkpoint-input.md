# Checkpoint and notification inputs

Use a temporary JSON file or `--input -`. Do not store secrets in either payload.

## Checkpoint state

Required fields are `task_id`, `task_description`, `status`, and at least one `exact_next_actions` entry. Use `PAUSED_FOR_QUOTA` for quota pauses.

Checkpoint input uses an explicit durable-field allowlist. Unknown top-level fields are rejected instead of being silently persisted. The accepted caller fields are:

```text
task_id                 task_description        status
completed               current_state           decisions
tests                   known_issues            remaining_work
exact_next_actions      pause_reason            quota
quota_snapshot          resume_after            thread_reference
resume_mode             resume_automation       heartbeat_automation_id
schema_version          paused_at               resumed_at
repository
```

`schema_version`, `paused_at`, and `repository` are generated or refreshed by `checkpoint save`, but remain accepted so a checkpoint returned by `checkpoint show` can be safely re-saved. Supported durable task statuses are `WORKING` and `PAUSED_FOR_QUOTA`; legacy casing is normalized on write. Unsupported statuses and fields fail before repository state is written. Credential-like keys and raw automation evidence remain recursively forbidden even when nested inside an allowed field.

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
  "thread_reference": "thread-concrete-id"
}
```

Save it with:

```text
node <skill-root>/scripts/task-guard.mjs checkpoint save --project <project> --input <file>
```

For a quota pause, wrap this object as `"checkpoint"` and the non-secret Discord fields as `"notification"`, then use `pause prepare` instead. It attempts one refresh and always attempts to save checkpoint schema v2. A refresh failure is stored as `quota_snapshot.freshness: "UNAVAILABLE"`; a cached snapshot may appear only as stale last-known context. In that case `resume_after` and `automation_schedule` are null, `resume_mode` is `MANUAL`, and Discord does not display cached quota or reset metadata as current.

When the snapshot is authoritative, has a verified 300-minute reset strictly after `observed_at`, and `thread_reference` is a concrete runtime thread ID, `resume_mode` is `AUTOMATION_ELIGIBLE`; checkpoint, registry, `automation_intent`, and `automation_schedule` share that snapshot ID, observation time, and reset. The logical literal `current` is not a concrete ID and yields `CONCRETE_THREAD_ID_REQUIRED`. Discord is deferred until verification is finalized. Scheduling failures are distinguished as `AUTHORITATIVE_QUOTA_REQUIRED`, `FIVE_HOUR_QUOTA_UNAVAILABLE`, `VERIFIED_FIVE_HOUR_RESET_REQUIRED`, or `CONCRETE_THREAD_ID_REQUIRED`, but none prevents checkpoint preservation.

The utility writes `<project>/.codex/task-guard-checkpoint.md`, adds it to the repository-local Git exclude file, and stores minimal lookup metadata under the Codex home directory.

Only one `WORKING` or `PAUSED_FOR_QUOTA` task may own a repository checkpoint. Saving a different `task_id` while one is active fails with `ACTIVE_CHECKPOINT_EXISTS` and leaves the first checkpoint untouched.

Task-state transitions are defined by one contract. A quota pause records a single matching thread, reset, snapshot, resume mode, and automation tuple. Verified automation cannot be attached when those values differ from the paused intent. Resume requires repository verification and any required heartbeat cleanup confirmation, then performs one local transition that clears heartbeat metadata, changes `VERIFIED` to `EXECUTED`, and sets the task to `WORKING`.

After the agent completes create/view/reconciliation, keep the raw tool results transient and send the operation transcript through stdin to the Node verifier:

```json
{
  "expected": { "...": "the automation_intent returned by pause prepare" },
  "transcript": {
    "operations": [
      { "operation": "create", "result": { "automation_id": "automation-id" } },
      { "operation": "view", "id": "automation-id", "result": { "...": "raw view result" } }
    ]
  }
}
```

```text
node <skill-root>/scripts/task-guard.mjs automation verify --input -
```

Do not write this transcript to disk or copy it into logs. The command returns only a sanitized state. A retry/reconciliation transcript adds operations in the exact order consumed: `view`, `reconcile`, a second `create`, and another `view` only when policy permits them. Represent tool errors with a non-secret `error.code` and minimal `error.message`.

Then submit the same transient `automation_transcript` plus the final non-secret notification. Finalization intentionally re-runs the verifier rather than trusting caller-authored booleans:

```text
node <skill-root>/scripts/task-guard.mjs pause finalize --project <project> --task-id <task-id> --input -
```

The stdin object contains `automation_transcript` plus non-secret `notification` fields. Raw evidence is processed in memory and is never returned or stored. The derived verified state includes purpose, status, ID, attempts, verified time, `verification_source: READBACK`, target thread, resume time, snapshot ID, fingerprint, and boolean verification results including `id_match`. The narrow patch preserves quota snapshot, reset, exact next actions, task ID, thread reference, repository fingerprint, and pause metadata. `VERIFIED` is rejected unless all invariants match the existing paused intent. `checkpoint automation set` can record diagnostic non-verified states but cannot set `VERIFIED`.

If a narrow patch returns `checkpoint_updated: true`, `registry_updated: false`, and `recovery_required: true`, the checkpoint already contains the authoritative result. Do not repeat create/finalize. Repair only the derived registry:

```text
node <skill-root>/scripts/task-guard.mjs checkpoint registry repair --project <project> --task-id <task-id>
```

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

The command refreshes once, verifies checkpoint ownership/source state and repository state, and validates optional `phases` and `safety_reserve_percent` before any side effect. Only then does it clear confirmed heartbeat metadata, mark a verified automation `EXECUTED`, transition the checkpoint to working, and send `TASK_RESUMED` from the same snapshot. It derives `resume_point` from the checkpoint. If validation, repository verification, or heartbeat cleanup fails, it does not transition to `WORKING`; cleanup is not attempted before prevalidation. A second wake returns `ALREADY_RESUMED` without mutation or duplicate Discord.

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
