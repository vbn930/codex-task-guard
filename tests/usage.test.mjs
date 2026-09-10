import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { mkdtemp, mkdir, readFile, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { promisify } from "node:util";

import {
  completePhase,
  estimatePhaseCost,
  evaluateBudget,
  readUsageHistory,
  startPhase,
} from "../scripts/lib/usage.mjs";

const execFileAsync = promisify(execFile);

function authoritativeSnapshot(
  remaining,
  observedAt,
  resetAt = "2026-08-31T12:00:00.000Z",
) {
  return {
    snapshot_id: `${observedAt}-${remaining}`,
    source: "test_fixture",
    observed_at: observedAt,
    freshness: "AUTHORITATIVE",
    availability: "PARTIAL",
    five_hour: {
      available: true,
      used_percent: 100 - remaining,
      remaining_percent: remaining,
      window_duration_minutes: 300,
      reset_at: resetAt,
    },
    weekly: { available: false },
  };
}

test("phase history preserves authoritative before and after snapshot metadata", async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), "task-guard-usage-snapshot-"));
  const projectPath = path.join(root, "project");
  const taskGuardHome = path.join(root, "global");
  await mkdir(projectPath);
  const before = authoritativeSnapshot(45, "2026-08-31T01:00:00.000Z");
  const after = authoritativeSnapshot(34, "2026-08-31T01:20:00.000Z");

  await startPhase({
    projectPath,
    taskGuardHome,
    snapshot: before,
    quotaReader: async () => { throw new Error("usage must not read quota directly"); },
    metadata: {
      task_id: "task-snapshot",
      phase_id: "implementation",
      phase_type: "implementation",
      model: "gpt-5.6-sol",
      reasoning_effort: "high",
    },
  });
  const completed = await completePhase({
    projectPath,
    taskGuardHome,
    phaseId: "implementation",
    concurrentUsage: false,
    snapshot: after,
    quotaReader: async () => { throw new Error("usage must not read quota directly"); },
  });

  assert.equal(completed.quota_before, 45);
  assert.equal(completed.quota_before_observed_at, before.observed_at);
  assert.equal(completed.quota_after, 34);
  assert.equal(completed.quota_after_observed_at, after.observed_at);
  assert.equal(completed.quota_delta, 11);
  assert.equal(completed.reset_occurred, false);
  assert.equal(completed.window_identity, "SAME_WINDOW");
  assert.equal(completed.concurrency_status, "NONE");
  assert.equal(completed.measurement_confidence, "HIGH_CONFIDENCE");
  assert.equal(completed.external_usage_possible, false);
  assert.equal(completed.quota_before_snapshot_id, before.snapshot_id);
  assert.equal(completed.quota_after_snapshot_id, after.snapshot_id);
});

test("active phase identity uses the Git root from any repository subdirectory", async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), "task-guard-usage-root-"));
  const projectPath = path.join(root, "project");
  const subdirectory = path.join(projectPath, "packages", "worker");
  const taskGuardHome = path.join(root, "global");
  await mkdir(subdirectory, { recursive: true });
  await execFileAsync("git", ["init"], { cwd: projectPath, windowsHide: true });

  await startPhase({
    projectPath: subdirectory,
    taskGuardHome,
    metadata: {
      task_id: "task-root",
      phase_id: "implementation",
      phase_type: "implementation",
      model: "gpt-5.6-sol",
      reasoning_effort: "high",
    },
    snapshot: authoritativeSnapshot(45, "2026-08-31T01:00:00.000Z"),
  });

  const completed = await completePhase({
    projectPath,
    taskGuardHome,
    phaseId: "implementation",
    concurrentUsage: false,
    snapshot: authoritativeSnapshot(40, "2026-08-31T01:10:00.000Z"),
  });

  assert.equal(completed.project, path.basename(projectPath));
  assert.equal(completed.quota_delta, 5);
});

