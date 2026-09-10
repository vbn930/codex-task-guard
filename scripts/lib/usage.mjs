import { createHash, randomUUID } from "node:crypto";
import {
  appendFile,
  mkdir,
  open,
  readFile,
  rm,
} from "node:fs/promises";
import path from "node:path";

import { atomicWriteText, withFileLock } from "./fs-safe.mjs";
import { validateFreshness } from "./quota-snapshot.mjs";
import { canonicalProjectIdentity, resolveProjectRoot } from "./repository-state.mjs";
import { defaultTaskGuardHome } from "./runtime-paths.mjs";

const REQUIRED_METADATA = ["task_id", "phase_id", "phase_type", "model", "reasoning_effort"];
const OPTIONAL_METADATA = [
  "plan",
  "context_bucket",
  "files_before",
  "expected_files_touched",
  "tool_profile",
  "model_source",
  "reasoning_effort_source",
];
const RECENT_ESTIMATE_MIN_SAMPLES = 20;
const RECENT_ESTIMATE_WINDOW = 50;
const RECENT_ESTIMATE_PERCENTILE = 90;
const HISTORY_COMPACT_AT = 2_500;
const HISTORY_RETAINED_RECORDS = 2_000;
const HISTORY_RECORDS_PER_COHORT = 50;

function timestamp(now) {
  const value = now();
  const date = value instanceof Date ? value : new Date(value);
  if (Number.isNaN(date.valueOf())) throw new Error("Invalid phase timestamp");
  return date;
}

function requireSnapshot(snapshot) {
  validateFreshness(snapshot);
  if (!Number.isFinite(snapshot.five_hour.remaining_percent)) {
    throw new Error("Five-hour quota is unavailable");
  }
  return snapshot;
}

function normalizeMetadata(metadata) {
  for (const key of REQUIRED_METADATA) {
    if (typeof metadata?.[key] !== "string" || metadata[key].trim() === "") {
      throw new Error(`${key} is required`);
    }
  }
  const normalized = {};
  for (const key of [...REQUIRED_METADATA, ...OPTIONAL_METADATA]) {
    const value = metadata[key];
    if (value !== undefined && value !== null && value !== "") normalized[key] = value;
  }
  for (const key of ["files_before", "expected_files_touched"]) {
    if (normalized[key] !== undefined
      && (!Number.isInteger(normalized[key]) || normalized[key] < 0)) {
      throw new Error(`${key} must be a non-negative integer`);
    }
  }
  return normalized;
}

function activePhasePath(projectPath, taskGuardHome) {
  const projectKey = createHash("sha256").update(canonicalProjectIdentity(projectPath)).digest("hex");
  return path.join(taskGuardHome, "active-phases", `${projectKey}.json`);
}

function legacyPhaseRunId(record) {
  const identity = JSON.stringify([record.task_id, record.phase_id, record.started_at]);
  return `legacy-${createHash("sha256").update(identity).digest("hex")}`;
}

async function withHistoryLock(taskGuardHome, operation) {
  return withFileLock(path.join(taskGuardHome, "usage-history.lock"), operation, {
    timeoutMessage: "Timed out waiting for the usage history lock",
  });
}

