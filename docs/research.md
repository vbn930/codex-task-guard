# Phase 1 research and verification

Verified on 2026-08-31 with Codex CLI `0.151.0-alpha.7.2` and Codex desktop `26.825.6671.0` on Windows.

## Feasibility findings

- The installed app-server schema and the [OpenAI Codex app-server documentation](https://github.com/openai/codex/blob/main/codex-rs/app-server/README.md#7-rate-limits-chatgpt) expose `account/rateLimits/read` and sparse `account/rateLimits/updated` notifications.
- A live local call returned a `codex` bucket with exact 300-minute and 10,080-minute windows. The first child-process query took about 31 seconds, so the client uses a 45-second timeout.
- The transport names windows `primary` and `secondary`; those names do not guarantee duration. Task Guard maps only exact durations and leaves missing windows unavailable.
- The current Codex app exposes a stable local-automation feature and a current-thread heartbeat tool to the agent. It is not part of this utility's app-server contract, so automation is optional and instruction-driven. Checkpoint plus `resume_after` remains the fallback.
- The repository began empty, with no existing implementation or compatibility surface.

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

The MVP contains quota JSON, project-local checkpoint plus global registry, repository fingerprint verification, optional Discord webhook notifications, skill instructions, and optional current-thread heartbeat use. It does not contain a daemon, database, MCP server, GUI, Discord bot, inbound commands, or reset-credit consumption.