test("records measured phase usage without storing source contents", async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), "task-guard-usage-"));
  const projectPath = path.join(root, "private-project");
  const taskGuardHome = path.join(root, "global");
  await mkdir(projectPath);

  const started = await startPhase({
    projectPath,
    taskGuardHome,
    metadata: {
      task_id: "task-24",
      phase_id: "formatter-implementation",
      phase_type: "implementation",
      model: "gpt-5.6-sol",
      reasoning_effort: "high",
      plan: "plus",
      context_bucket: "large",
      estimated_files: 4,
      expected_files_touched: 5,
      tool_profile: "code_test",
    },
    snapshot: authoritativeSnapshot(62, "2026-08-31T01:00:00.000Z"),
    now: () => new Date("2026-08-31T01:00:00.000Z"),
  });

  assert.equal(started.quota_before, 62);
  assert.equal(started.phase_id, "formatter-implementation");

  const completed = await completePhase({
    projectPath,
    taskGuardHome,
    phaseId: "formatter-implementation",
    concurrentUsage: false,
    snapshot: authoritativeSnapshot(49, "2026-08-31T01:15:40.000Z"),
    now: () => new Date("2026-08-31T01:15:40.000Z"),
  });

  assert.equal(completed.quota_delta, 13);
  assert.equal(completed.duration_seconds, 940);
  assert.equal(completed.schema_version, 2);
  assert.equal(typeof completed.phase_run_id, "string");
  assert.equal(completed.reset_occurred, false);
  assert.equal(completed.concurrency_known, true);
  assert.equal(completed.concurrent_usage, false);
  assert.equal(completed.measurement_confidence, "HIGH_CONFIDENCE");
  assert.equal(completed.estimated_files, 4);
  assert.equal("confidence" in completed, false);
  assert.equal("reset_during_phase" in completed, false);

  const history = await readUsageHistory({ taskGuardHome });
  assert.deepEqual(history, [completed]);
  assert.equal(JSON.stringify(completed).includes(projectPath), false);
  assert.equal(completed.quota_before_source, "test_fixture");
  assert.equal(completed.quota_after_source, "test_fixture");
  assert.equal("project_path" in completed, false);

  const historyText = await readFile(path.join(taskGuardHome, "usage-history.jsonl"), "utf8");
  assert.equal(historyText.trim().split("\n").length, 1);
});

test("does not attribute quota usage when the five-hour window resets during a phase", async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), "task-guard-usage-reset-"));
  const projectPath = path.join(root, "project");
  const taskGuardHome = path.join(root, "global");
  await mkdir(projectPath);

  await startPhase({
    projectPath,
    taskGuardHome,
    metadata: {
      task_id: "task-reset",
      phase_id: "tests",
      phase_type: "testing",
      model: "gpt-5.6-terra",
      reasoning_effort: "medium",
    },
    snapshot: authoritativeSnapshot(
      4,
      "2026-08-31T01:55:00.000Z",
      "2026-08-31T02:00:00.000Z",
    ),
    now: () => new Date("2026-08-31T01:55:00.000Z"),
  });

  const completed = await completePhase({
    projectPath,
    taskGuardHome,
    phaseId: "tests",
    snapshot: authoritativeSnapshot(
      98,
      "2026-08-31T02:05:00.000Z",
      "2026-08-31T07:00:00.000Z",
    ),
    now: () => new Date("2026-08-31T02:05:00.000Z"),
  });

  assert.equal(completed.quota_delta, null);
  assert.equal(completed.reset_occurred, true);
  assert.equal(completed.concurrency_known, false);
  assert.equal(completed.concurrent_usage, null);
  assert.equal(completed.measurement_confidence, "LOW_CONFIDENCE");
});

test("estimates a conservative phase cost from high-confidence exact-cohort history", () => {
  const cohort = {
    model: "gpt-5.6-sol",
    reasoning_effort: "high",
    phase_type: "integration",
    plan: "plus",
  };
  const sample = (quotaDelta, overrides = {}) => ({
    ...cohort,
    quota_delta: quotaDelta,
    confidence: "high",
    reset_during_phase: false,
    ...overrides,
  });
  const history = [
    sample(7),
    sample(9),
    sample(12),
    sample(17, { confidence: "low", concurrent_usage: true }),
    sample(null, { reset_during_phase: true }),
    sample(4, { model: "gpt-5.6-luna" }),
    sample(2, { plan: "pro" }),
  ];

  assert.deepEqual(estimatePhaseCost({ history, phase: cohort }), {
    status: "AVAILABLE",
    cohort,
    sample_count: 3,
    minimum_cost: 7,
    median_cost: 9,
    estimated_upper_cost: 12,
    method: "observed_max",
  });
});

