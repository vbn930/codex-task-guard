import assert from "node:assert/strict";
import { mkdtemp } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";

import { normalizeQuotaResponse } from "../scripts/lib/quota.mjs";
import {
  QuotaSnapshotStore,
  validateFreshness,
} from "../scripts/lib/quota-snapshot.mjs";

test("refresh creates and records an authoritative timestamped quota snapshot", async () => {
  const taskGuardHome = await mkdtemp(path.join(os.tmpdir(), "task-guard-snapshot-"));
  const observedAt = "2026-08-31T12:23:31.421Z";
  const store = new QuotaSnapshotStore({
    taskGuardHome,
    reader: async () => normalizeQuotaResponse({
      rateLimits: {
        primary: { usedPercent: 90, windowDurationMins: 300, resetsAt: 1_800_000_000 },
        secondary: { usedPercent: 35, windowDurationMins: 10_080, resetsAt: 1_800_500_000 },
      },
    }, { observedAt }),
  });

  const snapshot = await store.refresh();

  assert.equal(snapshot.freshness, "AUTHORITATIVE");
  assert.equal(snapshot.availability, "AVAILABLE");
  assert.equal(snapshot.observed_at, observedAt);
  assert.equal(snapshot.source, "codex_app_server");
  assert.equal(snapshot.five_hour.used_percent, 90);
  assert.equal(snapshot.five_hour.remaining_percent, 10);
  assert.equal(snapshot.weekly.remaining_percent, 65);
  assert.match(snapshot.snapshot_id, /^[a-f0-9]{64}$/);

  const lastKnown = await store.latest();
  assert.equal(lastKnown.snapshot_id, snapshot.snapshot_id);
  assert.equal(lastKnown.observed_at, observedAt);
  assert.equal(lastKnown.freshness, "STALE");
});

test("critical decisions reject a cached snapshot even when its quota is available", () => {
  const cached = {
    freshness: "STALE",
    five_hour: { available: true, remaining_percent: 16 },
  };

  assert.throws(
    () => validateFreshness(cached),
    /AUTHORITATIVE_QUOTA_REQUIRED/,
  );
});

test("refresh failure returns unavailable and keeps the last known snapshot stale", async () => {
  const taskGuardHome = await mkdtemp(path.join(os.tmpdir(), "task-guard-snapshot-failure-"));
  let shouldFail = false;
  const store = new QuotaSnapshotStore({
    taskGuardHome,
    now: () => new Date("2026-08-31T12:30:00.000Z"),
    reader: async () => {
      if (shouldFail) throw new Error("app-server unavailable");
      return normalizeQuotaResponse({
        rateLimits: {
          primary: { usedPercent: 84, windowDurationMins: 300, resetsAt: 1_800_000_000 },
        },
      }, { observedAt: "2026-08-31T12:20:00.000Z" });
    },
  });
  const first = await store.refresh();
  shouldFail = true;

  const failed = await store.refresh();

  assert.equal(failed.freshness, "UNAVAILABLE");
  assert.equal(failed.availability, "UNAVAILABLE");
  assert.deepEqual(failed.five_hour, { available: false });
  assert.equal(failed.error.code, "RATE_LIMIT_REFRESH_FAILED");
  assert.equal(failed.last_known_snapshot.snapshot_id, first.snapshot_id);
  assert.equal(failed.last_known_snapshot.freshness, "STALE");
  assert.equal(failed.last_known_snapshot.five_hour.remaining_percent, 16);
});

test("an authoritative observation keeps a missing five-hour window unavailable", async () => {
  const taskGuardHome = await mkdtemp(path.join(os.tmpdir(), "task-guard-snapshot-missing-"));
  const store = new QuotaSnapshotStore({
    taskGuardHome,
    reader: async () => normalizeQuotaResponse({}, {
      observedAt: "2026-08-31T13:00:00.000Z",
    }),
  });

  const snapshot = await store.refresh();

  assert.equal(snapshot.freshness, "AUTHORITATIVE");
  assert.equal(snapshot.availability, "UNAVAILABLE");
  assert.deepEqual(snapshot.five_hour, { available: false });
  assert.throws(() => validateFreshness(snapshot), /FIVE_HOUR_QUOTA_UNAVAILABLE/);
});
