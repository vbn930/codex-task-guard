import path from "node:path";
import { pathToFileURL } from "node:url";

import { evaluatePhasePlan } from "./phase-planner.mjs";

const CONTRACT_VERSION = 1;
const ROOT_FIELDS = new Set(["phases"]);
const PHASE_FIELDS = new Set(["phase_id", "phase_type", "depends_on", "estimated_files"]);
const REQUIRED_PHASE_FIELDS = ["phase_id", "phase_type", "depends_on"];

const OUTPUT_CONTRACT = Object.freeze({
  schema_version: CONTRACT_VERSION,
  root: {
    required: ["phases"],
    additional_properties: false,
  },
  phase: {
    required: REQUIRED_PHASE_FIELDS,
    optional: ["estimated_files"],
    additional_properties: false,
  },
});

export async function loadPhaseGenerationProvider(providerPath) {
  if (typeof providerPath !== "string" || providerPath.trim() === "") {
    throw new Error("--provider is required");
  }
  const moduleUrl = pathToFileURL(path.resolve(providerPath)).href;
  const providerModule = await import(moduleUrl);
  return providerModule.default;
}

export async function generateNativePhasePlan({
  taskId,
  taskDescription,
  safetyReservePercent,
  provider,
}) {
  if (typeof taskId !== "string" || taskId.trim() === "") {
    throw new Error("taskId must be a non-empty string");
  }
  if (typeof taskDescription !== "string" || taskDescription.trim() === "") {
    throw new Error("taskDescription must be a non-empty string");
  }
  if (typeof provider?.id !== "string" || provider.id.trim() === "") {
    throw new Error("provider.id must be a non-empty string");
  }
  if (typeof provider.generate !== "function") {
    throw new Error("provider.generate must be a function");
  }
  const output = await provider.generate({
    task_id: taskId,
    task_description: taskDescription,
    output_contract: structuredClone(OUTPUT_CONTRACT),
  });
  if (!output || typeof output !== "object" || Array.isArray(output)) {
    throw new Error("provider output must be an object");
  }
  for (const field of Object.keys(output)) {
    if (!ROOT_FIELDS.has(field)) {
      throw new Error(`provider output contains unsupported field ${field}`);
    }
  }
  if (!Array.isArray(output.phases) || output.phases.length === 0) {
    throw new Error("provider output phases must be a non-empty array");
  }
  const phases = output.phases.map((phase, index) => {
    if (!phase || typeof phase !== "object" || Array.isArray(phase)) {
      throw new Error(`provider phase ${index} must be an object`);
    }
    for (const field of Object.keys(phase)) {
      if (!PHASE_FIELDS.has(field)) {
        throw new Error(`provider phase ${index} contains unsupported field ${field}`);
      }
    }
    for (const field of REQUIRED_PHASE_FIELDS) {
      if (!Object.hasOwn(phase, field)) {
        throw new Error(`provider phase ${index} is missing required field ${field}`);
      }
    }
    return {
      task_id: taskId,
      ...phase,
      plan: "semantic-v1",
    };
  });
  evaluatePhasePlan({ phases });
  return {
    task_id: taskId,
    ...(safetyReservePercent === undefined
      ? {}
      : { safety_reserve_percent: safetyReservePercent }),
    generation: {
      mode: "provider",
      provider_id: provider.id,
      contract_version: CONTRACT_VERSION,
    },
    phases,
  };
}
