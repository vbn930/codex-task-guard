---
name: task-guard
description: Manage quota-sensitive, long, or multi-phase Codex coding tasks with authoritative quota snapshots, dependency-aware phases, measured usage, consistent quota pauses, same-thread resume, and optional Discord notifications. Use before substantial implementation phases, after rate-limit errors, or when resuming a task-guard checkpoint; do not use for small one-step edits or quota questions unrelated to task lifecycle.
metadata:
  short-description: Use fresh quota snapshots for task phases
---

# Task Guard

Treat one user task as one Codex thread and final goal. A phase is the smallest dependency-safe unit executed inside that task. A quota reset is a pause/resume boundary, never a task boundary. Do not create a new thread, mark the task complete, or discard its goal merely because quota is low or an implementation phase failed.

This workflow is agent-driven rather than a deterministic lifecycle hook. Follow the checkpoints explicitly; do not claim that the JavaScript utilities detect task starts or pause Codex by themselves.

Resolve `<skill-root>` to the directory containing this file. Run utilities as:

```text
node <skill-root>/scripts/task-guard.mjs <command>
```

## Before substantial work

On first use, after installation, or when quota repeatedly returns `UNKNOWN`, run `doctor --project <project>`. Required errors must be resolved before relying on automatic quota resume. A Discord warning is non-blocking because notifications are optional.

Run `quota` at task start, before each substantial implementation phase, after a phase when more substantial work remains, and immediately after a rate-limit error. Treat only `freshness: AUTHORITATIVE` as current. `STALE` is last-known context and `UNAVAILABLE` is a failed refresh; neither may drive a critical decision.

Before implementation, decompose the task into ordered, dependency-aware phases. Read [references/phase-input.md](references/phase-input.md). Keep phases independently finishable and small enough to checkpoint between them. Do not redefine the task merely to fit the current quota window.

A confirmed rate-limit rejection from Codex always enters the pause flow, even when the follow-up quota read is healthy or unavailable. Use that read only to capture verified reset metadata; never use it to override the rejection and continue working.

When beginning a new substantial task, send `TASK_STARTED` once before implementation. The notify command refreshes JIT and derives five-hour quota/reset from its snapshot; do not carry percentage/reset strings from an earlier read.

Interpret only windows whose `window_duration_minutes` is exactly `300` or `10080`. An unavailable window stays unavailable. Never relabel the weekly window as five-hour quota, infer reset times, or invent missing percentages.

Use `budget evaluate` with the current dependency-ready phases, an explicit safety reserve, and measured history. Run only the selected phase. If no measured cohort exists, the result is `INSUFFICIENT_HISTORY`; do not invent a model multiplier or claim the phase is safe. Split the phase further, run only a deliberately bounded calibration phase when justified, or pause.

## Measure each phase

Before changing files for a selected phase, run `phase start --project <project> --input <phase.json>`. Supply the actual active `model`, `reasoning_effort`, `phase_type`, and optional plan partition. If the active runtime values cannot be verified, use `unknown`; never substitute config defaults while claiming they are active session values.

Finish the phase at a coherent boundary. When more work remains, prefer `phase finish --project <project> --phase-id <id> --input <decision.json>` so one authoritative after snapshot is shared by history, predictor, next-phase decision, and any quota-bearing notification. Use plain `phase complete` only when no immediate budget decision is needed. Use `concurrent_usage: false` only when no other shared-pool work ran.

The estimator matches exact plan/model/reasoning/phase-type cohorts and uses the highest valid observed delta as its conservative V1 upper cost. It does not extrapolate across models or plans, apply official message ranges as task-cost formulas, or use an invented percentile. After every completed phase, re-evaluate the pending phases against the newly observed quota.

## Pause for quota

When no dependency-ready phase with measured cost fits the available budget, and further safe decomposition is not useful:

1. Read [references/checkpoint-input.md](references/checkpoint-input.md) and run `pause prepare`. It refreshes once, saves the checkpoint first, then uses the same snapshot for registry, Discord, and returned `automation_schedule`. Do not separately reuse an earlier quota/reset.
2. Notification failure is non-fatal, but an unavailable authoritative five-hour reset means automatic scheduling must not proceed.
3. If the Codex app current-thread heartbeat automation tool is available and a local run can keep the host powered on, the desktop app running, and the project available on disk, schedule this same thread with its first wake at or just after the verified five-hour reset. Its prompt must recheck quota, verify the checkpoint, clean up this heartbeat, resume the checkpoint, continue the exact next action, and avoid creating a new task. Capture the returned automation ID as `heartbeat_automation_id`, add it to the same state JSON, and run `checkpoint save` again. If the ID cannot be persisted, delete or disable the automation and use the fallback below. Do not invent an automation interface or schedule.
4. If automation is unavailable, leave `resume_after` and the checkpoint path in the registry, tell the user how to resume this same thread, and stop the current execution.

The paused state is `PAUSED_FOR_QUOTA`, not completed or failed.

## Resume

Run `checkpoint verify` before doing more work. If it reports `REPOSITORY_STATE_CHANGED`, inspect `git status`, `git diff`, and the checkpoint; reconcile deliberately or send `TASK_BLOCKED`. Never overwrite external changes or trust the checkpoint over the filesystem.

Immediately after wake, refresh quota, then verify the checkpoint and repository. If verification succeeds, delete the stored heartbeat, run `checkpoint resume`, and send `TASK_RESUMED`; the notify command refreshes JIT and derives quota/reset rather than reusing the wake value. Use the actual first `exact_next_actions` entry as `resume_point`.

## Complete or block

Declare completion only after implementation, required tests, original acceptance criteria, and task-specific blockers are all resolved. If the checkpoint contains `heartbeat_automation_id`, delete or disable that automation and report any cleanup failure. Run `checkpoint complete` to remove the active checkpoint and registry entry. Only after cleanup succeeds, send `TASK_COMPLETED` with `validation`, the verified reset count formatted like `1 × 5h window` as `quota_used`, `checkpoint` set to `Cleared`, and `status`. Use `Not required` instead of `Cleared` when no checkpoint existed. Start a later task in a new thread.

For a genuine blocker, delete or disable any stored heartbeat automation, then send `TASK_BLOCKED` with `reason`, `detected`, `action_required`, `checkpoint`, and `status`. Do not clean the checkpoint while the original task remains incomplete.

## Security and failure rules

- Read Discord credentials only from `CODEX_DISCORD_WEBHOOK_URL`; never put them in input JSON, checkpoints, source, logs, or messages.
- If Discord is disabled or fails, continue the task lifecycle and report only the notification result.
- If checkpoint writing fails, the pause failed; retain the current task state and report the error.
- If checkpoint save reports `ACTIVE_CHECKPOINT_EXISTS`, do not overwrite it. Resume or complete the existing task, or ask the user which task should retain the repository checkpoint.
- If quota reading fails, report `UNKNOWN`; do not convert the failure into `SAFE` or `LOW`.
- Do not consume rate-limit reset credits. This skill is read-only with respect to account quota.
