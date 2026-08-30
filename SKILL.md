---
name: task-guard
description: Manage quota-sensitive, long, or multi-phase Codex coding tasks by reading Codex subscription rate-limit windows, checkpointing quota pauses, resuming the same task and thread, and sending optional Discord webhook notifications. Use before substantial implementation phases, after rate-limit errors, or when resuming a task-guard checkpoint; do not use for small one-step edits or quota questions unrelated to task lifecycle.
metadata:
  short-description: Guard long Codex tasks across quota resets
---

# Task Guard

Treat one user task as one Codex thread. A quota reset is a pause/resume boundary, never a task boundary. Do not create a new thread, mark the task complete, or discard its goal merely because quota is low or an implementation phase failed.

Resolve `<skill-root>` to the directory containing this file. Run utilities as:

```text
node <skill-root>/scripts/task-guard.mjs <command>
```

## Before substantial work

Run `quota` at task start, before each substantial implementation phase, after a phase when more substantial work remains, and immediately after a rate-limit error. This uses Codex app-server and does not send a model prompt.

A confirmed rate-limit rejection from Codex always enters the pause flow, even when the follow-up quota read is healthy or unavailable. Use that read only to capture verified reset metadata; never use it to override the rejection and continue working.

When beginning a new substantial task, send `TASK_STARTED` once after the initial quota read and before implementation. Do not repeat it at each phase.

Interpret only windows whose `window_duration_minutes` is exactly `300` or `10080`. An unavailable window stays unavailable. Never relabel the weekly window as five-hour quota, infer reset times, or invent missing percentages.

Classify the next decision as `SAFE`, `CAUTION`, `LOW`, or `UNKNOWN` using both remaining quota and the size/risk of the next phase. Do not use a fixed percentage alone. Small compile fixes or a bounded test rerun may continue with less quota than an architecture change, multi-file refactor, new subsystem, or integration cycle. Use `UNKNOWN` when the relevant quota cannot be read; state the uncertainty rather than claiming safety.

## Pause for quota

When quota is insufficient for the next substantial phase:

1. Read [references/checkpoint-input.md](references/checkpoint-input.md), create the state JSON in a temporary location, and run `checkpoint save`. Do not report a successful pause unless the command exits successfully.
2. Run `notify QUOTA_PAUSED` with a non-secret event JSON. Notification failure is non-fatal.
3. If the Codex app current-thread heartbeat automation tool is available, schedule this same thread with its first wake at or just after the verified five-hour reset. Its prompt must recheck quota, verify the checkpoint, clean up this heartbeat, resume the checkpoint, continue the exact next action, and avoid creating a new task. Capture the returned automation ID as `heartbeat_automation_id`, add it to the same state JSON, and run `checkpoint save` again. If the ID cannot be persisted, delete or disable the automation and use the fallback below. Do not invent an automation interface or schedule.
4. If automation is unavailable, leave `resume_after` and the checkpoint path in the registry, tell the user how to resume this same thread, and stop the current execution.

The paused state is `PAUSED_FOR_QUOTA`, not completed or failed.

## Resume

Run `checkpoint verify` before doing more work. If it reports `REPOSITORY_STATE_CHANGED`, inspect `git status`, `git diff`, and the checkpoint; reconcile deliberately or send `TASK_BLOCKED`. Never overwrite external changes or trust the checkpoint over the filesystem.

When verification succeeds, read `checkpoint show`. If it contains `heartbeat_automation_id`, delete or disable that automation before continuing and report any cleanup failure. Then run `checkpoint resume --project <project> --task-id <task-id>`, send `TASK_RESUMED`, and continue from `exact_next_actions`. Keep using the same thread.

## Complete or block

Declare completion only after implementation, required tests, original acceptance criteria, and task-specific blockers are all resolved. If the checkpoint contains `heartbeat_automation_id`, delete or disable that automation and report any cleanup failure. Send `TASK_COMPLETED`, then run `checkpoint complete` to remove the active checkpoint and registry entry. Start a later task in a new thread.

For a genuine blocker, delete or disable any stored heartbeat automation, then send `TASK_BLOCKED` with the reason and required action. Do not clean the checkpoint while the original task remains incomplete.

## Security and failure rules

- Read Discord credentials only from `CODEX_DISCORD_WEBHOOK_URL`; never put them in input JSON, checkpoints, source, logs, or messages.
- If Discord is disabled or fails, continue the task lifecycle and report only the notification result.
- If checkpoint writing fails, the pause failed; retain the current task state and report the error.
- If quota reading fails, report `UNKNOWN`; do not convert the failure into `SAFE` or `LOW`.
- Do not consume rate-limit reset credits. This skill is read-only with respect to account quota.
