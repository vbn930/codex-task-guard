import { AppServerClient } from "./app-server.mjs";

const AUTO_VALUES = new Set(["", "auto", "unknown"]);

function runtimeValue(value) {
  if (typeof value !== "string") return "unknown";
  const normalized = value.trim();
  return normalized && normalized.toLowerCase() !== "unknown" ? normalized : "unknown";
}

function automaticValue(value) {
  return value === undefined
    || value === null
    || (typeof value === "string" && AUTO_VALUES.has(value.trim().toLowerCase()));
}

function unavailable(reason) {
  return {
    model: "unknown",
    reasoning_effort: "unknown",
    source: "unavailable",
    status: "UNAVAILABLE",
    reason,
  };
}

export async function readRuntimeIdentity({
  env = process.env,
  clientFactory = (options) => new AppServerClient(options),
  clientOptions,
} = {}) {
  const threadId = runtimeValue(env.CODEX_THREAD_ID);
  if (threadId === "unknown") return unavailable("CURRENT_THREAD_ID_UNAVAILABLE");

  let client;
  try {
    client = clientFactory(clientOptions);
    await client.start();
    const response = await client.request("thread/read", {
      threadId,
      includeTurns: false,
    });
    const thread = response?.thread;
    if (thread?.id !== threadId) return unavailable("THREAD_ID_MISMATCH");

    const sessionId = runtimeValue(env.CODEX_SESSION_ID);
    if (sessionId !== "unknown" && thread.sessionId !== sessionId) {
      return unavailable("SESSION_ID_MISMATCH");
    }

    const model = runtimeValue(thread.model);
    const reasoningEffort = runtimeValue(thread.reasoningEffort);
    const knownCount = [model, reasoningEffort].filter((value) => value !== "unknown").length;
    return {
      model,
      reasoning_effort: reasoningEffort,
      source: "codex_app_server_thread",
      status: knownCount === 2 ? "VERIFIED" : knownCount === 1 ? "PARTIAL" : "UNAVAILABLE",
      reason: knownCount === 2 ? null : "RUNTIME_FIELDS_UNAVAILABLE",
    };
  } catch {
    return unavailable("APP_SERVER_READ_FAILED");
  } finally {
    client?.stop();
  }
}

export async function resolvePhasesRuntimeIdentity(phases, {
  reader = readRuntimeIdentity,
} = {}) {
  if (!Array.isArray(phases) || phases.length === 0) {
    throw new Error("phases must be a non-empty array");
  }
  const needsRuntimeRead = phases.some((phase) => (
    automaticValue(phase?.model) || automaticValue(phase?.reasoning_effort)
  ));
  const identity = needsRuntimeRead ? await reader() : null;

  return phases.map((phase) => {
    const modelIsAutomatic = automaticValue(phase.model);
    const reasoningIsAutomatic = automaticValue(phase.reasoning_effort);
    const model = modelIsAutomatic ? identity.model : phase.model;
    const reasoningEffort = reasoningIsAutomatic
      ? identity.reasoning_effort
      : phase.reasoning_effort;
    return {
      ...phase,
      model,
      reasoning_effort: reasoningEffort,
      model_source: modelIsAutomatic
        ? (model === "unknown" ? "unavailable" : identity.source)
        : "caller",
      reasoning_effort_source: reasoningIsAutomatic
        ? (reasoningEffort === "unknown" ? "unavailable" : identity.source)
        : "caller",
    };
  });
}