test("estimates a sized phase from the nearest same-cohort size that is not smaller", () => {
  const cohort = {
    model: "gpt-5.6-sol",
    reasoning_effort: "high",
    phase_type: "implementation",
    plan: "plus",
  };
  const sample = (estimatedFiles, quotaDelta, overrides = {}) => ({
    ...cohort,
    estimated_files: estimatedFiles,
    quota_delta: quotaDelta,
    measurement_confidence: "HIGH_CONFIDENCE",
    reset_occurred: false,
    ...overrides,
  });
  const result = estimatePhaseCost({
    phase: { ...cohort, estimated_files: 3 },
    history: [
      sample(2, 40),
      sample(4, 7),
      sample(4, 8),
      sample(6, 9),
      sample(6, 90, { plan: "pro" }),
    ],
  });

  assert.equal(result.status, "AVAILABLE");
  assert.equal(result.sample_count, 2);
  assert.equal(result.estimated_upper_cost, 8);
});

test("does not extrapolate a sized estimate from smaller phases", () => {
  const phase = {
    model: "gpt-5.6-sol",
    reasoning_effort: "high",
    phase_type: "implementation",
    plan: "plus",
    estimated_files: 5,
  };
  const result = estimatePhaseCost({
    phase,
    history: [{
      ...phase,
      estimated_files: 3,
      quota_delta: 4,
      measurement_confidence: "HIGH_CONFIDENCE",
      reset_occurred: false,
    }],
  });

  assert.equal(result.status, "INSUFFICIENT_HISTORY");
  assert.equal(result.sample_count, 0);
});

test("uses a conservative recent percentile once a cohort has enough samples", () => {
  const cohort = {
    model: "gpt-5.6-sol",
    reasoning_effort: "high",
    phase_type: "implementation",
    plan: "plus",
  };
  const history = [90, ...Array.from({ length: 19 }, (_, index) => index + 1)]
    .map((quotaDelta) => ({
      ...cohort,
      quota_delta: quotaDelta,
      measurement_confidence: "HIGH_CONFIDENCE",
      reset_occurred: false,
    }));

  assert.deepEqual(estimatePhaseCost({ history, phase: cohort }), {
    status: "AVAILABLE",
    cohort,
    sample_count: 20,
    sample_window: 20,
    minimum_cost: 1,
    median_cost: 10.5,
    estimated_upper_cost: 19,
    percentile: 90,
    method: "recent_p90_plus_one",
  });
});

test("recent percentile ignores samples older than the latest fifty", () => {
  const cohort = {
    model: "gpt-5.6-sol",
    reasoning_effort: "high",
    phase_type: "implementation",
    plan: "plus",
  };
  const history = [
    ...Array.from({ length: 10 }, () => 99),
    ...Array.from({ length: 50 }, (_, index) => index + 1),
  ].map((quotaDelta) => ({
    ...cohort,
    quota_delta: quotaDelta,
    reset_occurred: false,
    measurement_confidence: "HIGH_CONFIDENCE",
  }));

  assert.deepEqual(estimatePhaseCost({ history, phase: cohort }), {
    status: "AVAILABLE",
    cohort,
    sample_count: 60,
    sample_window: 50,
    minimum_cost: 1,
    median_cost: 25.5,
    estimated_upper_cost: 46,
    percentile: 90,
    method: "recent_p90_plus_one",
  });
});

