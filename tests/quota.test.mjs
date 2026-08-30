import assert from "node:assert/strict";
import test from "node:test";

import { normalizeQuotaResponse } from "../scripts/lib/quota.mjs";

test("normalizes exact 300-minute and 10080-minute Codex windows", () => {
  const result = normalizeQuotaResponse({
    rateLimitsByLimitId: {
      other: {
        limitId: "other",
        primary: { usedPercent: 90, windowDurationMins: 300 },
      },
      codex: {
        limitId: "codex",
        primary: {
          usedPercent: 7,
          windowDurationMins: 300,
          resetsAt: 1_800_000_000,
        },
        secondary: {
          usedPercent: 16,
          windowDurationMins: 10_080,
          resetsAt: 1_800_500_000,
        },
      },
    },
  });

  assert.deepEqual(result.five_hour, {
    available: true,
    used_percent: 7,
    remaining_percent: 93,
    window_duration_minutes: 300,
    reset_at: "2027-01-15T08:00:00.000Z",
  });
  assert.equal(result.weekly.available, true);
  assert.equal(result.weekly.used_percent, 16);
  assert.equal(result.source, "codex_app_server");
});

test("never treats an unlabeled or weekly window as five-hour quota", () => {
  const result = normalizeQuotaResponse({
    rateLimits: {
      primary: { usedPercent: 40, windowDurationMins: 10_080 },
      secondary: { usedPercent: 20, windowDurationMins: null },
    },
  });

  assert.deepEqual(result.five_hour, { available: false });
  assert.equal(result.weekly.available, true);
});

test("returns explicit unavailable windows for an empty response", () => {
  const result = normalizeQuotaResponse({});
  assert.equal(result.source, "codex_app_server");
  assert.equal(typeof result.observed_at, "string");
  assert.deepEqual(result.five_hour, { available: false });
  assert.deepEqual(result.weekly, { available: false });
});

test("supports deterministic quota fixtures without touching Codex", () => {
  const result = normalizeQuotaResponse({
    rateLimits: {
      primary: { usedPercent: 95, windowDurationMins: 300, resetsAt: null },
      secondary: { usedPercent: 25, windowDurationMins: 10_080, resetsAt: null },
    },
  }, { source: "test_fixture", observedAt: "2026-08-31T00:00:00.000Z" });

  assert.equal(result.source, "test_fixture");
  assert.equal(result.observed_at, "2026-08-31T00:00:00.000Z");
  assert.equal(result.five_hour.remaining_percent, 5);
  assert.equal(result.five_hour.reset_at, null);
});

test("falls back to legacy Codex limits instead of another named product", () => {
  const result = normalizeQuotaResponse({
    rateLimitsByLimitId: {
      spark: {
        limitId: "spark",
        primary: { usedPercent: 99, windowDurationMins: 300 },
        secondary: { usedPercent: 88, windowDurationMins: 10_080 },
      },
    },
    rateLimits: {
      primary: { usedPercent: 10, windowDurationMins: 300 },
      secondary: { usedPercent: 20, windowDurationMins: 10_080 },
    },
  });

  assert.equal(result.five_hour.used_percent, 10);
  assert.equal(result.weekly.used_percent, 20);
});
