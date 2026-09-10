import {
  AUTOMATION_STATUS,
  isTerminalAutomation,
  isVerifiedAutomation,
} from "./automation-contract.mjs";

export const TASK_STATUS = Object.freeze({
  WORKING: "WORKING",
  PAUSED_FOR_QUOTA: "PAUSED_FOR_QUOTA",
});

export const TASK_RESUME_MODE = Object.freeze({
  AUTOMATION_ELIGIBLE: "AUTOMATION_ELIGIBLE",
  AUTOMATION: "AUTOMATION",
  MANUAL: "MANUAL",
});

const TASK_STATUSES = new Set(Object.values(TASK_STATUS));
const DURABLE_TASK_FIELDS = new Set([
  "task_id",
  "task_description",
  "status",
  "completed",
  "current_state",
  "decisions",
  "tests",
  "known_issues",
  "remaining_work",
  "exact_next_actions",
  "phase_plan",
  "pause_reason",
  "quota",
  "quota_snapshot",
  "resume_after",
  "thread_reference",
  "resume_mode",
  "resume_automation",
  "heartbeat_automation_id",
  "schema_version",
  "paused_at",
  "resumed_at",
  "repository",
]);

export function normalizeTaskStatus(value) {
  const normalized = typeof value === "string" ? value.trim().toUpperCase() : "";
  if (!TASK_STATUSES.has(normalized)) throw new Error("Invalid task status");
  return normalized;
}

export function isTaskStatus(value, expected) {
  try {
    return normalizeTaskStatus(value) === expected;
  } catch {
    return false;
  }
}

export function isActiveTaskStatus(value) {
  try {
    return TASK_STATUSES.has(normalizeTaskStatus(value));
  } catch {
    return false;
  }
}

export function sanitizeTaskState(state) {
  if (!state || typeof state !== "object" || Array.isArray(state)) {
    throw new Error("Checkpoint state is required");
  }
  for (const key of Object.keys(state)) {
    if (!DURABLE_TASK_FIELDS.has(key)) {
      throw new Error(`Unsupported checkpoint state field: ${key}`);
    }
  }
  return {
    ...state,
    status: normalizeTaskStatus(state.status),
  };
}

export function transitionTaskToQuotaPause(state, {
  snapshot,
  resumeAfter,
  threadReference,
  resumeMode,
  resumeAutomation,
}) {
  normalizeTaskStatus(state?.status);
  const expectedAutomationStatus = {
    [TASK_RESUME_MODE.AUTOMATION_ELIGIBLE]: AUTOMATION_STATUS.ELIGIBLE,
    [TASK_RESUME_MODE.MANUAL]: AUTOMATION_STATUS.FAILED,
  }[resumeMode];
  if (!expectedAutomationStatus || resumeAutomation?.status !== expectedAutomationStatus) {
    throw new Error("Task resume mode does not match automation status");
  }
  if (
    resumeMode === TASK_RESUME_MODE.AUTOMATION_ELIGIBLE
    && resumeAutomation?.target_thread !== threadReference
  ) {
    throw new Error("resumeAutomation target_thread does not match paused task");
  }
  if (
    resumeMode === TASK_RESUME_MODE.AUTOMATION_ELIGIBLE
    && resumeAutomation?.resume_after !== resumeAfter
  ) {
    throw new Error("resumeAutomation resume_after does not match paused task");
  }
  if (
    resumeMode === TASK_RESUME_MODE.AUTOMATION_ELIGIBLE
    && resumeAutomation?.snapshot_id !== snapshot?.snapshot_id
  ) {
    throw new Error("resumeAutomation snapshot_id does not match paused task");
  }
  return {
    ...state,
    status: TASK_STATUS.PAUSED_FOR_QUOTA,
    quota_snapshot: snapshot,
    quota: {
      source: snapshot.source,
      observed_at: snapshot.observed_at,
      freshness: snapshot.freshness,
      five_hour: snapshot.five_hour,
      weekly: snapshot.weekly,
    },
    resume_after: resumeAfter,
    thread_reference: threadReference,
    resume_mode: resumeMode,
    resume_automation: resumeAutomation,
  };
}

export function transitionTaskResumeAutomation(state, automation) {
  if (!isTaskStatus(state?.status, TASK_STATUS.PAUSED_FOR_QUOTA)) {
    throw new Error("resumeAutomation can only be finalized from PAUSED_FOR_QUOTA");
  }
  if (isTerminalAutomation(state.resume_automation)) {
    throw new Error("Cannot rewrite a terminal automation state");
  }
  if (automation.snapshot_id && automation.snapshot_id !== state.quota_snapshot?.snapshot_id) {
    throw new Error("resumeAutomation snapshot_id does not match the checkpoint");
  }
  if (automation.resume_after && automation.resume_after !== state.resume_after) {
    throw new Error("resumeAutomation resume_after does not match the checkpoint");
  }
  if (
    automation.automation_fingerprint
    && state.resume_automation?.automation_fingerprint
    && automation.automation_fingerprint !== state.resume_automation.automation_fingerprint
  ) {
    throw new Error("resumeAutomation fingerprint does not match the checkpoint intent");
  }
  if (
    isVerifiedAutomation(automation)
    && state.resume_automation?.automation_fingerprint !== automation.automation_fingerprint
  ) {
    throw new Error("VERIFIED resumeAutomation requires the checkpoint intent fingerprint");
  }
  if (
    automation.target_thread
    && state.thread_reference
    && automation.target_thread !== state.thread_reference
  ) {
    throw new Error("resumeAutomation target_thread does not match the checkpoint");
  }
  if (isVerifiedAutomation(automation) && automation.target_thread !== state.thread_reference) {
    throw new Error("VERIFIED resumeAutomation requires the checkpoint target thread");
  }
  const verified = isVerifiedAutomation(automation);
  const nextState = {
    ...state,
    resume_automation: automation,
    resume_mode: verified ? TASK_RESUME_MODE.AUTOMATION : TASK_RESUME_MODE.MANUAL,
  };
  if (automation.automation_id) {
    nextState.heartbeat_automation_id = automation.automation_id;
  } else {
    delete nextState.heartbeat_automation_id;
  }
  return nextState;
}

export function transitionTaskToWorking(state, {
  resumedAt,
  heartbeatCleanupConfirmed = false,
} = {}) {
  if (normalizeTaskStatus(state?.status) !== TASK_STATUS.PAUSED_FOR_QUOTA) {
    throw new Error("Task can only resume from PAUSED_FOR_QUOTA");
  }
  const externalCleanupRequired = Boolean(state.heartbeat_automation_id)
    || (isVerifiedAutomation(state.resume_automation)
      && state.resume_automation.cleanup_required !== false);
  if (externalCleanupRequired && !heartbeatCleanupConfirmed) {
    throw new Error("Heartbeat cleanup confirmation is required before resume");
  }
  const resumedState = {
    ...state,
    status: TASK_STATUS.WORKING,
    resumed_at: resumedAt,
    resume_after: null,
    ...(isVerifiedAutomation(state.resume_automation) ? {
      resume_automation: {
        ...state.resume_automation,
        status: AUTOMATION_STATUS.EXECUTED,
        executed_at: resumedAt,
        cleanup_required: false,
      },
    } : {}),
  };
  delete resumedState.heartbeat_automation_id;
  return resumedState;
}
