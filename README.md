# Codex Task Guard

`task-guard` keeps one long Codex task in one thread across quota pauses. It decomposes the goal into quota-sized phases, measures real five-hour quota consumption, selects a dependency-ready phase that fits the measured budget, saves recoverable checkpoints, and sends optional Discord notifications. This is agent-driven orchestration, not a deterministic lifecycle hook.

It is intentionally small: Node.js 20+, no runtime dependencies, no daemon, no database, no MCP server, and no Discord bot.

## Why task equals thread

A five-hour reset does not complete the user's task. The same thread keeps its task context, checkpoint, repository state, and acceptance criteria until implementation and validation are actually done. A later task starts in a new thread.

## Install

Requirements:

- Windows with Node.js 20 or newer.
- Codex CLI on `PATH`, signed in with ChatGPT.
- Git for checkpointed projects.

From this repository:

```text
node scripts/install.mjs
```

This copies the skill to `%CODEX_HOME%\skills\task-guard` or `%USERPROFILE%\.codex\skills\task-guard` and adds an idempotent Task Guard policy block to the global `AGENTS.md`. Restart Codex or start a new task so skill discovery reloads.

Then verify the local prerequisites and signed-in Codex session:

```text
node scripts/task-guard.mjs doctor --project C:\path\to\git-project
```

The command returns JSON and exits nonzero when a required check fails. An unconfigured Discord webhook is only a warning because notifications are optional.

## Commands

```text
node scripts/task-guard.mjs quota
node scripts/task-guard.mjs doctor --project C:\path\to\project
node scripts/task-guard.mjs phase start --project C:\path\to\project --input phase.json
node scripts/task-guard.mjs phase complete --project C:\path\to\project --phase-id implementation --concurrent-usage false
node scripts/task-guard.mjs phase finish --project C:\path\to\project --phase-id implementation --input decision.json
node scripts/task-guard.mjs history list --limit 100
node scripts/task-guard.mjs budget evaluate --input budget.json
node scripts/task-guard.mjs pause prepare --project C:\path\to\project --input pause.json
node scripts/task-guard.mjs checkpoint save --project C:\path\to\project --input state.json
node scripts/task-guard.mjs checkpoint verify --project C:\path\to\project
node scripts/task-guard.mjs checkpoint show --project C:\path\to\project
node scripts/task-guard.mjs checkpoint list
node scripts/task-guard.mjs checkpoint resume --project C:\path\to\project --task-id task-24
node scripts/task-guard.mjs checkpoint complete --project C:\path\to\project --task-id task-24
node scripts/task-guard.mjs notify QUOTA_PAUSED --input event.json
```

Phase and budget inputs are documented in [references/phase-input.md](references/phase-input.md). The checkpoint input shape is documented in [references/checkpoint-input.md](references/checkpoint-input.md).

## Configuration

| Variable | Purpose |
|---|---|
| `CODEX_DISCORD_WEBHOOK_URL` | Discord webhook credential; read only at notification time |
| `TASK_GUARD_NOTIFICATION_ENABLED` | Set to `false`, `0`, or `off` to disable notifications |
| `TASK_GUARD_TEST_QUOTA` | Test only: `healthy`, `low`, or `unavailable` |

If no Discord webhook is configured, notifications return `DISABLED` and every other feature continues. The webhook is never stored in the repository, checkpoint, registry, or output.

## Quota retrieval

