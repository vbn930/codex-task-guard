import assert from "node:assert/strict";
import { mkdtemp, readFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import test from "node:test";

import { installSkill } from "../scripts/install.mjs";

test("installs the skill and idempotently adds the global task policy", async () => {
  const codexHome = await mkdtemp(path.join(tmpdir(), "task-guard-install-"));
  const first = await installSkill({ codexHome, sourceRoot: path.resolve(".") });
  const second = await installSkill({ codexHome, sourceRoot: path.resolve(".") });

  assert.equal(first.skill_path, path.join(codexHome, "skills", "task-guard"));
  assert.equal(second.skill_path, first.skill_path);
  assert.match(await readFile(path.join(first.skill_path, "SKILL.md"), "utf8"), /name: task-guard/);
  const agents = await readFile(path.join(codexHome, "AGENTS.md"), "utf8");
  assert.equal((agents.match(/TASK-GUARD POLICY START/g) ?? []).length, 1);
  assert.match(agents, /A quota reset is a pause\/resume boundary/);
});
