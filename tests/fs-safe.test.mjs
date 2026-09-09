import assert from "node:assert/strict";
import { mkdtemp, mkdir, readdir } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";

import { atomicWriteText } from "../scripts/lib/fs-safe.mjs";

test("atomic text writes clean up their temporary file after a failed rename", async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), "task-guard-atomic-write-"));
  const target = path.join(root, "target");
  await mkdir(target);

  await assert.rejects(atomicWriteText(target, "content"));

  assert.deepEqual(await readdir(root), ["target"]);
});
