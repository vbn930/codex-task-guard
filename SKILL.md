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

Use `phase prepare --project <project> --input <phase-plan.json>` with the current dependency-ready phases, an explicit safety reserve, and measured history. It refreshes once, evaluates the budget, and records the selected phase start from that same snapshot. Run only `decision.selected_phase_id`. If no phase fits, it returns `phase_start: null` and creates no active phase. `budget evaluate` and `phase start` remain available for diagnostic/manual use, but do not compose them as the default automated workflow because separate commands do not form one lifecycle boundary. If no measured cohort exists, the result is `INSUFFICIENT_HISTORY`; do not invent a model multiplier or claim the phase is safe. Split the phase further, run only a deliberately bounded calibration phase when justified, or pause.

## Measure each phase

Each candidate passed to `phase prepare` must include the start metadata: `task_id`, `phase_id`, `model`, `reasoning_effort`, `phase_type`, and optional plan partition. Supply the actual active runtime values. If they cannot be verified, use `unknown`; never substitute config defaults while claiming they are active session values.

Finish the phase at a coherent boundary. When more work remains, prefer `phase finish --project <project> --phase-id <id> --input <decision.json>` so one authoritative after snapshot is shared by history, predictor, next-phase decision, and any quota-bearing notification. Use plain `phase complete` only when no immediate budget decision is needed. Use `concurrent_usage: false` only when no other shared-pool work ran.

The estimator matches exact plan/model/reasoning/phase-type cohorts. Fewer than 20 valid samples use the highest observed delta. At 20 samples, it uses nearest-rank P90 from the latest 50 valid samples plus one percentage point. The ledger compacts after 2,500 records to at most 2,000, prioritizing the latest 50 records per exact cohort. It does not extrapolate across models or plans or apply official message ranges as task-cost formulas. After every completed phase, re-evaluate the pending phases against the newly observed quota.

## Pause for quota

When no dependency-ready phase with measured cost fits the available budget, and further safe decomposition is not useful:

1. Read [references/checkpoint-input.md](references/checkpoint-input.md) and run `pause prepare`. It attempts one refresh and always attempts the checkpoint save. An authoritative verified five-hour reset is required only for `automation_schedule`, never for preserving task state.
2. The same pause snapshot drives checkpoint, registry, and Discord. If it is `UNAVAILABLE`, any last-known snapshot remains stale context, `resume_after` is null, Discord reports quota unavailable, and `resume_mode` is `MANUAL`. Notification failure is non-fatal.
3. Only when `resume_mode` is `AUTOMATION_ELIGIBLE`, the local host is viable, a concrete current-thread ID is known, and the Codex app exposes heartbeat `create` plus ID-based `view`, create `kind: "heartbeat"` with `destination: "thread"` and that concrete target. The literal `current` is not a concrete ID; if the runtime cannot expose/read back the binding, use manual fallback. Never use detached `cron` as the same-thread fallback.
4. Record `CREATE_REQUESTED`; a create request, an automation card, and an ID are not verification. In particular:

   ```text
   Rendered automation card != scheduled automation
   Create request != persisted automation
   Automation ID != verified automation
   VERIFIED requires read-back
   ```

5. If create returns a real automation ID, call `mcp__codex_app__automation_update({ id, mode: "view" })`. Retry that read only two or three times with short bounded delays so asynchronous persistence can settle; do not recreate after the first read miss.
6. Keep raw create/view results only in memory or stdin. Pipe the operation transcript to `automation verify --input -`; the Node verifier, not the agent, derives the sanitized state. It requires the read-back ID to equal the requested ID, plus logical name, `kind: heartbeat`, active status, matching reset/wake semantics, and matching concrete thread binding. Compare the prompt when the view exposes it. A missing ID is `ID_UNVERIFIED`; a different ID is `ID_MISMATCH`; unreadable target binding stays below `VERIFIED`.
7. A UI-only, blank, timeout, or otherwise ID-less result enters `RECONCILING`; it is never immediate success and never an immediate create retry.
8. Because the tool exposes no list/search API, Windows may inspect `%USERPROFILE%\.codex\automations` read-only for reconciliation. Match recent candidates using name, prompt, kind, thread, schedule, and request time. Never edit TOML. Reconciliation I/O failure is terminal manual fallback, not an uncaught error.
9. Zero high-confidence filesystem candidates means `ABSENT`. Exactly one yields an ID that still must pass tool `view`. Multiple candidates are `AMBIGUOUS`; select none and use manual fallback. Filesystem evidence alone can never produce `VERIFIED`.
10. Retry create at most once, for a maximum of two create attempts, and only after repeated explicit `NOT_FOUND` plus reconciliation establish absence. `UNPARSEABLE_VIEW`, timeout/transport ambiguity, tool/schema/permission/non-local structural failures, mismatched persisted fields, and ambiguous candidates never authorize create retry. A recurrence can be accepted only when it is provably single-occurrence (`COUNT=1`) and its first wake is within zero to five minutes after the reset; reject every rule that can repeat.
11. After inspecting the sanitized verifier output, pipe the same transient transcript to `pause finalize --input -`. Finalization re-runs the Node verifier, rejects hand-authored `VERIFIED` booleans, narrow-patches only sanitized `resume_automation` state, and then sends the final Discord pause status. `checkpoint automation set` cannot set `VERIFIED`.
12. Only a fully verified result uses `resume_mode: AUTOMATION` and “Same-thread automation verified”. Every other terminal result uses `resume_mode: MANUAL`; UI rendering alone is reported as not persisted/verified.
13. If update/delete payloads are not explicitly known in the current runtime, do not guess cleanup calls. Preserve the automation ID and `cleanup_required` state for later manual/agent cleanup.
14. Stop execution after the final checkpoint patch and notification.

