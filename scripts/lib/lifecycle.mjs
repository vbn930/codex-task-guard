import {
  clearCheckpointHeartbeat,
  patchCheckpointResumeAutomation,
  readCheckpoint,
  resolveCheckpointPath,
  resumeTask,
  saveCheckpoint,
  verifyCheckpoint,
} from "./checkpoint.mjs";
import { buildResumeAutomationIntent } from "./automation.mjs";
import { notifyDiscord } from "./discord.mjs";
import {
  unavailableQuotaSnapshot,
  validateFreshness,
  validateVerifiedFiveHourReset,
} from "./quota-snapshot.mjs";
import {
  completePhase,
  evaluateBudget,
  readUsageHistory,
  startPhase,
} from "./usage.mjs";

export async function preparePhase({
  projectPath,
  phases,
  safetyReservePercent,
  snapshotStore,
  taskGuardHome,
}) {
  if (!snapshotStore || typeof snapshotStore.refresh !== "function") {
    throw new Error("Quota snapshot store is required");
  }
  const snapshot = validateFreshness(await snapshotStore.refresh());
  const decision = evaluateBudget({
    history: await readUsageHistory({ taskGuardHome }),
    phases,
    snapshot,
    safetyReservePercent,
  });
  if (!decision.selected_phase_id) {
    return { snapshot, decision, phase_start: null };
  }
  const selectedPhase = phases.find(({ phase_id: phaseId }) => (
    phaseId === decision.selected_phase_id
  ));
  const phaseStart = await startPhase({
    projectPath,
    metadata: selectedPhase,
    snapshot,
    taskGuardHome,
  });
  return { snapshot, decision, phase_start: phaseStart };
}

