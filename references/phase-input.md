# Phase measurement and budget inputs

Task Guard treats the task as the thread-level goal and phases as dependency-safe execution units. Phase files contain metadata only; never include prompts, source code, diffs, credentials, or webhook URLs.

## Prepare and complete a phase

```json
{
  "task_id": "task-24",
  "phase_id": "formatter-implementation",
  "phase_type": "implementation",
  "plan": "plus",
  "context_bucket": "large",
  "files_before": 8,
  "estimated_files": 5,
  "expected_files_touched": 5,
  "tool_profile": "code_test"
}
```

Required fields are `task_id`, `phase_id`, and `phase_type`. Omitted, `auto`, or `unknown` `model` and `reasoning_effort` values are resolved from the exact current Codex thread before quota is refreshed. Detection requires a Codex-injected thread ID, a successful app-server `thread/read`, exact returned thread identity, optional exact session identity, and non-empty runtime fields. Failure stays `unknown`; config defaults and other threads are not fallbacks. Explicit values remain supported and are marked as caller-supplied. `plan` is a history partition key rather than a direct cost multiplier.

Inspect the current sanitized identity independently with:

```text
node <skill-root>/scripts/task-guard.mjs runtime identify
```

For the default automated start boundary, put this metadata on every candidate in the budget input below and run:

```text
node <skill-root>/scripts/task-guard.mjs phase prepare --project <project> --input <budget.json>
```

`phase prepare` performs exactly one authoritative refresh, evaluates the candidates, and starts only the selected phase with that same snapshot. These IDs are identical:

```text
snapshot.snapshot_id
decision.quota_snapshot_id
phase_start.quota_before_snapshot_id
```

If no candidate fits, `selected_phase_id` and `phase_start` are null and no active phase file is created. `phase start --project <project> --input <phase.json>` remains available for deliberately bounded calibration or manual diagnostics, not as the second half of an automated `budget evaluate` flow.

Complete a phase with:

```text
node <skill-root>/scripts/task-guard.mjs phase complete --project <project> --phase-id <phase-id> --concurrent-usage false
```

`--concurrent-usage` accepts `true`, `false`, or `unknown`. Use `false` only when no other Codex thread, ChatGPT Work task, Workspace Agent, or other shared-pool consumer ran during the measurement. Completion commits one metadata-only schema-v2 record to `%CODEX_HOME%/task-guard/usage-history.jsonl`. Its `phase_run_id` makes completion idempotent if active-state cleanup must be retried.

## Native phase plan

```json
{
  "task_id": "task-24",
  "safety_reserve_percent": 5,
  "phases": [
    {
      "task_id": "task-24",
      "phase_id": "backend",
      "phase_type": "implementation",
      "plan": "plus",
      "depends_on": [],
      "estimated_files": 4
    },
    {
      "task_id": "task-24",
      "phase_id": "integration-tests",
      "phase_type": "testing",
      "plan": "plus",
      "depends_on": ["backend"],
      "estimated_files": 2
    }
  ]
}
```

Top-level `task_id`, or a `depends_on` field on any phase, requests native planning. Every phase must then carry the same `task_id`. Task Guard rejects duplicate IDs, unknown dependencies, cycles, and invalid `estimated_files`; persists the full plan under Task Guard home; records completed phase IDs; and derives `READY`, `DEPENDENCY_BLOCKED`, and `COMPLETED` states. Caller-supplied `dependencies_met` is ignored for a native plan.

## Semantic phase generation

Task Guard can ask an explicitly supplied provider module to convert task prose into the native plan above:

```json
{
  "task_id": "task-24",
  "task_description": "Add a provider-backed semantic phase generator with CLI integration and tests.",
  "safety_reserve_percent": 10
}
```

```text
node <skill-root>/scripts/task-guard.mjs phase generate --provider C:\path\to\provider.mjs --input semantic-request.json
```

The local ES module must default-export an object with a non-empty `id` and an async `generate(request)` function. The request contains `task_id`, `task_description`, and `output_contract`. The function returns only this provider-owned shape:

```json
{
  "phases": [
    {
      "phase_id": "implementation",
      "phase_type": "implementation",
      "depends_on": [],
      "estimated_files": 3
    },
    {
      "phase_id": "verification",
      "phase_type": "testing",
      "depends_on": ["implementation"],
      "estimated_files": 1
    }
  ]
}
```

Every phase requires `phase_id`, `phase_type`, and `depends_on`; `estimated_files` is optional. Additional root or phase fields are rejected. Task Guard then applies the native duplicate, dependency, cycle, and size validations; adds `task_id` and the `semantic-v1` history partition to every phase; preserves the optional safety reserve; and prints a plan that can be passed unchanged to `phase prepare`.

The provider, not Task Guard, chooses the phases and dependency semantics. Task Guard ships no built-in semantic provider, does not use keyword-only decomposition, and does not invoke the current Codex task. Provider modules execute as trusted local code with Task Guard's process permissions. Explicit native plans and legacy non-native phase inputs remain backward compatible and do not load a provider.

On `phase finish`, Task Guard marks the active native phase complete and calculates the next ready phase without requiring the caller to resend the graph. A quota checkpoint embeds the native plan, and `resume prepare` restores it only after repository, quota, and automation-cleanup gates pass. `checkpoint complete` removes the persisted plan. Inputs that omit native-plan fields retain the legacy caller-supplied `dependencies_met` behavior.

```text
node <skill-root>/scripts/task-guard.mjs phase prepare --project <project> --input <budget.json>
```

The command resolves runtime identity first, then reads live quota once, computes `available_budget = remaining_percent - safety_reserve_percent`, and evaluates exact plan/model/reasoning/phase-type cohorts. For a phase with `estimated_files`, it uses the nearest measured file count that is not smaller; smaller samples are never extrapolated upward. Fewer than 20 valid samples use the highest observed delta as `estimated_upper_cost`; at 20 samples, the estimator uses nearest-rank P90 from the latest 50 valid samples plus one percentage point. It selects the first graph-ready phase that fits and records its start from that same quota snapshot. A phase with no valid match returns `INSUFFICIENT_HISTORY`; split or deliberately calibrate it instead of inventing a cost. `budget evaluate --input <budget.json>` remains a standalone diagnostic that does not persist a native plan or start a phase.

When a next-phase decision follows completion, use the same JSON shape plus `"concurrent_usage": "false"` with `phase finish`. It performs one authoritative refresh and returns `snapshot`, `measurement`, and `decision` sharing one `snapshot_id`. History records `quota_before_observed_at`, `quota_after_observed_at`, reset identity, `concurrency_status`, `measurement_confidence`, and `external_usage_possible`. A direct delta is recorded only for a verified identical reset window.

Internal budget decisions use all retained history. The ledger compacts after 2,500 records to at most 2,000 records, prioritizing the latest 50 records from each exact cohort before filling the remaining capacity with the newest records overall. The `history list --limit` option affects only displayed output.