export async function startPhase({
  projectPath,
  metadata,
  snapshot,
  taskGuardHome = defaultTaskGuardHome(),
  now = () => new Date(),
}) {
  const normalized = normalizeMetadata(metadata);
  const authoritative = requireSnapshot(snapshot);
  const quota = authoritative.five_hour;
  const startedAt = timestamp(now);
  const projectRoot = await resolveProjectRoot(projectPath, { allowNonGit: true });
  const state = {
    ...normalized,
    phase_run_id: randomUUID(),
    project_path: projectRoot,
    project: path.basename(projectRoot),
    started_at: startedAt.toISOString(),
    quota_before: quota.remaining_percent,
    quota_before_observed_at: authoritative.observed_at,
    quota_before_source: authoritative.source,
    quota_before_snapshot_id: authoritative.snapshot_id,
    quota_before_window_duration_minutes: quota.window_duration_minutes,
    reset_at_before: quota.reset_at ?? null,
  };
  const statePath = activePhasePath(projectRoot, taskGuardHome);
  await mkdir(path.dirname(statePath), { recursive: true });
  let handle;
  try {
    handle = await open(statePath, "wx");
  } catch (error) {
    if (error.code === "EEXIST") throw new Error("An active phase already exists for this project");
    throw error;
  }
  try {
    await handle.writeFile(`${JSON.stringify(state, null, 2)}\n`, "utf8");
  } finally {
    await handle.close();
  }
  return {
    phase_id: state.phase_id,
    phase_run_id: state.phase_run_id,
    model: state.model,
    reasoning_effort: state.reasoning_effort,
    ...(state.model_source ? { model_source: state.model_source } : {}),
    ...(state.reasoning_effort_source
      ? { reasoning_effort_source: state.reasoning_effort_source }
      : {}),
    started_at: state.started_at,
    quota_before: state.quota_before,
    quota_before_observed_at: state.quota_before_observed_at,
    quota_before_snapshot_id: state.quota_before_snapshot_id,
    reset_at_before: state.reset_at_before,
  };
}

export async function completePhase({
  projectPath,
  phaseId,
  concurrentUsage = null,
  snapshot,
  taskGuardHome = defaultTaskGuardHome(),
  now = () => new Date(),
  activeStateRemover = rm,
}) {
  if (![true, false, null].includes(concurrentUsage)) {
    throw new Error("concurrentUsage must be true, false, or null");
  }
  const projectRoot = await resolveProjectRoot(projectPath, { allowNonGit: true });
  const statePath = activePhasePath(projectRoot, taskGuardHome);
  return withFileLock(`${statePath}.lock`, () => completePhaseLocked({
    statePath,
    phaseId,
    concurrentUsage,
    snapshot,
    taskGuardHome,
    now,
    activeStateRemover,
  }), { timeoutMessage: "Timed out waiting for the usage history lock" });
}

