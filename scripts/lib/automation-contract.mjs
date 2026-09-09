export const AUTOMATION_STATUS = Object.freeze({
  ELIGIBLE: "ELIGIBLE",
  VERIFIED: "VERIFIED",
  FAILED: "FAILED",
  EXECUTED: "EXECUTED",
});

export const AUTOMATION_TRACE_EVENT = Object.freeze({
  CREATE_REQUESTED: "CREATE_REQUESTED",
  ID_RECEIVED: "ID_RECEIVED",
  UI_RENDERED: "UI_RENDERED",
  READBACK_VERIFYING: "READBACK_VERIFYING",
  PERSISTED: "PERSISTED",
  RECONCILING: "RECONCILING",
  RETRYING: "RETRYING",
  MISMATCH: "MISMATCH",
});

export const AUTOMATION_RESOLUTION = Object.freeze({
  MANUAL_FALLBACK: "MANUAL_FALLBACK",
});

const AUTOMATION_STATUSES = new Set(Object.values(AUTOMATION_STATUS));
const TERMINAL_AUTOMATION_STATUSES = new Set([
  AUTOMATION_STATUS.VERIFIED,
  AUTOMATION_STATUS.FAILED,
  AUTOMATION_STATUS.EXECUTED,
]);
const VERIFICATION_KEYS = [
  "persisted",
  "id_match",
  "identity_match",
  "kind_match",
  "thread_match",
  "schedule_match",
  "status_active",
  "prompt_match",
];

export function isAutomationStatus(value) {
  return AUTOMATION_STATUSES.has(value);
}

export function isVerifiedAutomation(value) {
  return value?.status === AUTOMATION_STATUS.VERIFIED;
}

export function isTerminalAutomation(value) {
  return TERMINAL_AUTOMATION_STATUSES.has(value?.status);
}

export function sanitizeResumeAutomation(input) {
  if (!input || typeof input !== "object") throw new Error("resumeAutomation is required");
  if (input.purpose !== "quota_resume") {
    throw new Error("resumeAutomation purpose must be quota_resume");
  }
  if (!isAutomationStatus(input.status)) throw new Error("Invalid resumeAutomation status");
  const output = {
    purpose: "quota_resume",
    status: input.status,
    automation_id: typeof input.automation_id === "string" ? input.automation_id : null,
    attempts: Number.isInteger(input.attempts) && input.attempts >= 0 ? input.attempts : 0,
  };
  for (const key of [
    "verified_at",
    "verification_source",
    "target_thread",
    "resume_after",
    "snapshot_id",
    "automation_fingerprint",
    "last_error",
    "resolution",
  ]) {
    if (typeof input[key] === "string") output[key] = input[key];
  }
  if (typeof input.cleanup_required === "boolean") {
    output.cleanup_required = input.cleanup_required;
  }
  if (input.verification && typeof input.verification === "object") {
    output.verification = {};
    for (const key of VERIFICATION_KEYS) {
      if (typeof input.verification[key] === "boolean" || input.verification[key] === null) {
        output.verification[key] = input.verification[key];
      }
    }
  }
  if (isVerifiedAutomation(output)) {
    if (!output.automation_id) throw new Error("VERIFIED resume automation requires automation_id");
    if (output.attempts < 1) throw new Error("VERIFIED resume automation requires attempts >= 1");
    if (!output.verified_at) throw new Error("VERIFIED resume automation requires verified_at");
    if (output.verification_source !== "READBACK") {
      throw new Error("VERIFIED resume automation requires READBACK verification_source");
    }
    for (const key of ["target_thread", "resume_after", "snapshot_id", "automation_fingerprint"]) {
      if (!output[key]) throw new Error(`VERIFIED resume automation requires ${key}`);
    }
    const critical = [
      "persisted",
      "id_match",
      "identity_match",
      "kind_match",
      "thread_match",
      "schedule_match",
      "status_active",
    ];
    if (!critical.every((key) => output.verification?.[key] === true)) {
      throw new Error("VERIFIED resume automation requires successful read-back verification");
    }
    if (output.verification.prompt_match === false) {
      throw new Error("VERIFIED resume automation cannot have a prompt mismatch");
    }
  }
  return output;
}
