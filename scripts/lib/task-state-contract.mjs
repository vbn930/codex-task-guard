export const TASK_STATUS = Object.freeze({
  WORKING: "WORKING",
  PAUSED_FOR_QUOTA: "PAUSED_FOR_QUOTA",
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