async function completePhaseLocked({
  statePath,
  phaseId,
  concurrentUsage,
  snapshot,
  taskGuardHome,
  now,
  activeStateRemover,
}) {
  const state = JSON.parse(await readFile(statePath, "utf8"));
  if (state.phase_id !== phaseId) throw new Error("Active phase ID does not match");
  const phaseRunId = state.phase_run_id ?? legacyPhaseRunId(state);
  const existingRecord = await withHistoryLock(taskGuardHome, async () => {
    const history = await loadAndRepairUsageHistory(taskGuardHome);
    const records = await compactHistoryIfNeeded(history);
    return records.find((record) => record.phase_run_id === phaseRunId) ?? null;
  });
  if (existingRecord) {
    await activeStateRemover(statePath, { force: true });
    return existingRecord;
  }

  const authoritative = requireSnapshot(snapshot);
  const quota = authoritative.five_hour;
  const completedAt = timestamp(now);
  const sameDuration = state.quota_before_window_duration_minutes === quota.window_duration_minutes;
  const verifiedResetIdentity = Boolean(state.reset_at_before && quota.reset_at);
  const resetChanged = verifiedResetIdentity && state.reset_at_before !== quota.reset_at;
  const quotaIncreased = quota.remaining_percent > state.quota_before;
  const resetOccurred = resetChanged || quotaIncreased;
  const sameWindow = verifiedResetIdentity
    && sameDuration
    && state.reset_at_before === quota.reset_at
    && !quotaIncreased;
  const windowIdentity = sameWindow
    ? "SAME_WINDOW"
    : resetOccurred ? "RESET_OCCURRED" : "UNKNOWN";
  const quotaDelta = sameWindow
    ? Math.max(0, state.quota_before - quota.remaining_percent)
    : null;
  const concurrencyKnown = concurrentUsage !== null;
  const concurrencyStatus = concurrentUsage === false
    ? "NONE"
    : concurrentUsage === true ? "DETECTED" : "UNKNOWN";
  const measurementConfidence = sameWindow && concurrentUsage === false
    ? "HIGH_CONFIDENCE"
    : "LOW_CONFIDENCE";
  const record = {
    schema_version: 2,
    phase_run_id: phaseRunId,
    project: state.project,
    task_id: state.task_id,
    phase_id: state.phase_id,
    phase_type: state.phase_type,
    model: state.model,
    reasoning_effort: state.reasoning_effort,
    ...Object.fromEntries(OPTIONAL_METADATA.flatMap((key) => (
      state[key] === undefined ? [] : [[key, state[key]]]
    ))),
    quota_before: state.quota_before,
    quota_before_observed_at: state.quota_before_observed_at,
    quota_before_source: state.quota_before_source,
    quota_before_snapshot_id: state.quota_before_snapshot_id,
    quota_after: quota.remaining_percent,
    quota_after_observed_at: authoritative.observed_at,
    quota_after_source: authoritative.source,
    quota_after_snapshot_id: authoritative.snapshot_id,
    quota_delta: quotaDelta,
    reset_at_before: state.reset_at_before,
    reset_at_after: quota.reset_at ?? null,
    started_at: state.started_at,
    completed_at: completedAt.toISOString(),
    duration_seconds: Math.max(0, Math.round(
      (completedAt.valueOf() - new Date(state.started_at).valueOf()) / 1_000,
    )),
    reset_occurred: resetOccurred,
    window_identity: windowIdentity,
    concurrency_known: concurrencyKnown,
    concurrent_usage: concurrentUsage,
    concurrency_status: concurrencyStatus,
    external_usage_possible: concurrentUsage !== false,
    measurement_confidence: measurementConfidence,
  };

  let committedRecord;
  await withHistoryLock(taskGuardHome, async () => {
    const history = await loadAndRepairUsageHistory(taskGuardHome);
    committedRecord = history.records.find((entry) => entry.phase_run_id === phaseRunId) ?? null;
    if (!committedRecord) {
      await appendFile(
        history.historyPath,
        `${JSON.stringify(record)}\n`,
        "utf8",
      );
      await compactHistoryIfNeeded({
        ...history,
        records: [...history.records, record],
      });
      committedRecord = record;
    }
  });
  await activeStateRemover(statePath, { force: true });
  return committedRecord;
}

export function normalizeUsageRecord(record) {
  if (!record || typeof record !== "object" || Array.isArray(record)) {
    throw new Error("Usage record must be an object");
  }
  const normalized = {
    ...record,
    schema_version: 2,
    phase_run_id: record.phase_run_id ?? legacyPhaseRunId(record),
  };
  if (normalized.measurement_confidence === undefined && record.confidence !== undefined) {
    normalized.measurement_confidence = record.confidence === "high"
      ? "HIGH_CONFIDENCE"
      : "LOW_CONFIDENCE";
  }
  if (normalized.reset_occurred === undefined && record.reset_during_phase !== undefined) {
    normalized.reset_occurred = record.reset_during_phase;
  }
  delete normalized.confidence;
  delete normalized.reset_during_phase;
  return normalized;
}

function parseUsageHistory(content) {
  const lines = content.split(/\r?\n/);
  const unterminated = content.length > 0 && !/[\r\n]$/.test(content);
  const records = [];
  const validLines = [];
  let interruptedFinalLine = false;
  for (const [index, line] of lines.entries()) {
    if (line === "") continue;
    try {
      records.push(normalizeUsageRecord(JSON.parse(line)));
      validLines.push(line);
    } catch (error) {
      if (unterminated && index === lines.length - 1 && error instanceof SyntaxError) {
        interruptedFinalLine = true;
        break;
      }
      const corrupted = new Error(
        `HISTORY_CORRUPTED: invalid JSONL record at line ${index + 1}`,
        { cause: error },
      );
      corrupted.code = "HISTORY_CORRUPTED";
      throw corrupted;
    }
  }
  return {
    records,
    interruptedFinalLine,
    validContent: validLines.length > 0 ? `${validLines.join("\n")}\n` : "",
  };
}

