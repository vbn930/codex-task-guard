# Changelog

All notable changes to Codex Task Guard are documented here.

## Unreleased

### Changed

- Added bounded, cohort-aware usage history retention with atomic compaction.
- Switched sufficiently measured cohorts from permanent observed maximum to recent P90 plus a one-point safety margin.
- Kept internal budget decisions independent from the `history list` display limit.

## 0.2.0 - 2026-09-09

### Added

- Shared filesystem, runtime-path, repository-state, and task-registry modules.
- Usage ledger schema v2 with stable `phase_run_id` identity.
- Corruption-aware usage history parsing and interrupted-tail recovery.
- Windows CI coverage for Node.js 20 and the current LTS release.
- Contributor guidance.

### Changed

- Made checkpoint mutations authoritative when derived registry persistence fails.
- Reordered resume validation so duplicate wakes and repository mismatches are resolved before quota or external cleanup.
- Centralized durable automation statuses, trace events, and manual resolution semantics.
- Made phase completion idempotent across interrupted active-state cleanup.
- Preserved authoritative quota observations when snapshot cache persistence fails.

### Fixed

- Made test discovery work on Windows with Node.js 20.
- Compared canonical temporary paths in checkpoint tests on hosted Windows runners.

### Security

- Removed the unsafe public checkpoint resume transition.
- Added recursive rejection of credential-like and raw automation fields in checkpoint state.
- Kept verified automation dependent on concrete thread identity, requested ID, bounded read-back, and one-shot schedule validation.