test("selects the first dependency-ready phase whose observed upper cost fits the budget", () => {
  const base = {
    model: "gpt-5.6-sol",
    reasoning_effort: "high",
    plan: "plus",
    confidence: "high",
    reset_during_phase: false,
  };
  const history = [
    { ...base, phase_type: "refactor", quota_delta: 20 },
    { ...base, phase_type: "implementation", quota_delta: 9 },
    { ...base, phase_type: "testing", quota_delta: 4 },
  ];
  const phases = [
    { phase_id: "p4", phase_type: "refactor", dependencies_met: true, ...base },
    { phase_id: "p3", phase_type: "implementation", dependencies_met: true, ...base },
    { phase_id: "p5", phase_type: "testing", dependencies_met: false, ...base },
  ];

  const result = evaluateBudget({
    history,
    phases,
    snapshot: authoritativeSnapshot(23, "2026-08-31T04:00:00.000Z"),
    safetyReservePercent: 5,
  });

  assert.equal(result.decision, "RUN_PHASE");
  assert.equal(result.available_budget, 18);
  assert.equal(result.selected_phase_id, "p3");
  assert.equal(result.quota_snapshot_id, "2026-08-31T04:00:00.000Z-23");
  assert.equal(result.quota_observed_at, "2026-08-31T04:00:00.000Z");
  assert.deepEqual(
    result.phases.map(({ phase_id, status, estimated_upper_cost }) => (
      [phase_id, status, estimated_upper_cost]
    )),
    [
      ["p4", "TOO_LARGE", 20],
      ["p3", "FITS", 9],
      ["p5", "DEPENDENCY_BLOCKED", null],
    ],
  );
});

test("does not treat an unobservable zero-point delta as a free phase", () => {
  const phase = {
    phase_id: "small-edit",
    phase_type: "small_edit",
    model: "gpt-5.6-luna",
    reasoning_effort: "medium",
    dependencies_met: true,
  };
  const history = [{
    ...phase,
    quota_delta: 0,
    confidence: "high",
    reset_during_phase: false,
  }];

  const result = evaluateBudget({
    history,
    phases: [phase],
    snapshot: authoritativeSnapshot(12, "2026-08-31T04:30:00.000Z"),
    safetyReservePercent: 3,
  });

  assert.equal(result.selected_phase_id, null);
  assert.equal(result.phases[0].status, "INSUFFICIENT_HISTORY");
});

test("does not automate estimates for an unverified runtime cohort", () => {
  const phase = {
    model: "unknown",
    reasoning_effort: "unknown",
    phase_type: "implementation",
  };
  const result = estimatePhaseCost({
    phase,
    history: [{
      ...phase,
      quota_delta: 6,
      confidence: "high",
      reset_during_phase: false,
    }],
  });

  assert.equal(result.status, "INSUFFICIENT_HISTORY");
  assert.equal(result.sample_count, 0);
});

test("rejects malformed or ambiguous budget phase inputs", () => {
  const input = {
    history: [],
    snapshot: authoritativeSnapshot(50, "2026-08-31T05:00:00.000Z"),
    safetyReservePercent: 5,
  };

  assert.throws(
    () => evaluateBudget({ ...input, phases: undefined }),
    /phases must be a non-empty array/,
  );
  assert.throws(
    () => evaluateBudget({
      ...input,
      phases: [{
        phase_id: "tests",
        phase_type: "testing",
        model: "gpt-5.6-sol",
        reasoning_effort: "high",
      }],
    }),
    /dependencies_met must be true or false/,
  );
  assert.throws(
    () => evaluateBudget({
      ...input,
      phases: [
        {
          phase_id: "tests",
          phase_type: "testing",
          model: "gpt-5.6-sol",
          reasoning_effort: "high",
          dependencies_met: true,
        },
        {
          phase_id: "tests",
          phase_type: "testing",
          model: "gpt-5.6-sol",
          reasoning_effort: "high",
          dependencies_met: false,
        },
      ],
    }),
    /phase_id values must be unique/,
  );
});

test("budget decisions reject a non-authoritative quota snapshot", () => {
  const snapshot = {
    ...authoritativeSnapshot(16, "2026-08-31T05:30:00.000Z"),
    freshness: "STALE",
  };
  assert.throws(
    () => evaluateBudget({
      history: [],
      phases: [{
        phase_id: "tests",
        phase_type: "testing",
        model: "gpt-5.6-sol",
        reasoning_effort: "high",
        dependencies_met: true,
      }],
      snapshot,
      safetyReservePercent: 5,
    }),
    /AUTHORITATIVE_QUOTA_REQUIRED/,
  );
});

