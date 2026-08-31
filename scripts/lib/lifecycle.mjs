import { saveCheckpoint } from "./checkpoint.mjs";
import { notifyDiscord } from "./discord.mjs";
import { validateFreshness } from "./quota-snapshot.mjs";
import {
  completePhase,
  evaluateBudget,
  readUsageHistory,
} from "./usage.mjs";

export async function completePhaseAndDecide({
  projectPath,
  phaseId,
  concurrentUsage,
  phases,
  safetyReservePercent,
  snapshotStore,
  taskGuardHome,
  notification,
}) {
  if (!snapshotStore || typeof snapshotStore.refresh !== "function") {
    throw new Error("Quota snapshot store is required");
  }
  const snapshot = validateFreshness(await snapshotStore.refresh());
  const measurement = await completePhase({
    projectPath,
    phaseId,
    concurrentUsage,
    snapshot,
    taskGuardHome,
  });
  const decision = evaluateBudget({
    history: await readUsageHistory({ taskGuardHome }),
    phases,
    snapshot,
    safetyReservePercent,
  });
  const notificationResult = notification
    ? await notifyDiscord(
      notification.event,
      notification.payload,
      { ...notification.options, snapshot },
    )
    : null;
  return {
    snapshot,
    measurement,
    decision,
    ...(notification ? { notification: notificationResult } : {}),
  };
}

export async function prepareQuotaPause({
  projectPath,
  checkpointState,
  notificationPayload,
  snapshotStore,
  taskGuardHome,
  notifyOptions,
}) {
  if (!snapshotStore || typeof snapshotStore.refresh !== "function") {
    throw new Error("Quota snapshot store is required");
  }
  const snapshot = validateFreshness(await snapshotStore.refresh());
  const resumeAfter = snapshot.five_hour.reset_at;
  if (!resumeAfter) throw new Error("VERIFIED_FIVE_HOUR_RESET_REQUIRED");

  const state = {
    ...checkpointState,
    quota_snapshot: snapshot,
    quota: {
      source: snapshot.source,
      observed_at: snapshot.observed_at,
      freshness: snapshot.freshness,
      five_hour: snapshot.five_hour,
      weekly: snapshot.weekly,
    },
    resume_after: resumeAfter,
  };
  const checkpoint = await saveCheckpoint({ projectPath, state, taskGuardHome });
  const notification = await notifyDiscord(
    "QUOTA_PAUSED",
    notificationPayload,
    { ...notifyOptions, snapshot },
  );

  return {
    snapshot,
    checkpoint,
    notification,
    automation_schedule: {
      resume_after: resumeAfter,
      quota_snapshot_id: snapshot.snapshot_id,
      quota_observed_at: snapshot.observed_at,
    },
  };
}
