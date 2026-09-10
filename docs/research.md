# Phase 1 research and verification

Verified on 2026-08-31 with Codex CLI `0.151.0-alpha.7.2` and Codex desktop `26.825.6671.0` on Windows.

## Feasibility findings

- The installed app-server schema and the [OpenAI Codex app-server documentation](https://github.com/openai/codex/blob/main/codex-rs/app-server/README.md#7-rate-limits-chatgpt) expose `account/rateLimits/read` and sparse `account/rateLimits/updated` notifications.
- A live local call returned a `codex` bucket with exact 300-minute and 10,080-minute windows. The first child-process query took about 31 seconds, so the client uses a 45-second timeout.
- The transport names windows `primary` and `secondary`; those names do not guarantee duration. Task Guard maps only exact durations and leaves missing windows unavailable.
- The current Codex app exposes a stable local-automation feature and a current-thread heartbeat tool to the agent. It is not part of this utility's app-server contract, so automation is optional and instruction-driven. Checkpoint plus `resume_after` remains the fallback.
- The repository began empty, with no existing implementation or compatibility surface.

## Current-thread runtime identity probe

Re-verified on 2026-09-10 with Codex CLI `0.153.4` on Windows:

- Codex tool processes exposed matching `CODEX_THREAD_ID` and `CODEX_SESSION_ID` UUIDs.
- The generated experimental app-server schema exposed `thread/read` with required `threadId` and optional `includeTurns`. Its thread response includes nullable `model` and `reasoningEffort` fields.
- A live metadata-only read of the exact injected thread returned the configured model and reasoning effort, and its thread/session identifiers matched the injected values.
- The protocol explicitly describes these as current configured values when loaded or latest persisted values otherwise, not per-turn execution telemetry.
- Runtime detection therefore requires exact thread identity and, when injected, exact session identity. Missing IDs, mismatches, read errors, and absent fields fail closed to `unknown`. Configuration defaults and recency-based thread selection are deliberately excluded.

## Same-thread automation probe

Re-verified on 2026-08-31 before implementing resume-automation recovery:

- The current thread exposes exactly one Codex automation capability: `mcp__codex_app__automation_update`.
- Its explicit input union exposes heartbeat `create`/`suggested_create` and ID-based `mode: "view"`. The capability description mentions update/delete, but those payload arms are opaque (`unknown`), so Task Guard does not depend on them for correctness.
- There is no exposed automation list or name/metadata search operation.
- Heartbeat creation exposes `destination: "thread"` and `targetThreadId`; detached cron is therefore not a same-thread fallback.
- `%USERPROFILE%\.codex\automations` existed but contained no automation directories. No existing ID was available for a safe read-only `view` probe.
- A live test automation was deliberately not created because it would mutate the user's scheduler. Create, view, not-found, UI-card-only, and persisted heartbeat response variants are covered through the agent adapter's deterministic fixtures instead.

The exposed tool schema in this task supports these known arms only:

- `{ id, mode: "view" }`
- cron `{ mode: "create" | "suggested_create", executionEnvironment: "local", ... }`
- heartbeat `{ mode: "create" | "suggested_create", destination?: "local" | "thread", targetThreadId?: unknown, ... }`

There is no list or search mode. Exact update/delete payloads remain opaque and are not used for correctness. During the real quota-pause lifecycle check, an immediate heartbeat create carrying `DTSTART` was rejected because immediate create does not accept `DTSTART`; `suggested_create` returned only `Rendered automation card in the app.` with no ID. A read-only inspection of `%USERPROFILE%\.codex\automations` found no matching persisted entry. Task Guard therefore recorded manual fallback and did not claim that the rendered card was scheduled. Because no ID existed, a live `view` shape or not-found response could not be safely obtained; those shapes remain fixture-backed runtime assumptions.

The local automation directory is treated only as a read-only, Windows-specific reconciliation aid after an ambiguous ID-less create result. It is not a public API, it is never edited, and a filesystem match alone cannot produce `VERIFIED`.

## Verification design derived from the probe

- The Node utility owns the expected logical identity, response normalization, field comparison, bounded retry policy, reconciliation, sanitized checkpoint state, and Discord rendering. The Codex agent remains the adapter that invokes the exposed automation tool.
- Create responses are classified as ID received, UI rendered only, ambiguous, or structural failure. IDs are accepted only from explicit ID fields/text; no synthetic ID is generated.
- ID-based views are normalized from structured objects or conservative labeled text. Verification requires the requested and persisted IDs to match, plus logical name, heartbeat kind, active status, concrete target thread, reset/wake semantics, and prompt when available. Missing IDs/targets remain unverified; the logical word `current` is never invented as a concrete runtime ID.
- View persistence gets at most three short reads. Create gets at most two attempts. Only repeated explicit `NOT_FOUND` followed by read-only reconciliation `ABSENT` can authorize a second create. Unparseable, transient transport, structural, reconciliation-I/O, and ambiguous results end in structured manual fallback.
- A one-shot schedule represented as `DTSTART` plus `FREQ=DAILY;COUNT=1` is accepted when its first wake is at or within five minutes after the verified reset. Any RRULE without `COUNT=1`, or with `COUNT > 1`, can repeat and is rejected regardless of hourly/daily/weekly frequency.
- The production boundary accepts an ordered raw operation transcript over stdin. Node derives the sanitized result, and pause finalization re-runs the verifier. The direct checkpoint automation command cannot author `VERIFIED`; raw responses are never checkpoint or registry fields.
- The project checkpoint is authoritative. A registry failure after a narrow checkpoint write is explicit, recoverable derived-state drift; registry repair reads the checkpoint and never replays automation creation.
- `VERIFIED` means persistence and readable-field verification only. Scheduler execution remains a separate future event and is not guaranteed.

`PERSISTENCE VERIFIED != FUTURE EXECUTION GUARANTEED`.

## Runtime decision

| Runtime | Current environment | Assessment |
|---|---|---|
| Node.js | v24.19.0 installed | Selected: reliable JSONL subprocess control, built-in `fetch`, built-in test runner, zero dependencies |
| Python | Windows app alias only; no usable interpreter found | Rejected for this machine because it would add installation/setup |
| PowerShell | Windows PowerShell 5.1 plus a Codex-bundled PowerShell 7 | Rejected for the core because child-process JSONL and cross-version JSON/HTTP testing are more fragile |

The project requires Node.js 20 or newer and uses no npm runtime dependencies.

## Open-source review

- [`codex-limit-watch`](https://github.com/JiaqiZhao2004/codex-limit-watch) (MIT) provided the closest lightweight reference: a dependency-free Node app-server client, duration-based selection, and `node:test`. Task Guard follows the same narrow transport approach but deliberately removes its unlabeled primary/secondary fallback.
- [`codex-status-mcp`](https://github.com/DrSmile444/codex-status-mcp) (MIT) confirms the app-server flow, but an MCP server is unnecessary for this MVP.
- [`codex-usage`](https://github.com/Tooblippe/codex-usage) (MIT) demonstrates a Windows-native implementation, but .NET desktop dependencies and tray UI are out of scope.
- [`codex-limits`](https://github.com/simonesiega/codex-limits) (MIT) is broader and mature, but its TUI, reset-credit, and agent-integration surface is larger than required.

No third-party package is bundled. The small app-server client structure was informed by `codex-limit-watch`; attribution is retained in `THIRD_PARTY_NOTICES.md`.

## Confirmed MVP boundary

The MVP contains quota JSON, measured phase history, exact-cohort conservative budget evaluation, project-local checkpoint plus global registry, repository fingerprint verification, optional Discord webhook notifications, skill instructions, and optional current-thread heartbeat use. Official OpenAI guidance states that Codex usage varies with model, task complexity, context, reasoning, speed, tools, and execution location, but does not provide a deterministic task-to-percentage formula. Task Guard therefore treats general model guidance only as context and uses valid local measurements for automated selection.

The project does not contain a daemon, database, machine-learning predictor, cross-model extrapolation, automatic model routing, GUI, Discord bot, inbound commands, or reset-credit consumption. Its local estimator uses a documented fixed recent-percentile policy only after an exact cohort reaches 20 valid samples.

Quota freshness uses process-per-boundary JIT `account/rateLimits/read` calls. Successful observations become timestamped `AUTHORITATIVE` snapshots; persisted last-known data is always labeled `STALE`, without an invented age threshold. Persistent app-server operation and `account/rateLimits/updated` subscription remain future optimizations.