async function loadUsageHistory(taskGuardHome) {
  const historyPath = path.join(taskGuardHome, "usage-history.jsonl");
  const content = await readFile(historyPath, "utf8").catch((error) => {
    if (error.code === "ENOENT") return "";
    throw error;
  });
  return { historyPath, ...parseUsageHistory(content) };
}

async function loadAndRepairUsageHistory(taskGuardHome) {
  const history = await loadUsageHistory(taskGuardHome);
  if (history.interruptedFinalLine) {
    await atomicWriteText(history.historyPath, history.validContent);
  }
  return history;
}

function usageCohortKey(record) {
  return JSON.stringify([
    record.plan ?? null,
    record.model ?? null,
    record.reasoning_effort ?? null,
    record.phase_type ?? null,
  ]);
}

function retainedUsageRecords(records) {
  if (records.length <= HISTORY_COMPACT_AT) return records;
  const selected = new Set();
  const cohortCounts = new Map();
  for (let index = records.length - 1; index >= 0; index -= 1) {
    const cohort = usageCohortKey(records[index]);
    const count = cohortCounts.get(cohort) ?? 0;
    if (count < HISTORY_RECORDS_PER_COHORT) {
      selected.add(index);
      cohortCounts.set(cohort, count + 1);
    }
  }
  for (let index = records.length - 1;
    index >= 0 && selected.size < HISTORY_RETAINED_RECORDS;
    index -= 1) {
    selected.add(index);
  }
  return [...selected]
    .sort((left, right) => left - right)
    .slice(-HISTORY_RETAINED_RECORDS)
    .map((index) => records[index]);
}

async function compactHistoryIfNeeded(history) {
  const retained = retainedUsageRecords(history.records);
  if (retained.length === history.records.length) return retained;
  await atomicWriteText(
    history.historyPath,
    `${retained.map((record) => JSON.stringify(record)).join("\n")}\n`,
  );
  return retained;
}

export async function readUsageHistory({
  taskGuardHome = defaultTaskGuardHome(),
  limit = null,
} = {}) {
  const { records } = await loadUsageHistory(taskGuardHome);
  if (limit === null) return records;
  if (!Number.isInteger(limit) || limit < 1) throw new Error("limit must be a positive integer");
  return records.slice(-limit);
}

function requireStringField(value, field, prefix = "phase") {
  if (typeof value?.[field] !== "string" || value[field].trim() === "") {
    throw new Error(`${prefix}.${field} must be a non-empty string`);
  }
}

export function estimatePhaseCost({ history, phase }) {
  if (!Array.isArray(history)) throw new Error("history must be an array");
  for (const field of ["model", "reasoning_effort", "phase_type"]) {
    requireStringField(phase, field);
  }
  const cohort = {
    model: phase.model,
    reasoning_effort: phase.reasoning_effort,
    phase_type: phase.phase_type,
    ...(phase.plan === undefined ? {} : { plan: phase.plan }),
  };
  if ([cohort.model, cohort.reasoning_effort, cohort.phase_type].includes("unknown")) {
    return {
      status: "INSUFFICIENT_HISTORY",
      cohort,
      sample_count: 0,
      estimated_upper_cost: null,
      method: "none",
    };
  }
  const eligibleCosts = history
    .map((record) => normalizeUsageRecord(record))
    .filter((record) => (
      record.measurement_confidence === "HIGH_CONFIDENCE"
      && record.reset_occurred === false
      && Number.isFinite(record.quota_delta)
      && record.quota_delta > 0
      && record.model === cohort.model
      && record.reasoning_effort === cohort.reasoning_effort
      && record.phase_type === cohort.phase_type
      && record.plan === cohort.plan
    ))
    .map((record) => record.quota_delta);

  if (eligibleCosts.length === 0) {
    return {
      status: "INSUFFICIENT_HISTORY",
      cohort,
      sample_count: 0,
      estimated_upper_cost: null,
      method: "none",
    };
  }
  const useRecentPercentile = eligibleCosts.length >= RECENT_ESTIMATE_MIN_SAMPLES;
  const costs = (useRecentPercentile
    ? eligibleCosts.slice(-RECENT_ESTIMATE_WINDOW)
    : eligibleCosts
  ).sort((left, right) => left - right);
  const middle = Math.floor(costs.length / 2);
  const median = costs.length % 2 === 0
    ? (costs[middle - 1] + costs[middle]) / 2
    : costs[middle];
  if (useRecentPercentile) {
    const percentileIndex = Math.ceil((RECENT_ESTIMATE_PERCENTILE / 100) * costs.length) - 1;
    return {
      status: "AVAILABLE",
      cohort,
      sample_count: eligibleCosts.length,
      sample_window: costs.length,
      minimum_cost: costs[0],
      median_cost: median,
      estimated_upper_cost: Math.min(100, costs[percentileIndex] + 1),
      percentile: RECENT_ESTIMATE_PERCENTILE,
      method: "recent_p90_plus_one",
    };
  }
  return {
    status: "AVAILABLE",
    cohort,
    sample_count: costs.length,
    minimum_cost: costs[0],
    median_cost: median,
    estimated_upper_cost: costs.at(-1),
    method: "observed_max",
  };
}

