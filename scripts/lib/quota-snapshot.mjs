import { createHash } from "node:crypto";
import { readFile } from "node:fs/promises";
import path from "node:path";

import { readRateLimits } from "./app-server.mjs";
import { atomicWriteText } from "./fs-safe.mjs";
import { normalizeQuotaResponse } from "./quota.mjs";
import { defaultTaskGuardHome } from "./runtime-paths.mjs";

function unavailableWindow() {
  return { available: false };
}

export function unavailableQuotaSnapshot({
  source = "codex_app_server",
  observedAt = new Date(),
  lastKnownSnapshot,
  errorCode = "RATE_LIMIT_REFRESH_FAILED",
} = {}) {
  const date = observedAt instanceof Date ? observedAt : new Date(observedAt);
  return {
    source,
    observed_at: Number.isNaN(date.valueOf()) ? new Date().toISOString() : date.toISOString(),
    freshness: "UNAVAILABLE",
    availability: "UNAVAILABLE",
    five_hour: unavailableWindow(),
    weekly: unavailableWindow(),
    error: { code: errorCode },
    ...(lastKnownSnapshot ? {
      last_known_snapshot: { ...lastKnownSnapshot, freshness: "STALE" },
    } : {}),
  };
}

function normalizeStoredWindow(window) {
  if (!window?.available) return unavailableWindow();
  return {
    available: true,
    used_percent: window.used_percent,
    remaining_percent: window.remaining_percent,
    window_duration_minutes: window.window_duration_minutes,
    reset_at: window.reset_at ?? null,
  };
}

function availabilityFor(snapshot) {
  if (snapshot.five_hour.available && snapshot.weekly.available) return "AVAILABLE";
  if (snapshot.five_hour.available || snapshot.weekly.available) return "PARTIAL";
  return "UNAVAILABLE";
}

function snapshotId(snapshot) {
  return createHash("sha256").update(JSON.stringify({
    source: snapshot.source,
    observed_at: snapshot.observed_at,
    five_hour: snapshot.five_hour,
    weekly: snapshot.weekly,
  })).digest("hex");
}

function asAuthoritativeSnapshot(observation) {
  const observedAt = new Date(observation?.observed_at ?? "");
  if (Number.isNaN(observedAt.valueOf())) throw new Error("Quota snapshot observed_at is invalid");
  if (typeof observation?.source !== "string" || observation.source.trim() === "") {
    throw new Error("Quota snapshot source is required");
  }
  const snapshot = {
    source: observation.source,
    observed_at: observedAt.toISOString(),
    freshness: "AUTHORITATIVE",
    five_hour: normalizeStoredWindow(observation.five_hour),
    weekly: normalizeStoredWindow(observation.weekly),
  };
  snapshot.availability = availabilityFor(snapshot);
  snapshot.snapshot_id = snapshotId(snapshot);
  return snapshot;
}

export class QuotaSnapshotStore {
  constructor({
    taskGuardHome = defaultTaskGuardHome(),
    reader,
    now = () => new Date(),
    source = "codex_app_server",
    snapshotWriter = atomicWriteText,
  } = {}) {
    if (typeof reader !== "function") throw new Error("Quota snapshot reader is required");
    if (typeof snapshotWriter !== "function") throw new Error("Snapshot writer must be a function");
    this.reader = reader;
    this.now = now;
    this.source = source;
    this.snapshotWriter = snapshotWriter;
    this.snapshotPath = path.join(taskGuardHome, "quota-snapshot.json");
  }

  async refresh() {
    let observation;
    try {
      observation = await this.reader();
    } catch {
      const lastKnown = await this.latest().catch(() => null);
      return unavailableQuotaSnapshot({
        source: this.source,
        observedAt: this.now(),
        lastKnownSnapshot: lastKnown,
      });
    }

    let snapshot;
    try {
      snapshot = asAuthoritativeSnapshot(observation);
    } catch {
      const lastKnown = await this.latest().catch(() => null);
      return unavailableQuotaSnapshot({
        source: this.source,
        observedAt: this.now(),
        lastKnownSnapshot: lastKnown,
        errorCode: "QUOTA_NORMALIZATION_FAILED",
      });
    }

    try {
      await this.record(snapshot);
      return snapshot;
    } catch {
      return {
        ...snapshot,
        persistence: {
          status: "FAILED",
          error_code: "SNAPSHOT_PERSIST_FAILED",
        },
      };
    }
  }

  async latest() {
    try {
      const snapshot = JSON.parse(await readFile(this.snapshotPath, "utf8"));
      return { ...snapshot, freshness: "STALE" };
    } catch (error) {
      if (error.code === "ENOENT") return null;
      throw error;
    }
  }

  async record(snapshot) {
    const authoritative = asAuthoritativeSnapshot(snapshot);
    await this.snapshotWriter(this.snapshotPath, `${JSON.stringify(authoritative, null, 2)}\n`);
    return authoritative;
  }
}

export function createQuotaSnapshotStore(options = {}) {
  const reader = options.reader ?? (async () => normalizeQuotaResponse(await readRateLimits()));
  return new QuotaSnapshotStore({ ...options, reader });
}

export function validateFreshness(snapshot, { requireFiveHour = true } = {}) {
  if (snapshot?.freshness !== "AUTHORITATIVE") {
    throw new Error("AUTHORITATIVE_QUOTA_REQUIRED");
  }
  if (requireFiveHour && !snapshot.five_hour?.available) {
    throw new Error("FIVE_HOUR_QUOTA_UNAVAILABLE");
  }
  return snapshot;
}

export function validateVerifiedFiveHourReset(snapshot) {
  const authoritative = validateFreshness(snapshot);
  const resetAt = authoritative.five_hour.reset_at;
  const observedAt = authoritative.observed_at;
  if (
    authoritative.five_hour.window_duration_minutes !== 300
    || typeof resetAt !== "string"
    || Number.isNaN(Date.parse(resetAt))
    || typeof observedAt !== "string"
    || Number.isNaN(Date.parse(observedAt))
    || Date.parse(resetAt) <= Date.parse(observedAt)
  ) {
    throw new Error("VERIFIED_FIVE_HOUR_RESET_REQUIRED");
  }
  return authoritative;
}
