import {
  AUTOMATION_STATUS,
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

export function normalizeTaskStatus(value) {
  const normalized = typeof value === "string" ? value.trim().toUpperCase() : "";
  if (!TASK_STATUSES.has(normalized)) throw new Error("Invalid task status");
  return normalized;
}

export function isActiveTaskStatus(value) {
  try {
    return TASK_STATUSES.has(normalizeTaskStatus(value));
  } catch {
    return false;
  }
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