export function validateBudgetInput({
  history,
  phases,
  snapshot,
  safetyReservePercent,
}) {
  const authoritative = requireSnapshot(snapshot);
  const remainingPercent = authoritative.five_hour.remaining_percent;
  if (!Array.isArray(history)) throw new Error("history must be an array");
  if (!Array.isArray(phases) || phases.length === 0) {
    throw new Error("phases must be a non-empty array");
  }
  const phaseIds = new Set();
  for (const [index, phase] of phases.entries()) {
    const prefix = `phases[${index}]`;
    for (const field of ["phase_id", "phase_type", "model", "reasoning_effort"]) {
      requireStringField(phase, field, prefix);
    }
    if (typeof phase.dependencies_met !== "boolean") {
      throw new Error(`${prefix}.dependencies_met must be true or false`);
    }
    if (phaseIds.has(phase.phase_id)) throw new Error("phase_id values must be unique");
    phaseIds.add(phase.phase_id);
  }
  for (const [name, value] of [
    ["remainingPercent", remainingPercent],
    ["safetyReservePercent", safetyReservePercent],
  ]) {
    if (!Number.isFinite(value) || value < 0 || value > 100) {
      throw new Error(`${name} must be between 0 and 100`);
    }
  }
  return { authoritative, remainingPercent };
}

export function evaluateBudget({
  history,
  phases,
  snapshot,
  safetyReservePercent,
}) {
  const { authoritative, remainingPercent } = validateBudgetInput({
    history,
    phases,
    snapshot,
    safetyReservePercent,
  });
  const availableBudget = Math.max(0, remainingPercent - safetyReservePercent);
  const evaluated = phases.map((phase) => {
    if (phase.dependencies_met !== true) {
      return {
        phase_id: phase.phase_id,
        status: "DEPENDENCY_BLOCKED",
        estimated_upper_cost: null,
      };
    }
    const estimate = estimatePhaseCost({ history, phase });
    if (estimate.status !== "AVAILABLE") {
      return {
        phase_id: phase.phase_id,
        status: "INSUFFICIENT_HISTORY",
        estimated_upper_cost: null,
        sample_count: estimate.sample_count,
      };
    }
    return {
      phase_id: phase.phase_id,
      status: estimate.estimated_upper_cost <= availableBudget ? "FITS" : "TOO_LARGE",
      estimated_upper_cost: estimate.estimated_upper_cost,
      sample_count: estimate.sample_count,
    };
  });
  const selected = evaluated.find((phase) => phase.status === "FITS");
  return {
    decision: selected ? "RUN_PHASE" : "DECOMPOSE_OR_PAUSE",
    quota_snapshot_id: authoritative.snapshot_id,
    quota_observed_at: authoritative.observed_at,
    quota_source: authoritative.source,
    reset_at: authoritative.five_hour.reset_at ?? null,
    remaining_percent: remainingPercent,
    safety_reserve_percent: safetyReservePercent,
    available_budget: availableBudget,
    selected_phase_id: selected?.phase_id ?? null,
    phases: evaluated,
  };
}
