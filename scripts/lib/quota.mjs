const FIVE_HOUR_MINUTES = 300;
const WEEK_MINUTES = 10_080;

function clampPercent(value) {
  return Math.min(100, Math.max(0, value));
}

function toIsoTimestamp(value) {
  if (!Number.isFinite(value)) return null;
  const date = new Date(value * 1000);
  return Number.isNaN(date.valueOf()) ? null : date.toISOString();
}

function normalizeWindow(window) {
  if (!window || !Number.isFinite(window.usedPercent)) return null;
  const usedPercent = clampPercent(window.usedPercent);
  return {
    available: true,
    used_percent: usedPercent,
    remaining_percent: 100 - usedPercent,
    window_duration_minutes: window.windowDurationMins,
    reset_at: toIsoTimestamp(window.resetsAt),
  };
}

function snapshotsFrom(response) {
  const byId = response?.rateLimitsByLimitId;
  if (byId && typeof byId === "object") {
    const codex = byId.codex;
    if (codex) return [codex];
    return response?.rateLimits ? [response.rateLimits] : [];
  }
  return response?.rateLimits ? [response.rateLimits] : [];
}

function findExactWindow(snapshots, durationMinutes) {
  for (const snapshot of snapshots) {
    for (const window of [snapshot?.primary, snapshot?.secondary]) {
      if (window?.windowDurationMins === durationMinutes) {
        return normalizeWindow(window);
      }
    }
  }
  return null;
}

export function normalizeQuotaResponse(
  response,
  { source = "codex_app_server", observedAt = new Date().toISOString() } = {},
) {
  const snapshots = snapshotsFrom(response);
  return {
    source,
    observed_at: observedAt,
    five_hour: findExactWindow(snapshots, FIVE_HOUR_MINUTES) ?? {
      available: false,
    },
    weekly: findExactWindow(snapshots, WEEK_MINUTES) ?? { available: false },
  };
}

const TEST_FIXTURES = {
  healthy: {
    primary: {
      usedPercent: 20,
      windowDurationMins: FIVE_HOUR_MINUTES,
      resetsAt: 1_800_000_000,
    },
    secondary: { usedPercent: 25, windowDurationMins: WEEK_MINUTES, resetsAt: 1_800_500_000 },
  },
  low: {
    primary: {
      usedPercent: 95,
      windowDurationMins: FIVE_HOUR_MINUTES,
      resetsAt: 1_800_000_000,
    },
    secondary: { usedPercent: 80, windowDurationMins: WEEK_MINUTES, resetsAt: 1_800_500_000 },
  },
  unavailable: {},
};

export function quotaFromTestFixture(name, observedAt = new Date().toISOString()) {
  if (!(name in TEST_FIXTURES)) {
    throw new Error(
      `TASK_GUARD_TEST_QUOTA must be healthy, low, or unavailable; received ${name}`,
    );
  }
  return normalizeQuotaResponse(
    { rateLimits: TEST_FIXTURES[name] },
    { source: "test_fixture", observedAt },
  );
}
