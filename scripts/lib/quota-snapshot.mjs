import { createHash, randomUUID } from "node:crypto";
import { mkdir, readFile, rename, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";

import { readRateLimits } from "./app-server.mjs";
import { normalizeQuotaResponse } from "./quota.mjs";

function defaultTaskGuardHome() {
  const codexHome = process.env.CODEX_HOME ?? path.join(os.homedir(), ".codex");
  return process.env.TASK_GUARD_HOME ?? path.join(codexHome, "task-guard");
}

function unavailableWindow() {
  return { available: false };
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

async function atomicWrite(filePath, content) {
  await mkdir(path.dirname(filePath), { recursive: true });
  const temporaryPath = `${filePath}.${process.pid}.${randomUUID()}.tmp`;
  await writeFile(temporaryPath, content, "utf8");
  await rename(temporaryPath, filePath);
}

export class QuotaSnapshotStore {
  constructor({
    taskGuardHome = defaultTaskGuardHome(),
    reader,
    now = () => new Date(),
    source = "codex_app_server",
  } = {}) {
    if (typeof reader !== "function") throw new Error("Quota snapshot reader is required");
    this.reader = reader;
    this.now = now;
    this.source = source;
    this.snapshotPath = path.join(taskGuardHome, "quota-snapshot.json");
  }

  async refresh() {
    try {
      const snapshot = asAuthoritativeSnapshot(await this.reader());
      await this.record(snapshot);
      return snapshot;
    } catch {
      const observedAt = this.now();
      const date = observedAt instanceof Date ? observedAt : new Date(observedAt);
      const lastKnown = await this.latest();
      return {
        source: this.source,
        observed_at: Number.isNaN(date.valueOf()) ? new Date().toISOString() : date.toISOString(),
        freshness: "UNAVAILABLE",
        availability: "UNAVAILABLE",
        five_hour: unavailableWindow(),
        weekly: unavailableWindow(),
        error: { code: "RATE_LIMIT_REFRESH_FAILED" },
        ...(lastKnown ? { last_known_snapshot: lastKnown } : {}),
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
    await atomicWrite(this.snapshotPath, `${JSON.stringify(authoritative, null, 2)}\n`);
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
