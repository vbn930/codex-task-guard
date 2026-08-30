import assert from "node:assert/strict";
import { mkdtemp, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import test from "node:test";

import { readRateLimits } from "../scripts/lib/app-server.mjs";

test("performs the app-server handshake and reads rate limits", async () => {
  const root = await mkdtemp(path.join(tmpdir(), "task-guard-app-server-"));
  const serverPath = path.join(root, "fake-codex.mjs");
  await writeFile(serverPath, `
import { createInterface } from "node:readline";

const input = createInterface({ input: process.stdin });
input.on("line", (line) => {
  const message = JSON.parse(line);
  if (message.method === "initialize") {
    const valid = message.params?.clientInfo?.name === "task_guard"
      && message.params?.capabilities?.experimentalApi === true;
    process.stdout.write(JSON.stringify(valid
      ? { jsonrpc: "2.0", id: message.id, result: { serverInfo: { name: "fake" } } }
      : { jsonrpc: "2.0", id: message.id, error: { message: "invalid handshake" } }) + "\\n");
  }
  if (message.method === "account/rateLimits/read") {
    process.stdout.write(JSON.stringify({
      jsonrpc: "2.0",
      id: message.id,
      result: { rateLimits: { primary: { usedPercent: 12, windowDurationMins: 300 } } },
    }) + "\\n");
  }
});
`, "utf8");

  const result = await readRateLimits({
    command: process.execPath,
    commandArgs: [serverPath],
    timeoutMs: 2_000,
  });

  assert.equal(result.rateLimits.primary.usedPercent, 12);
});