Task Guard starts `codex app-server --listen stdio://`, performs the JSONL initialization handshake, and calls `account/rateLimits/read`. The [official OpenAI Codex source documentation](https://github.com/openai/codex/blob/main/codex-rs/app-server/README.md#7-rate-limits-chatgpt) defines `usedPercent`, `windowDurationMins`, and `resetsAt`.

Only exact 300-minute and 10,080-minute windows are labeled five-hour and weekly. Missing data produces `"available": false`; Task Guard does not guess. The app-server interface is currently marked experimental by the CLI, so a Codex update can require a compatibility change.

Every read is wrapped as a timestamped quota snapshot with `source`, `observed_at`, `snapshot_id`, availability, and freshness. A successful JIT read is `AUTHORITATIVE`; a persisted last-known snapshot is always `STALE` because Task Guard does not invent a time threshold. Refresh failure returns `UNAVAILABLE` and may include the stale `last_known_snapshot`, which is never presented as current. The metadata-only cache is `%CODEX_HOME%\task-guard\quota-snapshot.json`.

## Quota-budgeted phases

The task remains the thread-level goal. The agent decomposes it into dependency-aware phases and measures every executed phase with `phase start` and `phase complete`. `phase finish` is the critical-boundary command: it performs one JIT refresh, records the after measurement, evaluates the next phases, and optionally builds a Discord notification from that same snapshot. Measurements include before/after snapshot IDs, sources, observation times, reset identity, and concurrency quality; they contain no source contents or repository paths.

V1 estimates only an exact plan/model/reasoning/phase-type cohort. Samples are excluded when a reset crossed the phase, concurrent usage occurred or is unknown, or the integer quota reading did not move. The conservative estimate is the highest valid observed percentage-point delta. With no valid cohort, Task Guard returns `INSUFFICIENT_HISTORY` instead of inventing a cost. `budget evaluate` subtracts the caller-provided safety reserve from live five-hour quota and selects the first dependency-ready phase whose observed upper cost fits.

## Checkpoint and resume

The readable checkpoint is `<project>/.codex/task-guard-checkpoint.md`. Task Guard resolves Git's effective repository-local exclude path, including linked worktrees, and leaves tracked `.gitignore` untouched. The global registry is `%CODEX_HOME%\task-guard\index.json` or `%USERPROFILE%\.codex\task-guard\index.json` and stores only lookup metadata. Registry updates are serialized across concurrent projects. `checkpoint list` audits those paths and marks missing checkpoint files as stale.

At quota pause, `pause prepare` refreshes once and uses the same snapshot reset for checkpoint schema v2, registry, Discord, and returned automation scheduling input. Schema-v1 checkpoints and registry entries remain readable. At resume, Task Guard re-hashes HEAD, streamed staged/unstaged diffs, status, and untracked file contents without following symbolic links. A mismatch returns `REPOSITORY_STATE_CHANGED`; it never overwrites the repository.

When the Codex app exposes a current-thread heartbeat automation tool, `SKILL.md` directs the agent to use it at the verified reset time, persist its ID, and delete or disable it on resume, completion, or blockage. Otherwise the checkpoint and `resume_after` provide a manual same-thread fallback. For a scheduled run that needs local project files, [official OpenAI documentation](https://learn.chatgpt.com/docs/automations) says to keep the computer powered on and the desktop app running.

## Discord events

Supported events are `TASK_STARTED`, `QUOTA_PAUSED`, `TASK_RESUMED`, `TASK_COMPLETED`, and `TASK_BLOCKED`. Each notification uses a compact Discord Embed with an event-specific title, description, color, and fields:

| Event | Color | Primary fields |
|---|---|---|
| `TASK_STARTED` | Blurple | Project, Task, Thread, 5h Quota, Next Reset, Status |
| `QUOTA_PAUSED` | Yellow | Reason, 5h Remaining, Next Reset, Checkpoint, Resume, Status |
| `TASK_RESUMED` | Blue | 5h Quota, Next Reset, Checkpoint, Repository, Resume Point, Status |
| `TASK_COMPLETED` | Green | Validation, Quota Resets, Checkpoint, Status |
| `TASK_BLOCKED` | Red | Reason, Detected, Required Action, Checkpoint, Status |

Quota-bearing events perform a JIT refresh and derive quota/reset fields from that authoritative snapshot, ignoring stale caller strings. A failed refresh displays quota as unavailable and does not reuse a cached reset. ISO reset values are rendered as localized absolute and relative times. `allowed_mentions` is always empty.

## Test

```text
npm test
set TASK_GUARD_TEST_QUOTA=low
node scripts\task-guard.mjs quota
```

The test suite covers the app-server JSONL handshake, strict quota mapping, phase measurements, history filtering, conservative budget selection, checkpoint persistence, linked worktrees, concurrent registry updates, large diffs, external repository changes, cleanup, notification safety, CLI behavior, and installation. A live quota smoke test requires the signed-in Codex CLI but does not send a model prompt. Discord tests use a mock transport and do not send a real webhook.

## Uninstall

Delete `%CODEX_HOME%\skills\task-guard` (or `%USERPROFILE%\.codex\skills\task-guard`) and remove the block between `TASK-GUARD POLICY START` and `TASK-GUARD POLICY END` from the global `AGENTS.md`. Paused task data under `%CODEX_HOME%\task-guard` is intentionally not deleted automatically; review it before removal.

## Known limitations

- Skill invocation and pause/resume decisions are agent-driven; Task Guard is not a deterministic Codex lifecycle hook.
- Same-thread wake-up depends on the current Codex app exposing its heartbeat automation tool; it is not implemented through an assumed private API.
- Local scheduled resume requires the host computer to remain powered on, the desktop app to remain running, and the project to remain available on disk. System sleep, hibernation, shutdown, or closing the app can delay the run, so use the manual same-thread fallback when those conditions cannot be maintained.
- Quota and `doctor` require the Codex CLI on `PATH`; Codex Desktop alone is not sufficient for the app-server quota probe.
- App-server startup can take tens of seconds on the first read.
- The current implementation uses process-per-boundary JIT reads. Persistent app-server monitoring and `account/rateLimits/updated` subscription are future optimizations.
- `UNKNOWN` quota requires human/agent judgment about whether to continue; the utility does not apply a blind percentage threshold.
- Cold-start cohorts return `INSUFFICIENT_HISTORY`; V1 intentionally has no fixed model multiplier, percentile, automatic model switching, or cross-cohort extrapolation.
- Percentage-point deltas can include shared-pool activity. Only samples explicitly marked as having no concurrent usage are eligible for automatic estimates.
- Checkpoint projects must be Git repositories.

Research evidence and runtime tradeoffs are recorded in [docs/research.md](docs/research.md).
