import assert from "node:assert/strict";
import test from "node:test";

import {
  TASK_RESUME_MODE,
  TASK_STATUS,
  isActiveTaskStatus,
  normalizeTaskStatus,
  transitionTaskToQuotaPause,
  transitionTaskToWorking,
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

test("resuming a paused task clears pause-only state", () => {
  const resumed = transitionTaskToWorking({
    status: "paused_for_quota",
    resume_after: "2026-09-10T00:00:00.000Z",
    heartbeat_automation_id: "automation-123",
  }, {
    resumedAt: "2026-09-10T00:01:00.000Z",
    heartbeatCleanupConfirmed: true,
  });

  assert.deepEqual(resumed, {
    status: TASK_STATUS.WORKING,
    resume_after: null,
    resumed_at: "2026-09-10T00:01:00.000Z",
  });
});

test("resuming requires cleanup confirmation for a verified automation", () => {
  assert.throws(() => transitionTaskToWorking({
    status: TASK_STATUS.PAUSED_FOR_QUOTA,
    resume_automation: {
      status: "VERIFIED",
      cleanup_required: true,
    },
  }, {
    resumedAt: "2026-09-10T00:01:00.000Z",
  }), /Heartbeat cleanup confirmation is required/);
});

test("resuming records a verified automation as executed", () => {
  const resumedAt = "2026-09-10T00:01:00.000Z";
  const resumed = transitionTaskToWorking({
    status: TASK_STATUS.PAUSED_FOR_QUOTA,
    resume_automation: {
      purpose: "quota_resume",
      status: "VERIFIED",
      automation_id: "automation-123",
      cleanup_required: true,
    },
  }, {
    resumedAt,
    heartbeatCleanupConfirmed: true,
  });

  assert.deepEqual(resumed.resume_automation, {
    purpose: "quota_resume",
    status: "EXECUTED",
    automation_id: "automation-123",
    cleanup_required: false,
    executed_at: resumedAt,
  });
});

test("quota pause stores one canonical scheduling state", () => {
  const snapshot = {
    source: "test",
    observed_at: "2026-09-10T00:00:00.000Z",
    freshness: "AUTHORITATIVE",
    five_hour: { reset_at: "2026-09-10T05:00:00.000Z" },
    weekly: { reset_at: "2026-09-15T00:00:00.000Z" },
    snapshot_id: "snapshot-123",
  };
  const paused = transitionTaskToQuotaPause({
    task_id: "task-123",
    status: TASK_STATUS.WORKING,
  }, {
    snapshot,
    resumeAfter: snapshot.five_hour.reset_at,
    threadReference: "current",
    resumeMode: "MANUAL",
    resumeAutomation: {
      purpose: "quota_resume",
      status: "FAILED",
      automation_id: null,
      attempts: 0,
    },
  });

  assert.equal(paused.status, TASK_STATUS.PAUSED_FOR_QUOTA);
  assert.equal(paused.quota_snapshot, snapshot);
  assert.equal(paused.quota.five_hour, snapshot.five_hour);
  assert.equal(paused.resume_after, snapshot.five_hour.reset_at);
  assert.equal(paused.thread_reference, "current");
  assert.equal(paused.resume_mode, "MANUAL");
});

test("quota pause rejects automation metadata for a different thread", () => {
  const snapshot = {
    source: "test",
    observed_at: "2026-09-10T00:00:00.000Z",
    freshness: "AUTHORITATIVE",
    five_hour: { reset_at: "2026-09-10T05:00:00.000Z" },
    weekly: {},
    snapshot_id: "snapshot-123",
  };

  assert.throws(() => transitionTaskToQuotaPause({
    task_id: "task-123",
    status: TASK_STATUS.WORKING,
  }, {
    snapshot,
    resumeAfter: snapshot.five_hour.reset_at,
    threadReference: "thread-123",
    resumeMode: "AUTOMATION_ELIGIBLE",
    resumeAutomation: {
      purpose: "quota_resume",
      status: "ELIGIBLE",
      target_thread: "thread-other",
      resume_after: snapshot.five_hour.reset_at,
      snapshot_id: snapshot.snapshot_id,
    },
  }), /target_thread does not match/);
});

test("quota pause rejects automation metadata for a different reset", () => {
  const snapshot = {
    source: "test",
    observed_at: "2026-09-10T00:00:00.000Z",
    freshness: "AUTHORITATIVE",
    five_hour: { reset_at: "2026-09-10T05:00:00.000Z" },
    weekly: {},
    snapshot_id: "snapshot-123",
  };

  assert.throws(() => transitionTaskToQuotaPause({
    task_id: "task-123",
    status: TASK_STATUS.WORKING,
  }, {
    snapshot,
    resumeAfter: snapshot.five_hour.reset_at,
    threadReference: "thread-123",
    resumeMode: "AUTOMATION_ELIGIBLE",
    resumeAutomation: {
      purpose: "quota_resume",
      status: "ELIGIBLE",
      target_thread: "thread-123",
      resume_after: "2026-09-10T06:00:00.000Z",
      snapshot_id: snapshot.snapshot_id,
    },
  }), /resume_after does not match/);
});

test("quota pause rejects automation metadata from a different quota snapshot", () => {
  const snapshot = {
    source: "test",
    observed_at: "2026-09-10T00:00:00.000Z",
    freshness: "AUTHORITATIVE",
    five_hour: { reset_at: "2026-09-10T05:00:00.000Z" },
    weekly: {},
    snapshot_id: "snapshot-123",
  };

  assert.throws(() => transitionTaskToQuotaPause({
    task_id: "task-123",
    status: TASK_STATUS.WORKING,
  }, {
    snapshot,
    resumeAfter: snapshot.five_hour.reset_at,
    threadReference: "thread-123",
    resumeMode: "AUTOMATION_ELIGIBLE",
    resumeAutomation: {
      purpose: "quota_resume",
      status: "ELIGIBLE",
      target_thread: "thread-123",
      resume_after: snapshot.five_hour.reset_at,
      snapshot_id: "snapshot-other",
    },
  }), /snapshot_id does not match/);
});

test("quota pause rejects an automation status that conflicts with resume mode", () => {
  const snapshot = {
    source: "test",
    observed_at: "2026-09-10T00:00:00.000Z",
    freshness: "AUTHORITATIVE",
    five_hour: { reset_at: "2026-09-10T05:00:00.000Z" },
    weekly: {},
    snapshot_id: "snapshot-123",
  };

  assert.throws(() => transitionTaskToQuotaPause({
    task_id: "task-123",
    status: TASK_STATUS.WORKING,
  }, {
    snapshot,
    resumeAfter: snapshot.five_hour.reset_at,
    threadReference: "current",
    resumeMode: TASK_RESUME_MODE.MANUAL,
    resumeAutomation: {
      purpose: "quota_resume",
      status: "ELIGIBLE",
    },
  }), /resume mode does not match automation status/);
});