test("concurrent phase completion records exactly one history sample", async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), "task-guard-usage-concurrent-"));
  const projectPath = path.join(root, "project");
  const taskGuardHome = path.join(root, "global");
  await mkdir(projectPath);
  await startPhase({
    projectPath,
    taskGuardHome,
    metadata: {
      task_id: "task-concurrent",
      phase_id: "phase-concurrent",
      phase_type: "testing",
      model: "gpt-5.6-sol",
      reasoning_effort: "high",
    },
    snapshot: authoritativeSnapshot(70, "2026-08-31T03:00:00.000Z"),
  });

  const complete = () => completePhase({
    projectPath,
    taskGuardHome,
    phaseId: "phase-concurrent",
    concurrentUsage: false,
    snapshot: authoritativeSnapshot(65, "2026-08-31T03:10:00.000Z"),
  });
  const results = await Promise.allSettled([complete(), complete()]);

  assert.equal(results.filter(({ status }) => status === "fulfilled").length, 1);
  assert.equal(results.filter(({ status }) => status === "rejected").length, 1);
  assert.equal((await readUsageHistory({ taskGuardHome })).length, 1);
});

test("phase completion retry reuses the committed measurement after active-state cleanup fails", async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), "task-guard-usage-retry-"));
  const projectPath = path.join(root, "project");
  const taskGuardHome = path.join(root, "global");
  await mkdir(projectPath);
  await startPhase({
    projectPath,
    taskGuardHome,
    metadata: {
      task_id: "task-retry",
      phase_id: "implementation",
      phase_type: "implementation",
      model: "gpt-5.6-sol",
      reasoning_effort: "high",
    },
    snapshot: authoritativeSnapshot(45, "2026-08-31T01:00:00.000Z"),
  });

  await assert.rejects(completePhase({
    projectPath,
    taskGuardHome,
    phaseId: "implementation",
    concurrentUsage: false,
    snapshot: authoritativeSnapshot(40, "2026-08-31T01:10:00.000Z"),
    activeStateRemover: async () => { throw new Error("injected cleanup failure"); },
  }), /injected cleanup failure/);
  const [committed] = await readUsageHistory({ taskGuardHome });

  const retried = await completePhase({
    projectPath,
    taskGuardHome,
    phaseId: "implementation",
    concurrentUsage: false,
  });

  assert.equal(retried.phase_run_id, committed.phase_run_id);
  assert.equal((await readUsageHistory({ taskGuardHome })).length, 1);
});

test("usage history recovers an interrupted final JSONL write", async () => {
  const taskGuardHome = await mkdtemp(path.join(os.tmpdir(), "task-guard-history-tail-"));
  const record = { task_id: "valid", phase_id: "phase", started_at: "2026-08-31T01:00:00.000Z" };
  await writeFile(
    path.join(taskGuardHome, "usage-history.jsonl"),
    `${JSON.stringify(record)}\n{"task_id":"partial"`,
    "utf8",
  );

  const history = await readUsageHistory({ taskGuardHome });

  assert.equal(history.length, 1);
  assert.equal(history[0].task_id, "valid");
  assert.equal(history[0].schema_version, 2);
});

test("phase completion repairs an interrupted history tail before appending", async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), "task-guard-history-repair-"));
  const projectPath = path.join(root, "project");
  const taskGuardHome = path.join(root, "global");
  await mkdir(projectPath);
  await startPhase({
    projectPath,
    taskGuardHome,
    metadata: {
      task_id: "task-after-tail",
      phase_id: "implementation",
      phase_type: "implementation",
      model: "gpt-5.6-sol",
      reasoning_effort: "high",
    },
    snapshot: authoritativeSnapshot(45, "2026-08-31T01:00:00.000Z"),
  });
  const prior = { task_id: "prior", phase_id: "phase", started_at: "2026-08-30T01:00:00.000Z" };
  await writeFile(
    path.join(taskGuardHome, "usage-history.jsonl"),
    `${JSON.stringify(prior)}\n{"task_id":"partial"`,
    "utf8",
  );

  await completePhase({
    projectPath,
    taskGuardHome,
    phaseId: "implementation",
    concurrentUsage: false,
    snapshot: authoritativeSnapshot(40, "2026-08-31T01:10:00.000Z"),
  });

  const history = await readUsageHistory({ taskGuardHome });
  assert.deepEqual(history.map((record) => record.task_id), ["prior", "task-after-tail"]);
});

