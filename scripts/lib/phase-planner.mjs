import { createHash } from "node:crypto";
import { readFile, rm } from "node:fs/promises";
import path from "node:path";

import { atomicWriteText, withFileLock } from "./fs-safe.mjs";
import { canonicalProjectIdentity, resolveProjectRoot } from "./repository-state.mjs";
import { defaultTaskGuardHome } from "./runtime-paths.mjs";
import { evaluateBudget } from "./usage.mjs";

const PHASE_FIELDS = [
  "task_id",
  "phase_id",
  "phase_type",
  "depends_on",
  "estimated_files",
  "plan",
  "context_bucket",
  "files_before",
  "expected_files_touched",
  "tool_profile",
  "model",
  "reasoning_effort",
];

function normalizedPhases(phases, { requireTaskId = false } = {}) {
  if (!Array.isArray(phases) || phases.length === 0) {
    throw new Error("phases must be a non-empty array");
  }
  return phases.map((phase, index) => {
    for (const field of [
      ...(requireTaskId ? ["task_id"] : []),
      "phase_id",
      "phase_type",
    ]) {
      if (typeof phase?.[field] !== "string" || phase[field].trim() === "") {
        throw new Error(`phases[${index}].${field} must be a non-empty string`);
      }
    }
    if (phase.depends_on !== undefined && !Array.isArray(phase.depends_on)) {
      throw new Error(`phases[${index}].depends_on must be an array`);
    }
    if (phase.estimated_files !== undefined
      && (!Number.isInteger(phase.estimated_files) || phase.estimated_files < 0)) {
      throw new Error(`phases[${index}].estimated_files must be a non-negative integer`);
    }
    return Object.fromEntries(PHASE_FIELDS
      .filter((field) => phase[field] !== undefined)
      .map((field) => [field, field === "depends_on" ? [...phase[field]] : phase[field]]));
  });
}

function validateTaskIdentity(phases, taskId) {
  const taskIds = new Set(phases.map(({ task_id: id }) => id));
  if (taskIds.size !== 1) throw new Error("all phases must belong to one task_id");
  const [phaseTaskId] = taskIds;
  if (taskId !== undefined && taskId !== phaseTaskId) {
    throw new Error(`phase plan belongs to ${phaseTaskId}, not ${taskId}`);
  }
  return phaseTaskId;
}

async function planLocation(projectPath, taskGuardHome) {
  const projectRoot = await resolveProjectRoot(projectPath, { allowNonGit: true });
  const projectKey = createHash("sha256")
    .update(canonicalProjectIdentity(projectRoot))
    .digest("hex");
  return {
    projectRoot,
    planPath: path.join(taskGuardHome, "phase-plans", `${projectKey}.json`),
  };
}

async function readPlanFile(planPath) {
  try {
    return JSON.parse(await readFile(planPath, "utf8"));
  } catch (error) {
    if (error.code === "ENOENT") return null;
    throw error;
  }
}

export function evaluatePhasePlan({ phases, completedPhaseIds = [] }) {
  const normalized = normalizedPhases(phases);
  const phaseIds = new Set(normalized.map(({ phase_id: phaseId }) => phaseId));
  if (phaseIds.size !== normalized.length) throw new Error("phase_id values must be unique");
  for (const phase of normalized) {
    for (const dependency of phase.depends_on ?? []) {
      if (!phaseIds.has(dependency)) {
        throw new Error(`${phase.phase_id} depends on unknown phase ${dependency}`);
      }
    }
  }
  const phasesById = new Map(normalized.map((phase) => [phase.phase_id, phase]));
  const visiting = new Set();
  const visited = new Set();
  const visit = (phaseId) => {
    if (visiting.has(phaseId)) throw new Error("phase plan contains a dependency cycle");
    if (visited.has(phaseId)) return;
    visiting.add(phaseId);
    for (const dependency of phasesById.get(phaseId).depends_on ?? []) visit(dependency);
    visiting.delete(phaseId);
    visited.add(phaseId);
  };
  for (const phaseId of phaseIds) visit(phaseId);
  const completed = new Set(completedPhaseIds);
  const evaluated = normalized.map((phase) => {
    if (completed.has(phase.phase_id)) {
      return { ...phase, status: "COMPLETED", dependencies_met: false };
    }
    const dependenciesMet = (phase.depends_on ?? []).every((phaseId) => completed.has(phaseId));
    return {
      ...phase,
      status: dependenciesMet ? "READY" : "DEPENDENCY_BLOCKED",
      dependencies_met: dependenciesMet,
    };
  });
  return {
    phases: evaluated,
    ready_phase_ids: evaluated
      .filter(({ status }) => status === "READY")
      .map(({ phase_id: phaseId }) => phaseId),
  };
}

