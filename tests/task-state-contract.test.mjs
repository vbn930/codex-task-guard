import assert from "node:assert/strict";
import test from "node:test";

import {
  TASK_STATUS,
  isActiveTaskStatus,
  normalizeTaskStatus,
} from "../scripts/lib/task-state-contract.mjs";

test("task state contract normalizes supported durable statuses", () => {
  assert.equal(normalizeTaskStatus(" working "), TASK_STATUS.WORKING);
  assert.equal(
    normalizeTaskStatus("paused_for_quota"),
    TASK_STATUS.PAUSED_FOR_QUOTA,
  );
});

test("task state contract rejects unsupported durable statuses", () => {
  assert.throws(() => normalizeTaskStatus("BLOCKED"), /Invalid task status/);
  assert.throws(() => normalizeTaskStatus(null), /Invalid task status/);
});

test("both persisted task statuses represent an active checkpoint owner", () => {
  assert.equal(isActiveTaskStatus(TASK_STATUS.WORKING), true);
  assert.equal(isActiveTaskStatus(TASK_STATUS.PAUSED_FOR_QUOTA), true);
  assert.equal(isActiveTaskStatus("BLOCKED"), false);
});
