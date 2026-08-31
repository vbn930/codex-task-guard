import { createHash } from "node:crypto";
import { readFile, readdir, stat } from "node:fs/promises";
import os from "node:os";
import path from "node:path";

export const RESUME_AUTOMATION_STATES = Object.freeze({
  ELIGIBLE: "ELIGIBLE",
  CREATE_REQUESTED: "CREATE_REQUESTED",
  ID_RECEIVED: "ID_RECEIVED",
  UI_RENDERED: "UI_RENDERED",
  READBACK_VERIFYING: "READBACK_VERIFYING",
  PERSISTED: "PERSISTED",
  VERIFIED: "VERIFIED",
  RECONCILING: "RECONCILING",
  RETRYING: "RETRYING",
  MISMATCH: "MISMATCH",
  FAILED: "FAILED",
  MANUAL_FALLBACK: "MANUAL_FALLBACK",
});

const DEFAULT_MAX_CREATE_ATTEMPTS = 2;
const DEFAULT_MAX_VIEW_ATTEMPTS = 3;
const DEFAULT_VIEW_BACKOFF_MS = [250, 750];

function fingerprint(parts) {
  return createHash("sha256").update(parts.join("\u0000")).digest("hex");
}

export function buildResumeAutomationIntent({
  taskId,
  targetThread,
  resumeAfter,
  snapshotId,
  prompt,
  name = `${taskId} quota resume`,
}) {
  if (!taskId || !targetThread || !resumeAfter) {
    throw new Error("taskId, targetThread, and resumeAfter are required");
  }
  if (Number.isNaN(Date.parse(resumeAfter))) throw new Error("resumeAfter must be an ISO timestamp");
  return {
    task_id: taskId,
    purpose: "quota_resume",
    target_thread: targetThread,
    resume_after: new Date(resumeAfter).toISOString(),
    name,
    kind: "heartbeat",
    destination: "thread",
    status: "ACTIVE",
    snapshot_id: snapshotId ?? null,
    prompt: prompt ?? null,
    automation_fingerprint: fingerprint([
      taskId,
      "quota_resume",
      targetThread,
      new Date(resumeAfter).toISOString(),
    ]),
  };
}

function findObject(value, predicate, seen = new Set()) {
  if (!value || typeof value !== "object" || seen.has(value)) return null;
  seen.add(value);
  if (predicate(value)) return value;
  for (const nested of Object.values(value)) {
    const found = findObject(nested, predicate, seen);
    if (found) return found;
  }
  return null;
}

