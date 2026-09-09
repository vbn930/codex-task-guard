import os from "node:os";
import path from "node:path";

export function defaultTaskGuardHome(env = process.env) {
  const codexHome = env.CODEX_HOME ?? path.join(os.homedir(), ".codex");
  return env.TASK_GUARD_HOME ?? path.join(codexHome, "task-guard");
}
