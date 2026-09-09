# Phase measurement and budget inputs

Task Guard treats the task as the thread-level goal and phases as dependency-safe execution units. Phase files contain metadata only; never include prompts, source code, diffs, credentials, or webhook URLs.

## Prepare and complete a phase

```json
{
  "task_id": "task-24",
  "phase_id": "formatter-implementation",
  "phase_type": "implementation",
  "model": "gpt-5.6-sol",
  "reasoning_effort": "high",
  "plan": "plus",
  "context_bucket": "large",
  "files_before": 8,
  "expected_files_touched": 5,
  "tool_profile": "code_test"
}
```

Required fields are `task_id`, `phase_id`, `phase_type`, `model`, and `reasoning_effort`. `plan` is a history partition key rather than a direct cost multiplier. Use active session values when exposed; otherwise record `unknown` rather than presenting configuration defaults as verified session state.

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

## Evaluate pending phases

```json
{
  "safety_reserve_percent": 5,
  "phases": [
    {
      "task_id": "task-24",
      "phase_id": "formatter-implementation",
      "phase_type": "implementation",
      "model": "gpt-5.6-sol",
      "reasoning_effort": "high",
      "plan": "plus",
      "dependencies_met": true
    },
    {
      "task_id": "task-24",
      "phase_id": "integration-tests",
      "phase_type": "testing",
      "model": "gpt-5.6-sol",
      "reasoning_effort": "high",
      "plan": "plus",
      "dependencies_met": false
    }
  ]
}
```

```text
node <skill-root>/scripts/task-guard.mjs phase prepare --project <project> --input <budget.json>
```

The command reads live quota once, computes `available_budget = remaining_percent - safety_reserve_percent`, and evaluates exact plan/model/reasoning/phase-type cohorts. Fewer than 20 valid samples use the highest observed delta as `estimated_upper_cost`; at 20 samples, the estimator uses nearest-rank P90 from the latest 50 valid samples plus one percentage point. It selects the first dependency-ready phase that fits and records its start from that same quota snapshot. A phase with no valid nonzero samples returns `INSUFFICIENT_HISTORY`; split or deliberately calibrate it instead of inventing a cost. `budget evaluate --input <budget.json>` remains a standalone diagnostic that does not start a phase.

When a next-phase decision follows completion, use the same JSON shape plus `"concurrent_usage": "false"` with `phase finish`. It performs one authoritative refresh and returns `snapshot`, `measurement`, and `decision` sharing one `snapshot_id`. History records `quota_before_observed_at`, `quota_after_observed_at`, reset identity, `concurrency_status`, `measurement_confidence`, and `external_usage_possible`. A direct delta is recorded only for a verified identical reset window.

Internal budget decisions use all retained history. The ledger compacts after 2,500 records to at most 2,000 records, prioritizing the latest 50 records from each exact cohort before filling the remaining capacity with the newest records overall. The `history list --limit` option affects only displayed output.