export async function prepareTaskResume({
  projectPath,
  taskId,
  snapshotStore,
  taskGuardHome,
  cleanupHeartbeat,
  notificationPayload,
  blockedNotificationPayload,
  notifyOptions,
  phases,
  safetyReservePercent,
}) {
  if (!snapshotStore || typeof snapshotStore.refresh !== "function") {
    throw new Error("Quota snapshot store is required");
  }
  const snapshot = validateFreshness(await snapshotStore.refresh());
  const checkpointPath = await resolveCheckpointPath(projectPath);
  const state = await readCheckpoint(checkpointPath);
  if (state.task_id !== taskId) {
    throw new Error(`Checkpoint belongs to ${state.task_id}, not ${taskId}`);
  }
  const verification = await verifyCheckpoint(checkpointPath);
  let heartbeatCleanup = { required: false, completed: true };
  if (state.heartbeat_automation_id) {
    heartbeatCleanup = {
      required: true,
      completed: false,
      automation_id: state.heartbeat_automation_id,
    };
    if (typeof cleanupHeartbeat === "function") {
      try {
        const cleanupResult = await cleanupHeartbeat({
          automationId: state.heartbeat_automation_id,
          taskId,
        });
        if (cleanupResult !== false) {
          await clearCheckpointHeartbeat({ projectPath, taskId, taskGuardHome });
          heartbeatCleanup = { ...heartbeatCleanup, completed: true };
        } else {
          heartbeatCleanup.reason = "HEARTBEAT_CLEANUP_FAILED";
        }
      } catch {
        heartbeatCleanup.reason = "HEARTBEAT_CLEANUP_FAILED";
      }
    } else {
      heartbeatCleanup.reason = "HEARTBEAT_CLEANUP_REQUIRED";
    }
  }

  if (!verification.matches || !heartbeatCleanup.completed) {
    const reason = !verification.matches
      ? verification.reason
      : heartbeatCleanup.reason;
    const notification = await notifyDiscord(
      "TASK_BLOCKED",
      {
        ...blockedNotificationPayload,
        reason: blockedNotificationPayload?.reason ?? "Task resume verification failed",
        detected: blockedNotificationPayload?.detected ?? reason,
        action_required: blockedNotificationPayload?.action_required
          ?? "Resolve the blocked resume condition before continuing",
        checkpoint: blockedNotificationPayload?.checkpoint ?? "Preserved",
        status: blockedNotificationPayload?.status ?? "Blocked",
      },
      notifyOptions,
    );
    return {
      status: "TASK_BLOCKED",
      snapshot,
      verification,
      heartbeat_cleanup: heartbeatCleanup,
      resume: null,
      notification,
    };
  }

  const resumed = await resumeTask({ projectPath, taskId, taskGuardHome });
  const resume = {
    ...resumed,
    quota_snapshot_id: snapshot.snapshot_id,
    quota_observed_at: snapshot.observed_at,
  };
  const notification = await notifyDiscord(
    "TASK_RESUMED",
    {
      ...notificationPayload,
      checkpoint: notificationPayload?.checkpoint ?? "Verified",
      repository: notificationPayload?.repository ?? "No external changes",
      resume_point: state.exact_next_actions[0],
      status: notificationPayload?.status ?? "Working",
    },
    { ...notifyOptions, snapshot },
  );
  const decision = phases
    ? evaluateBudget({
      history: await readUsageHistory({ taskGuardHome }),
      phases,
      snapshot,
      safetyReservePercent,
    })
    : null;
  return {
    status: "TASK_RESUMED",
    snapshot,
    verification,
    heartbeat_cleanup: heartbeatCleanup,
    resume,
    notification,
    ...(decision ? { decision } : {}),
  };
}

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
  let snapshot;
  try {
    snapshot = await snapshotStore.refresh();
  } catch {
    const lastKnownSnapshot = typeof snapshotStore.latest === "function"
      ? await snapshotStore.latest().catch(() => null)
      : null;
    snapshot = unavailableQuotaSnapshot({
      source: snapshotStore.source,
      lastKnownSnapshot,
    });
  }
  let automationScheduleError = null;
  try {
    validateVerifiedFiveHourReset(snapshot);
  } catch (error) {
    automationScheduleError = error.message;
  }
  const hasVerifiedReset = automationScheduleError === null;
  const resumeAfter = hasVerifiedReset ? snapshot.five_hour.reset_at : null;
  const targetThread = checkpointState.thread_reference ?? "current";
  const automationIntent = hasVerifiedReset
    ? buildResumeAutomationIntent({
      taskId: checkpointState.task_id,
      targetThread,
      resumeAfter,
      snapshotId: snapshot.snapshot_id,
      prompt: [
        "Resume this same Codex task after the verified quota reset.",
        "Recheck quota, run Task Guard resume prepare for the existing checkpoint, then continue the exact next action.",
        "Do not create a new task.",
      ].join(" "),
    })
    : null;

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
    thread_reference: targetThread,
    resume_mode: hasVerifiedReset ? "AUTOMATION_ELIGIBLE" : "MANUAL",
    resume_automation: hasVerifiedReset ? {
      purpose: "quota_resume",
      status: "ELIGIBLE",
      automation_id: null,
      attempts: 0,
      target_thread: targetThread,
      resume_after: resumeAfter,
      snapshot_id: snapshot.snapshot_id,
      automation_fingerprint: automationIntent.automation_fingerprint,
    } : {
      purpose: "quota_resume",
      status: "FAILED",
      automation_id: null,
      attempts: 0,
      last_error: automationScheduleError,
      resolution: "MANUAL_FALLBACK",
    },
  };
  const savedCheckpoint = await saveCheckpoint({ projectPath, state, taskGuardHome });
  const checkpoint = { ...savedCheckpoint, saved: true };
  const notification = hasVerifiedReset ? null : await notifyDiscord(
    "QUOTA_PAUSED",
    {
      ...notificationPayload,
      checkpoint: "Saved",
      resume: "Manual resume required",
      automation: "Registration could not be attempted",
    },
    { ...notifyOptions, snapshot },
  );

  return {
    snapshot,
    checkpoint,
    notification,
    automation_intent: automationIntent,
    automation_schedule: hasVerifiedReset ? {
      resume_after: resumeAfter,
      quota_snapshot_id: snapshot.snapshot_id,
      quota_observed_at: snapshot.observed_at,
    } : null,
    automation_schedule_error: automationScheduleError,
    resume_mode: hasVerifiedReset ? "AUTOMATION_ELIGIBLE" : "MANUAL",
  };
}

export async function finalizeQuotaPause({
  projectPath,
  taskId,
  resumeAutomation,
  notificationPayload,
  taskGuardHome,
  notifyOptions,
}) {
  const checkpointPath = await resolveCheckpointPath(projectPath);
  const state = await readCheckpoint(checkpointPath);
  if (state.task_id !== taskId) {
    throw new Error(`Checkpoint belongs to ${state.task_id}, not ${taskId}`);
  }
  const checkpoint = await patchCheckpointResumeAutomation({
    projectPath,
    taskId,
    resumeAutomation,
    taskGuardHome,
  });
  const finalizedAutomation = checkpoint.resume_automation;
  const verified = finalizedAutomation.status === "VERIFIED";
  const creationUnverified = ["UI_RENDERED", "CREATE_REQUESTED", "RECONCILING"]
    .includes(finalizedAutomation.status);
  const notification = await notifyDiscord(
    "QUOTA_PAUSED",
    {
      ...notificationPayload,
      checkpoint: "Saved",
      resume: verified
        ? "Same-thread automation verified"
        : creationUnverified
          ? "Creation not persisted/verified"
          : "Manual resume required",
      automation: verified
        ? `Verified · Attempt ${finalizedAutomation.attempts}/2`
        : "Registration could not be verified",
      ...(verified ? { next_wake: finalizedAutomation.resume_after } : {}),
    },
    { ...notifyOptions, snapshot: state.quota_snapshot },
  );
  return { checkpoint, notification, resume_mode: verified ? "AUTOMATION" : "MANUAL" };
}
