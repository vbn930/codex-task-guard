import {
  patchCheckpointResumeAutomation,
  readCheckpoint,
  resolveCheckpointPath,
  resumeTask,
  saveCheckpoint,
  verifyCheckpoint,
} from "./checkpoint.mjs";
import {
  buildResumeAutomationIntent,
  verifyAutomationTranscript,
} from "./automation.mjs";
import {
  AUTOMATION_RESOLUTION,
  AUTOMATION_STATUS,
  isVerifiedAutomation,
} from "./automation-contract.mjs";
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
  validateBudgetInput,
} from "./usage.mjs";
import {
  TASK_RESUME_MODE,
  transitionTaskToQuotaPause,
} from "./task-state-contract.mjs";

function sameThreadResumePrompt() {
  return [
    "Resume this same Codex task after the verified quota reset.",
    "Recheck quota, run Task Guard resume prepare for the existing checkpoint, then continue the exact next action.",
    "Do not create a new task.",
  ].join(" ");
}

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
  const checkpointPath = await resolveCheckpointPath(projectPath);
  const state = await readCheckpoint(checkpointPath);
  if (state.task_id !== taskId) {
    throw new Error(`Checkpoint belongs to ${state.task_id}, not ${taskId}`);
  }
  if (state.status?.toUpperCase() === "WORKING") {
    return {
      status: "ALREADY_RESUMED",
      snapshot: null,
      verification: null,
      heartbeat_cleanup: {
        required: false,
        completed: true,
        reason: "ALREADY_RESUMED",
      },
      resume: null,
      notification: null,
    };
  }
  if (state.status?.toUpperCase() !== "PAUSED_FOR_QUOTA") {
    return {
      status: "TASK_BLOCKED",
      snapshot: null,
      verification: { matches: false, reason: "INVALID_RESUME_STATE" },
      heartbeat_cleanup: { required: false, completed: false },
      resume: null,
      notification: null,
    };
  }
  const verification = await verifyCheckpoint(checkpointPath);
  if (!verification.matches) {
    const notification = await notifyDiscord(
      "TASK_BLOCKED",
      {
        ...blockedNotificationPayload,
        reason: blockedNotificationPayload?.reason ?? "Task resume verification failed",
        detected: blockedNotificationPayload?.detected ?? verification.reason,
        action_required: blockedNotificationPayload?.action_required
          ?? "Resolve the blocked resume condition before continuing",
        checkpoint: blockedNotificationPayload?.checkpoint ?? "Preserved",
        status: blockedNotificationPayload?.status ?? "Blocked",
      },
      notifyOptions,
    );
    return {
      status: "TASK_BLOCKED",
      snapshot: null,
      verification,
      heartbeat_cleanup: { required: false, completed: false },
      resume: null,
      notification,
    };
  }
  if (!snapshotStore || typeof snapshotStore.refresh !== "function") {
    throw new Error("Quota snapshot store is required");
  }
  const verifiedCleanupRequired = isVerifiedAutomation(state.resume_automation)
    && state.resume_automation.cleanup_required !== false;
  const cleanupRequired = Boolean(state.heartbeat_automation_id) || verifiedCleanupRequired;
  const cleanupAutomationId = state.heartbeat_automation_id
    ?? (verifiedCleanupRequired ? state.resume_automation?.automation_id : null);
  let snapshot;
  try {
    snapshot = validateFreshness(await snapshotStore.refresh());
  } catch {
    snapshot = unavailableQuotaSnapshot();
    return {
      status: "QUOTA_UNAVAILABLE",
      snapshot,
      verification,
      heartbeat_cleanup: {
        required: cleanupRequired,
        completed: false,
        automation_id: cleanupAutomationId,
        reason: "QUOTA_UNAVAILABLE",
      },
      resume: null,
      notification: null,
    };
  }
  const decision = phases
    ? evaluateBudget({
      history: await readUsageHistory({ taskGuardHome }),
      phases,
      snapshot,
      safetyReservePercent,
    })
    : null;
  let heartbeatCleanup = {
    required: cleanupRequired,
    completed: !cleanupRequired,
  };
  if (cleanupRequired) {
    heartbeatCleanup = {
      required: true,
      completed: false,
      automation_id: cleanupAutomationId,
    };
    if (!cleanupAutomationId) {
      heartbeatCleanup.reason = "HEARTBEAT_CLEANUP_ID_REQUIRED";
    } else if (typeof cleanupHeartbeat === "function") {
      try {
        const cleanupResult = await cleanupHeartbeat({
          automationId: cleanupAutomationId,
          taskId,
        });
        if (cleanupResult !== false) {
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

  if (!heartbeatCleanup.completed) {
    const reason = heartbeatCleanup.reason;
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

  const resumed = await resumeTask({
    projectPath,
    taskId,
    taskGuardHome,
    repositoryVerification: verification,
    heartbeatCleanupConfirmed: heartbeatCleanup.completed,
  });
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
  const history = await readUsageHistory({ taskGuardHome });
  validateBudgetInput({ history, phases, snapshot, safetyReservePercent });
  const measurement = await completePhase({
    projectPath,
    phaseId,
    concurrentUsage,
    snapshot,
    taskGuardHome,
  });
  const decision = evaluateBudget({
    history: [...history, measurement],
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
  const targetThread = checkpointState.thread_reference ?? null;
  const hasConcreteThread = typeof targetThread === "string"
    && targetThread.trim() !== ""
    && targetThread.toLowerCase() !== "current";
  if (hasVerifiedReset && !hasConcreteThread) {
    automationScheduleError = "CONCRETE_THREAD_ID_REQUIRED";
  }
  const automationEligible = hasVerifiedReset && hasConcreteThread;
  const automationIntent = automationEligible
    ? buildResumeAutomationIntent({
      taskId: checkpointState.task_id,
      targetThread,
      resumeAfter,
      snapshotId: snapshot.snapshot_id,
      prompt: sameThreadResumePrompt(),
    })
    : null;

  const resumeMode = automationEligible
    ? TASK_RESUME_MODE.AUTOMATION_ELIGIBLE
    : TASK_RESUME_MODE.MANUAL;
  const resumeAutomation = automationEligible ? {
      purpose: "quota_resume",
      status: AUTOMATION_STATUS.ELIGIBLE,
      automation_id: null,
      attempts: 0,
      target_thread: targetThread,
      resume_after: resumeAfter,
      snapshot_id: snapshot.snapshot_id,
      automation_fingerprint: automationIntent.automation_fingerprint,
    } : {
      purpose: "quota_resume",
      status: AUTOMATION_STATUS.FAILED,
      automation_id: null,
      attempts: 0,
      last_error: automationScheduleError,
      resolution: AUTOMATION_RESOLUTION.MANUAL_FALLBACK,
    };
  const state = transitionTaskToQuotaPause(checkpointState, {
    snapshot,
    resumeAfter,
    threadReference: targetThread,
    resumeMode,
    resumeAutomation,
  });
  const savedCheckpoint = await saveCheckpoint({ projectPath, state, taskGuardHome });
  const checkpoint = { ...savedCheckpoint, saved: true };
  const notification = automationEligible ? null : await notifyDiscord(
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
    automation_schedule: automationEligible ? {
      resume_after: resumeAfter,
      quota_snapshot_id: snapshot.snapshot_id,
      quota_observed_at: snapshot.observed_at,
    } : null,
    automation_schedule_error: automationScheduleError,
    resume_mode: resumeMode,
  };
}

export async function finalizeQuotaPause({
  projectPath,
  taskId,
  automationTranscript,
  notificationPayload,
  taskGuardHome,
  notifyOptions,
}) {
  const checkpointPath = await resolveCheckpointPath(projectPath);
  const state = await readCheckpoint(checkpointPath);
  if (state.task_id !== taskId) {
    throw new Error(`Checkpoint belongs to ${state.task_id}, not ${taskId}`);
  }
  if (state.status !== "PAUSED_FOR_QUOTA") {
    throw new Error("Quota pause can only be finalized from PAUSED_FOR_QUOTA");
  }
  const expected = buildResumeAutomationIntent({
    taskId: state.task_id,
    targetThread: state.thread_reference,
    resumeAfter: state.resume_after,
    snapshotId: state.quota_snapshot?.snapshot_id,
    prompt: sameThreadResumePrompt(),
  });
  if (
    state.resume_automation?.automation_fingerprint
    && state.resume_automation.automation_fingerprint !== expected.automation_fingerprint
  ) {
    throw new Error("Checkpoint automation fingerprint does not match the expected intent");
  }
  const resumeAutomation = await verifyAutomationTranscript({
    expected,
    transcript: automationTranscript,
  });
  const checkpoint = await patchCheckpointResumeAutomation({
    projectPath,
    taskId,
    resumeAutomation,
    taskGuardHome,
    allowVerified: true,
  });
  const finalizedAutomation = checkpoint.resume_automation;
  const verified = isVerifiedAutomation(finalizedAutomation);
  const notification = await notifyDiscord(
    "QUOTA_PAUSED",
    {
      ...notificationPayload,
      checkpoint: "Saved",
      resume: verified
        ? "Same-thread automation verified"
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
