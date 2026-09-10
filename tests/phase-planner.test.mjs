import assert from "node:assert/strict";
import test from "node:test";

import {
  evaluatePhasePlan,
  evaluatePlannedBudget,
} from "../scripts/lib/phase-planner.mjs";

test("derives ready phases from declared dependencies instead of caller booleans", () => {
  const result = evaluatePhasePlan({
    completedPhaseIds: ["design"],
    phases: [
      { phase_id: "design", phase_type: "planning", depends_on: [] },
      { phase_id: "backend", phase_type: "implementation", depends_on: ["design"] },
      { phase_id: "frontend", phase_type: "implementation", depends_on: ["design"] },
      {
        phase_id: "integration",
        phase_type: "testing",
        depends_on: ["backend", "frontend"],
      },
    ],
  });

  assert.deepEqual(result.phases.map(({ phase_id, status, dependencies_met }) => ({
    phase_id,
    status,
    dependencies_met,
  })), [
    { phase_id: "design", status: "COMPLETED", dependencies_met: false },
    { phase_id: "backend", status: "READY", dependencies_met: true },
    { phase_id: "frontend", status: "READY", dependencies_met: true },
    { phase_id: "integration", status: "DEPENDENCY_BLOCKED", dependencies_met: false },
  ]);
  assert.deepEqual(result.ready_phase_ids, ["backend", "frontend"]);
});

test("rejects dependencies that are not part of the phase plan", () => {
  assert.throws(
    () => evaluatePhasePlan({
      phases: [{ phase_id: "integration", phase_type: "testing", depends_on: ["backend"] }],
    }),
    /integration depends on unknown phase backend/,
  );
});

test("rejects a cyclic phase plan before budget selection", () => {
  assert.throws(
    () => evaluatePhasePlan({
      phases: [
        { phase_id: "backend", phase_type: "implementation", depends_on: ["frontend"] },
        { phase_id: "frontend", phase_type: "implementation", depends_on: ["backend"] },
      ],
    }),
    /phase plan contains a dependency cycle/,
  );
});

test("applies the quota estimator only to phases made ready by the dependency graph", () => {
  const shared = {
    task_id: "task-native",
    model: "gpt-test",
    reasoning_effort: "high",
    plan: "native-v1",
  };
  const result = evaluatePlannedBudget({
    completedPhaseIds: ["design"],
    history: [
      {
        ...shared,
        phase_id: "previous-implementation",
        phase_type: "implementation",
        quota_delta: 8,
        estimated_files: 2,
        measurement_confidence: "HIGH_CONFIDENCE",
        reset_occurred: false,
      },
      {
        ...shared,
        phase_id: "previous-large-implementation",
        phase_type: "implementation",
        quota_delta: 16,
        estimated_files: 6,
        measurement_confidence: "HIGH_CONFIDENCE",
        reset_occurred: false,
      },
      {
        ...shared,
        phase_id: "previous-testing",
        phase_type: "testing",
        quota_delta: 2,
        measurement_confidence: "HIGH_CONFIDENCE",
        reset_occurred: false,
      },
    ],
    phases: [
      { ...shared, phase_id: "design", phase_type: "planning", depends_on: [] },
      {
        ...shared,
        phase_id: "backend",
        phase_type: "implementation",
        depends_on: ["design"],
        estimated_files: 2,
      },
      {
        ...shared,
        phase_id: "frontend",
        phase_type: "implementation",
        depends_on: ["design"],
        estimated_files: 6,
      },
      {
        ...shared,
        phase_id: "integration",
        phase_type: "testing",
        depends_on: ["backend", "frontend"],
        dependencies_met: true,
      },
    ],
    safetyReservePercent: 5,
    snapshot: {
      source: "test",
      observed_at: "2026-09-10T10:00:00.000Z",
      freshness: "AUTHORITATIVE",
      snapshot_id: "snapshot-native",
      five_hour: { available: true, remaining_percent: 20 },
    },
  });

  assert.equal(result.selected_phase_id, "backend");
  assert.deepEqual(result.phases.map(({ phase_id, status }) => [phase_id, status]), [
    ["design", "COMPLETED"],
    ["backend", "FITS"],
    ["frontend", "TOO_LARGE"],
    ["integration", "DEPENDENCY_BLOCKED"],
  ]);
});

test("reports a completed native plan without asking the estimator to select work", () => {
  const result = evaluatePlannedBudget({
    completedPhaseIds: ["design"],
    history: [],
    phases: [{
      task_id: "native-task",
      phase_id: "design",
      phase_type: "planning",
      depends_on: [],
      model: "gpt-test",
      reasoning_effort: "high",
    }],
    safetyReservePercent: 5,
    snapshot: {
      source: "test",
      observed_at: "2026-09-10T10:00:00.000Z",
      freshness: "AUTHORITATIVE",
      snapshot_id: "snapshot-complete",
      five_hour: { available: true, remaining_percent: 20 },
    },
  });

  assert.equal(result.decision, "PLAN_COMPLETE");
  assert.equal(result.selected_phase_id, null);
  assert.deepEqual(result.phases, [{
    phase_id: "design",
    status: "COMPLETED",
    estimated_upper_cost: null,
  }]);
});