The production state meanings are distinct: `CREATE_REQUESTED`, `UI_RENDERED`, `ID_RECEIVED`, `PERSISTED`, and `VERIFIED` are not aliases. `VERIFIED` requires read-back. Raw tool results must not be saved in a transcript file, checkpoint, registry, docs, or logs. If a checkpoint narrow patch reports `checkpoint_updated: true`, `registry_updated: false`, and `recovery_required: true`, treat the checkpoint as authoritative and run `checkpoint registry repair`; do not repeat automation creation.

The paused state is `PAUSED_FOR_QUOTA`, not completed or failed.

## Resume

After wake, delete or disable the stored heartbeat through the Codex app and run `resume prepare --project <project> --task-id <task-id> --input <resume.json>` with `heartbeat_cleanup_confirmed: true` only after that external cleanup succeeds. The resume lifecycle reads and validates the checkpoint first, returns `ALREADY_RESUMED` immediately for a duplicate wake, verifies repository state, then refreshes quota once and validates any optional budget input from that snapshot. If quota is unavailable it preserves the pause and returns `QUOTA_UNAVAILABLE`; otherwise it clears heartbeat metadata, marks the automation `EXECUTED`, transitions to working, and sends `TASK_RESUMED`. It derives `resume_point` from the checkpoint's first `exact_next_actions` entry; do not supply a stale copy.

If repository verification or optional budget validation fails, inspect the input, `git status`, `git diff`, and the checkpoint. The lifecycle performs no cleanup or working transition and does not send `TASK_RESUMED`; repository mismatch returns `TASK_BLOCKED` and invalid input throws before mutation. Never overwrite external changes or trust the checkpoint over the filesystem. Use `resume prepare` as the only normal resume interface; `checkpoint verify` and standalone `notify TASK_RESUMED` remain manual/diagnostic commands.

## Snapshot ownership boundaries

- Task start: the standalone `notify TASK_STARTED` wrapper refreshes JIT and passes that snapshot to Discord.
- Phase prepare: refresh once, then budget decision and phase start use the same snapshot.
- Phase finish: refresh once, then measurement, history, next decision, and optional Discord use the same snapshot.
- Quota pause: attempt refresh once, always attempt checkpoint save, then use that same result for Discord and, only with a verified reset, scheduling.
- Resume: refresh once, then verification, resume, TASK_RESUMED, and optional next decision use the same snapshot.

Lifecycle functions own quota refresh. Discord formatting and transport never refresh quota. Within one boundary, consumers must accept the owned snapshot rather than reading quota again.

## Complete or block

Declare completion only after implementation, required tests, original acceptance criteria, and task-specific blockers are all resolved. If the checkpoint contains `heartbeat_automation_id`, delete or disable that automation and report any cleanup failure. Run `checkpoint complete` to remove the active checkpoint and registry entry. Only after cleanup succeeds, send `TASK_COMPLETED` with `validation`, the verified reset count formatted like `1 × 5h window` as `quota_used`, `checkpoint` set to `Cleared`, and `status`. Use `Not required` instead of `Cleared` when no checkpoint existed. Start a later task in a new thread.

For a genuine blocker, delete or disable any stored heartbeat automation, then send `TASK_BLOCKED` with `reason`, `detected`, `action_required`, `checkpoint`, and `status`. Do not clean the checkpoint while the original task remains incomplete.

## Security and failure rules

- Read Discord credentials only from `CODEX_DISCORD_WEBHOOK_URL`; never put them in input JSON, checkpoints, source, logs, or messages.
- If Discord is disabled or fails, continue the task lifecycle and report only the notification result.
- If checkpoint writing fails, the pause failed; retain the current task state and report the error.
- If checkpoint succeeds but the derived registry write fails, do not repeat the lifecycle action. Report the structured partial result and repair the registry from the authoritative checkpoint.
- If checkpoint save reports `ACTIVE_CHECKPOINT_EXISTS`, do not overwrite it. Resume or complete the existing task, or ask the user which task should retain the repository checkpoint.
- If quota reading fails, report `UNKNOWN`; do not convert the failure into `SAFE` or `LOW`.
- Do not consume rate-limit reset credits. This skill is read-only with respect to account quota.

`PERSISTENCE VERIFIED != FUTURE EXECUTION GUARANTEED`. Persistence verification does not claim that the Codex Desktop scheduler will deliver the future heartbeat.
