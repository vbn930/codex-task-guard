# Phase measurement and budget inputs

Task Guard treats the task as the thread-level goal and phases as dependency-safe execution units. Phase files contain metadata only; never include prompts, source code, diffs, credentials, or webhook URLs.

## Start and complete a phase

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

```text
node <skill-root>/scripts/task-guard.mjs phase start --project <project> --input <phase.json>
node <skill-root>/scripts/task-guard.mjs phase complete --project <project> --phase-id <phase-id> --concurrent-usage false
```

`--concurrent-usage` accepts `true`, `false`, or `unknown`. Use `false` only when no other Codex thread, ChatGPT Work task, Workspace Agent, or other shared-pool consumer ran during the measurement. Completion appends one metadata-only record to `%CODEX_HOME%/task-guard/usage-history.jsonl`.

## Evaluate pending phases

```json
{
  "safety_reserve_percent": 5,
  "phases": [
    {
      "phase_id": "formatter-implementation",
      "phase_type": "implementation",
      "model": "gpt-5.6-sol",
      "reasoning_effort": "high",
      "plan": "plus",
      "dependencies_met": true
    },
    {
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
node <skill-root>/scripts/task-guard.mjs budget evaluate --input <budget.json>
```

The command reads live quota, computes `available_budget = remaining_percent - safety_reserve_percent`, and evaluates exact plan/model/reasoning/phase-type cohorts. V1 uses the highest valid observed delta as `estimated_upper_cost`. It selects the first dependency-ready phase that fits. A phase with no valid nonzero samples returns `INSUFFICIENT_HISTORY`; split or deliberately calibrate it instead of inventing a cost.

When a next-phase decision follows completion, use the same JSON shape plus `"concurrent_usage": "false"` with `phase finish`. It performs one authoritative refresh and returns `snapshot`, `measurement`, and `decision` sharing one `snapshot_id`. History records `quota_before_observed_at`, `quota_after_observed_at`, reset identity, `concurrency_status`, `measurement_confidence`, and `external_usage_possible`. A direct delta is recorded only for a verified identical reset window.
