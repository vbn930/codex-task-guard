# Contributing

Thank you for helping improve Codex Task Guard. Keep changes small, safety-oriented, and dependency-minimal.

## Development setup

Requirements:

- Windows
- Node.js 20 or newer
- Git

Clone the repository and run the deterministic test suite:

```text
npm test
```

The tests use fixture quota data and mock notification/automation adapters. They must not create live Codex automations, send Discord webhooks, or consume quota-reset credits.

## Change guidelines

- Preserve checkpoint authority: the project checkpoint is truth and the global registry is derived.
- Keep quota decisions fail-closed. Only an `AUTHORITATIVE` snapshot may drive work.
- Preserve same-thread automation verification, bounded retries, and explicit manual fallback.
- Never persist raw automation evidence, credentials, source contents, or repository paths in usage records.
- Add behavior-focused regression tests before changing implementation.
- Avoid runtime dependencies unless their value clearly exceeds the added operational surface.

## Pull requests

Before opening a pull request:

1. Run `npm test` on Node.js 20 or newer.
2. Confirm `git diff --check` reports no whitespace errors.
3. Describe any persistence or state-transition changes and their failure behavior.
4. Update `README.md`, reference inputs, and `CHANGELOG.md` when the public contract changes.

Live Codex automation integration is intentionally outside deterministic CI. If a change requires a live check, document the isolated manual evidence without committing credentials or raw transcripts.