export async function loadOrCreatePhasePlan({
  projectPath,
  taskId,
  phases,
  completedPhaseIds = [],
  taskGuardHome = defaultTaskGuardHome(),
}) {
  const { projectRoot, planPath } = await planLocation(projectPath, taskGuardHome);
  return withFileLock(`${planPath}.lock`, async () => {
    const existing = await readPlanFile(planPath);
    if (existing) {
      if (taskId !== undefined && existing.task_id !== taskId) {
        throw new Error(`phase plan belongs to ${existing.task_id}, not ${taskId}`);
      }
      return existing;
    }
    const normalized = normalizedPhases(phases, { requireTaskId: true });
    const resolvedTaskId = validateTaskIdentity(normalized, taskId);
    evaluatePhasePlan({ phases: normalized, completedPhaseIds });
    const state = {
      schema_version: 1,
      task_id: resolvedTaskId,
      project_path: projectRoot,
      phases: normalized,
      completed_phase_ids: [...new Set(completedPhaseIds)],
      updated_at: new Date().toISOString(),
    };
    await atomicWriteText(planPath, `${JSON.stringify(state, null, 2)}\n`);
    return state;
  });
}

export async function readPhasePlan({
  projectPath,
  taskGuardHome = defaultTaskGuardHome(),
}) {
  const { planPath } = await planLocation(projectPath, taskGuardHome);
  return readPlanFile(planPath);
}

export async function clearPhasePlan({
  projectPath,
  taskId,
  taskGuardHome = defaultTaskGuardHome(),
}) {
  const { planPath } = await planLocation(projectPath, taskGuardHome);
  return withFileLock(`${planPath}.lock`, async () => {
    const state = await readPlanFile(planPath);
    if (!state) return false;
    if (taskId !== undefined && state.task_id !== taskId) {
      throw new Error(`phase plan belongs to ${state.task_id}, not ${taskId}`);
    }
    await rm(planPath);
    return true;
  });
}

export async function completePhasePlan({
  projectPath,
  phaseId,
  taskGuardHome = defaultTaskGuardHome(),
}) {
  const { planPath } = await planLocation(projectPath, taskGuardHome);
  return withFileLock(`${planPath}.lock`, async () => {
    const state = await readPlanFile(planPath);
    if (!state) throw new Error("phase plan does not exist");
    if (!state.phases.some(({ phase_id: candidate }) => candidate === phaseId)) {
      throw new Error(`phase plan does not contain ${phaseId}`);
    }
    const completedPhaseIds = [...new Set([...state.completed_phase_ids, phaseId])];
    evaluatePhasePlan({ phases: state.phases, completedPhaseIds });
    const completed = {
      ...state,
      completed_phase_ids: completedPhaseIds,
      updated_at: new Date().toISOString(),
    };
    await atomicWriteText(planPath, `${JSON.stringify(completed, null, 2)}\n`);
    return completed;
  });
}

export function evaluatePlannedBudget({
  history,
  phases,
  completedPhaseIds = [],
  snapshot,
  safetyReservePercent,
}) {
  const plan = evaluatePhasePlan({ phases, completedPhaseIds });
  const pendingPhases = plan.phases.filter(({ status }) => status !== "COMPLETED");
  if (pendingPhases.length === 0) {
    const baseline = evaluateBudget({
      history,
      phases: plan.phases.map((phase) => ({ ...phase, dependencies_met: false })),
      snapshot,
      safetyReservePercent,
    });
    return {
      ...baseline,
      decision: "PLAN_COMPLETE",
      selected_phase_id: null,
      phases: plan.phases.map(({ phase_id: phaseId }) => ({
        phase_id: phaseId,
        status: "COMPLETED",
        estimated_upper_cost: null,
      })),
    };
  }
  const budget = evaluateBudget({
    history,
    phases: pendingPhases,
    snapshot,
    safetyReservePercent,
  });
  const budgetById = new Map(budget.phases.map((phase) => [phase.phase_id, phase]));
  return {
    ...budget,
    ready_phase_ids: plan.ready_phase_ids,
    phases: plan.phases.map((phase) => (
      phase.status === "COMPLETED"
        ? { phase_id: phase.phase_id, status: "COMPLETED", estimated_upper_cost: null }
        : budgetById.get(phase.phase_id)
    )),
  };
}