test("usage history rejects a corrupted middle JSONL record", async () => {
  const taskGuardHome = await mkdtemp(path.join(os.tmpdir(), "task-guard-history-middle-"));
  const valid = JSON.stringify({
    task_id: "valid",
    phase_id: "phase",
    started_at: "2026-08-31T01:00:00.000Z",
  });
  await writeFile(
    path.join(taskGuardHome, "usage-history.jsonl"),
    `${valid}\n{"broken":\n${valid}\n`,
    "utf8",
  );

  await assert.rejects(
    readUsageHistory({ taskGuardHome }),
    /HISTORY_CORRUPTED: invalid JSONL record at line 2/,
  );
});

test("internal history reads keep every retained cohort while explicit limits stay recent", async () => {
  const taskGuardHome = await mkdtemp(path.join(os.tmpdir(), "task-guard-history-limit-"));
  const records = Array.from({ length: 600 }, (_, index) => ({
    task_id: `task-${index}`,
    phase_id: "phase",
    started_at: new Date(Date.UTC(2026, 0, 1, 0, 0, index)).toISOString(),
  }));
  await writeFile(
    path.join(taskGuardHome, "usage-history.jsonl"),
    `${records.map((record) => JSON.stringify(record)).join("\n")}\n`,
    "utf8",
  );

  assert.equal((await readUsageHistory({ taskGuardHome })).length, 600);
  assert.deepEqual(
    (await readUsageHistory({ taskGuardHome, limit: 2 })).map(({ task_id: taskId }) => taskId),
    ["task-598", "task-599"],
  );
});

test("phase completion compacts history without evicting a rare cohort", async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), "task-guard-history-retention-"));
  const projectPath = path.join(root, "project");
  const taskGuardHome = path.join(root, "global");
  await mkdir(projectPath);
  const record = (index, phaseType) => ({
    schema_version: 2,
    phase_run_id: `run-${index}`,
    task_id: `task-${index}`,
    phase_id: "phase",
    phase_type: phaseType,
    model: "gpt-5.6-sol",
    reasoning_effort: "high",
    plan: "plus",
    started_at: new Date(Date.UTC(2026, 0, 1, 0, 0, index % 60)).toISOString(),
    quota_delta: 1,
    reset_occurred: false,
    measurement_confidence: "HIGH_CONFIDENCE",
  });
  const existing = Array.from({ length: 2_500 }, (_, index) => (
    record(index, index < 25 ? "rare" : "common")
  ));
  await mkdir(taskGuardHome);
  await writeFile(
    path.join(taskGuardHome, "usage-history.jsonl"),
    `${existing.map((entry) => JSON.stringify(entry)).join("\n")}\n`,
    "utf8",
  );
  await startPhase({
    projectPath,
    taskGuardHome,
    metadata: {
      task_id: "current-task",
      phase_id: "current-phase",
      phase_type: "common",
      model: "gpt-5.6-sol",
      reasoning_effort: "high",
      plan: "plus",
    },
    snapshot: authoritativeSnapshot(60, "2026-08-31T01:00:00.000Z"),
  });

  const completed = await completePhase({
    projectPath,
    taskGuardHome,
    phaseId: "current-phase",
    concurrentUsage: false,
    snapshot: authoritativeSnapshot(55, "2026-08-31T01:10:00.000Z"),
  });
  const retained = await readUsageHistory({ taskGuardHome });

  assert.equal(retained.length, 2_000);
  assert.equal(retained.filter(({ phase_type: phaseType }) => phaseType === "rare").length, 25);
  assert.equal(retained.at(-1).phase_run_id, completed.phase_run_id);
});