export function parseCreateResult(raw) {
  if (raw === null || raw === undefined || raw === "") return { outcome: "AMBIGUOUS" };
  const objectWithId = findObject(raw, (value) => (
    typeof value.automationId === "string"
    || typeof value.automation_id === "string"
    || (typeof value.id === "string" && (
      value.kind === "heartbeat"
      || /automation/i.test(value.id)
      || /automation/i.test(JSON.stringify(value))
    ))
  ));
  const id = objectWithId?.automationId ?? objectWithId?.automation_id ?? objectWithId?.id;
  if (id) return { outcome: "ID_RECEIVED", automation_id: id };
  const text = typeof raw === "string" ? raw : JSON.stringify(raw);
  if (/tool unavailable|handler missing|non[- ]local|schema unsupported|schema rejection|permission|capability|heartbeat unsupported/i.test(text)) {
    return { outcome: "STRUCTURAL_FAILURE" };
  }
  const explicitId = text.match(/automation(?:\s+id)?\s*[:=]\s*["']?([A-Za-z0-9._:-]+)/i)?.[1];
  if (explicitId) return { outcome: "ID_RECEIVED", automation_id: explicitId };
  if (/rendered automation card/i.test(text)) return { outcome: "UI_RENDERED" };
  return { outcome: "AMBIGUOUS" };
}

function normalizeStatus(value) {
  return typeof value === "string" ? value.trim().toUpperCase() : null;
}

function extractTimestamp(text) {
  if (typeof text !== "string") return null;
  const iso = text.match(/\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d+)?Z/i)?.[0];
  if (iso) return new Date(iso).toISOString();
  const compact = text.match(/DTSTART(?:;[^:]*)?:(\d{8}T\d{6}Z)/i)?.[1];
  if (!compact) return null;
  const match = compact.match(/^(\d{4})(\d{2})(\d{2})T(\d{2})(\d{2})(\d{2})Z$/);
  return match
    ? `${match[1]}-${match[2]}-${match[3]}T${match[4]}:${match[5]}:${match[6]}.000Z`
    : null;
}

function scheduleMatches(actual, expected) {
  if (typeof actual !== "string") return false;
  if (/FREQ=DAILY/i.test(actual) && !/COUNT=1(?:;|$)/i.test(actual)) return false;
  const actualTimestamp = extractTimestamp(actual);
  if (!actualTimestamp) return false;
  const delta = Date.parse(actualTimestamp) - Date.parse(expected.resume_after);
  return delta >= 0 && delta <= 5 * 60 * 1_000;
}

function parseTomlScalar(raw) {
  const value = raw.trim();
  if (value.startsWith('"') && value.endsWith('"')) {
    try {
      return JSON.parse(value);
    } catch {
      return value.slice(1, -1);
    }
  }
  if (value.startsWith("'") && value.endsWith("'")) return value.slice(1, -1);
  return value;
}

function parseAutomationToml(content) {
  const values = {};
  for (const line of content.split(/\r?\n/)) {
    const match = line.match(/^\s*([A-Za-z0-9_.-]+)\s*=\s*(.*?)\s*$/);
    if (!match) continue;
    values[match[1]] = parseTomlScalar(match[2]);
  }
  return values;
}

export async function reconcileLocalAutomationRegistry({
  expected,
  requestStartedAt,
  automationRoot = path.join(os.homedir(), ".codex", "automations"),
}) {
  const startedAt = Date.parse(requestStartedAt);
  if (Number.isNaN(startedAt)) throw new Error("requestStartedAt must be an ISO timestamp");
  let entries;
  try {
    entries = await readdir(automationRoot, { withFileTypes: true });
  } catch (error) {
    if (error.code === "ENOENT") return { outcome: "ABSENT", candidates: [] };
    throw error;
  }
  const candidates = [];
  for (const entry of entries) {
    if (!entry.isDirectory()) continue;
    const tomlPath = path.join(automationRoot, entry.name, "automation.toml");
    try {
      const metadata = await stat(tomlPath);
      if (metadata.mtimeMs < startedAt - 2 * 60 * 1_000) continue;
      const values = parseAutomationToml(await readFile(tomlPath, "utf8"));
      const targetThread = values.targetThreadId ?? values.target_thread_id
        ?? values.target_thread ?? null;
      const schedule = values.rrule ?? values.schedule ?? values.resume_after ?? null;
      if (
        values.name === expected.name
        && values.kind === "heartbeat"
        && targetThread === expected.target_thread
        && scheduleMatches(schedule, expected)
        && (expected.prompt === null || values.prompt === undefined || values.prompt === expected.prompt)
      ) {
        candidates.push(entry.name);
      }
    } catch (error) {
      if (error.code !== "ENOENT") throw error;
    }
  }
  if (candidates.length === 0) return { outcome: "ABSENT", candidates };
  if (candidates.length === 1) {
    return { outcome: "SINGLE", automation_id: candidates[0], candidates };
  }
  return { outcome: "AMBIGUOUS", candidates };
}

export function normalizeViewResult(raw) {
  const automation = findObject(raw, (value) => (
    typeof value.kind === "string"
    && (typeof value.name === "string" || typeof value.id === "string")
  ));
  if (automation) {
    return {
      found: true,
      id: automation.id ?? automation.automationId ?? automation.automation_id ?? null,
      kind: automation.kind ?? null,
      status: normalizeStatus(automation.status),
      name: automation.name ?? null,
      schedule: automation.rrule ?? automation.schedule ?? automation.resume_after ?? null,
      target_thread: automation.targetThreadId ?? automation.target_thread_id
        ?? automation.target_thread ?? null,
      destination: automation.destination ?? null,
      prompt: automation.prompt ?? null,
    };
  }
  const texts = [];
  const visit = (value) => {
    if (typeof value === "string") {
      texts.push(value);
      return;
    }
    if (!value || typeof value !== "object") return;
    for (const nested of Object.values(value)) visit(nested);
  };
  visit(raw);
  const text = texts.join("\n");
  if (/not[ _-]?found/i.test(text)) return { found: false, reason: "NOT_FOUND" };
  const field = (label) => text.match(new RegExp(`^${label}\\s*:\\s*(.+)$`, "im"))?.[1]?.trim() ?? null;
  const kind = field("Kind");
  const name = field("Name");
  if (!kind || !name) return { found: false, reason: "UNPARSEABLE_VIEW" };
  return {
    found: true,
    id: field("Automation(?: ID)?"),
    kind,
    status: normalizeStatus(field("Status")),
    name,
    schedule: field("(?:Schedule|RRULE)"),
    target_thread: field("Target(?: Thread|ThreadId)"),
    destination: field("Destination"),
    prompt: field("Prompt"),
  };
}

export function verifyPersistedAutomation(raw, expected) {
  const actual = normalizeViewResult(raw);
  if (!actual.found) return { verified: false, reason: actual.reason, actual };
  const verification = {
    persisted: true,
    identity_match: actual.name === expected.name,
    kind_match: actual.kind === "heartbeat",
    thread_match: actual.target_thread === null
      ? null
      : actual.target_thread === expected.target_thread
        && (actual.destination === null || actual.destination === "thread"),
    schedule_match: scheduleMatches(actual.schedule, expected),
    status_active: actual.status === "ACTIVE",
    prompt_match: expected.prompt === null
      ? true
      : actual.prompt === null
        ? null
        : actual.prompt === expected.prompt,
  };
  const verified = Object.entries(verification).every(([key, value]) => (
    key === "prompt_match" ? value !== false : value === true
  ));
  return { verified, reason: verified ? null : "FIELD_MISMATCH", actual, verification };
}

async function verifyById({ id, expected, adapter, maxViewAttempts, delay, trace }) {
  for (let attempt = 1; attempt <= maxViewAttempts; attempt += 1) {
    trace.push(RESUME_AUTOMATION_STATES.READBACK_VERIFYING);
    try {
      const raw = await adapter.view({ id, mode: "view" });
      const checked = verifyPersistedAutomation(raw, expected);
      if (checked.actual.found) {
        trace.push(RESUME_AUTOMATION_STATES.PERSISTED);
        if (checked.verified) trace.push(RESUME_AUTOMATION_STATES.VERIFIED);
        else trace.push(RESUME_AUTOMATION_STATES.MISMATCH);
        return checked;
      }
    } catch (error) {
      if (!/not[ _-]?found/i.test(error?.message ?? "")) throw error;
    }
    if (attempt < maxViewAttempts) {
      await delay(DEFAULT_VIEW_BACKOFF_MS[Math.min(attempt - 1, DEFAULT_VIEW_BACKOFF_MS.length - 1)]);
    }
  }
  return { verified: false, reason: "NOT_FOUND", actual: { found: false } };
}

function verifiedResult({ id, attempts, expected, checked, trace }) {
  return {
    purpose: expected.purpose,
    status: RESUME_AUTOMATION_STATES.VERIFIED,
    resume_mode: "AUTOMATION",
    automation_id: id,
    attempts,
    verified_at: new Date().toISOString(),
    target_thread: expected.target_thread,
    resume_after: expected.resume_after,
    snapshot_id: expected.snapshot_id,
    automation_fingerprint: expected.automation_fingerprint,
    verification: checked.verification,
    state_trace: trace,
  };
}

function mismatchReason(checked) {
  const verification = checked?.verification;
  if (!verification) return checked?.reason ?? "PERSISTENCE_NOT_VERIFIED";
  if (!verification.identity_match) return "IDENTITY_MISMATCH";
  if (!verification.kind_match) return "KIND_MISMATCH";
  if (verification.thread_match === null) return "TARGET_UNVERIFIED";
  if (!verification.thread_match) return "THREAD_MISMATCH";
  if (!verification.schedule_match) return "SCHEDULE_MISMATCH";
  if (!verification.status_active) return "STATUS_NOT_ACTIVE";
  if (!verification.prompt_match) return "PROMPT_MISMATCH";
  return "PERSISTENCE_NOT_VERIFIED";
}

function isStructuralFailure(error) {
  return /tool unavailable|handler missing|non[- ]local|schema unsupported|schema rejection|permission|capability|heartbeat unsupported/i
    .test(error?.message ?? "");
}

export async function ensureResumeAutomation({
  expected,
  adapter,
  maxCreateAttempts = DEFAULT_MAX_CREATE_ATTEMPTS,
  maxViewAttempts = DEFAULT_MAX_VIEW_ATTEMPTS,
  delay = (milliseconds) => new Promise((resolve) => setTimeout(resolve, milliseconds)),
}) {
  if (!adapter || typeof adapter.create !== "function" || typeof adapter.view !== "function") {
    throw new Error("Automation adapter requires create and view functions");
  }
  const trace = [RESUME_AUTOMATION_STATES.ELIGIBLE];
  let lastAutomationId = null;
  let lastCheck = null;
  let terminalError = null;
  for (let attempts = 1; attempts <= maxCreateAttempts; attempts += 1) {
    trace.push(RESUME_AUTOMATION_STATES.CREATE_REQUESTED);
    let parsed;
    try {
      parsed = parseCreateResult(await adapter.create(expected));
    } catch (error) {
      if (isStructuralFailure(error)) {
        terminalError = "STRUCTURAL_FAILURE";
        break;
      }
      parsed = { outcome: "AMBIGUOUS" };
    }
    if (parsed.outcome === "STRUCTURAL_FAILURE") {
      terminalError = "STRUCTURAL_FAILURE";
      break;
    }
    if (parsed.outcome !== "ID_RECEIVED") {
      trace.push(parsed.outcome === "UI_RENDERED"
        ? RESUME_AUTOMATION_STATES.UI_RENDERED
        : RESUME_AUTOMATION_STATES.RECONCILING);
      if (typeof adapter.reconcile !== "function") break;
      trace.push(RESUME_AUTOMATION_STATES.RECONCILING);
      const reconciliation = await adapter.reconcile(expected);
      if (reconciliation?.outcome === "SINGLE" && reconciliation.automation_id) {
        lastAutomationId = reconciliation.automation_id;
        const checked = await verifyById({
          id: reconciliation.automation_id,
          expected,
          adapter,
          maxViewAttempts,
          delay,
          trace,
        });
        if (checked.verified) {
          return verifiedResult({
            id: reconciliation.automation_id,
            attempts,
            expected,
            checked,
            trace,
          });
        }
        lastCheck = checked;
        break;
      }
      if (reconciliation?.outcome === "ABSENT" && attempts < maxCreateAttempts) {
        trace.push(RESUME_AUTOMATION_STATES.RETRYING);
        continue;
      }
      break;
    }
    lastAutomationId = parsed.automation_id;
    trace.push(RESUME_AUTOMATION_STATES.ID_RECEIVED);
    const checked = await verifyById({
      id: parsed.automation_id,
      expected,
      adapter,
      maxViewAttempts,
      delay,
      trace,
    });
    if (checked.verified) {
      return verifiedResult({
        id: parsed.automation_id,
        attempts,
        expected,
        checked,
        trace,
      });
    }
    lastCheck = checked;
    if (checked.reason === "NOT_FOUND" && typeof adapter.reconcile === "function") {
      trace.push(RESUME_AUTOMATION_STATES.RECONCILING);
      const reconciliation = await adapter.reconcile(expected);
      if (reconciliation?.outcome === "SINGLE" && reconciliation.automation_id) {
        lastAutomationId = reconciliation.automation_id;
        const reconciled = await verifyById({
          id: reconciliation.automation_id,
          expected,
          adapter,
          maxViewAttempts,
          delay,
          trace,
        });
        if (reconciled.verified) {
          return verifiedResult({
            id: reconciliation.automation_id,
            attempts,
            expected,
            checked: reconciled,
            trace,
          });
        }
        lastCheck = reconciled;
        break;
      }
      if (reconciliation?.outcome === "ABSENT" && attempts < maxCreateAttempts) {
        trace.push(RESUME_AUTOMATION_STATES.RETRYING);
        continue;
      }
    }
    break;
  }
  trace.push(RESUME_AUTOMATION_STATES.FAILED, RESUME_AUTOMATION_STATES.MANUAL_FALLBACK);
  return {
    purpose: expected.purpose,
    status: RESUME_AUTOMATION_STATES.FAILED,
    resume_mode: "MANUAL",
    automation_id: lastCheck?.actual?.found ? lastAutomationId : null,
    attempts: trace.filter((state) => state === RESUME_AUTOMATION_STATES.CREATE_REQUESTED).length,
    last_error: terminalError ?? mismatchReason(lastCheck),
    resolution: RESUME_AUTOMATION_STATES.MANUAL_FALLBACK,
    cleanup_required: Boolean(lastCheck?.actual?.found),
    target_thread: expected.target_thread,
    resume_after: expected.resume_after,
    snapshot_id: expected.snapshot_id,
    automation_fingerprint: expected.automation_fingerprint,
    ...(lastCheck?.verification ? { verification: lastCheck.verification } : {}),
    state_trace: trace,
  };
}
