import assert from "node:assert/strict";
import test from "node:test";

import { generateNativePhasePlan } from "../scripts/lib/phase-generation.mjs";

test("a semantic provider turns task prose into a native phase graph", async () => {
  let request;
  const provider = {
    id: "deterministic-test-provider",
    async generate(input) {
      request = input;
      return {
        phases: [
          {
            phase_id: "contract",
            phase_type: "implementation",
            depends_on: [],
            estimated_files: 2,
          },
          {
            phase_id: "verification",
            phase_type: "testing",
            depends_on: ["contract"],
            estimated_files: 1,
          },
        ],
      };
    },
  };

  const plan = await generateNativePhasePlan({
    taskId: "semantic-task",
    taskDescription: "Add semantic phase generation with strict validation.",
    provider,
  });

  assert.equal(request.task_id, "semantic-task");
  assert.equal(
    request.task_description,
    "Add semantic phase generation with strict validation.",
  );
  assert.equal(request.output_contract.schema_version, 1);
  assert.deepEqual(plan, {
    task_id: "semantic-task",
    generation: {
      mode: "provider",
      provider_id: "deterministic-test-provider",
      contract_version: 1,
    },
    phases: [
      {
        task_id: "semantic-task",
        phase_id: "contract",
        phase_type: "implementation",
        depends_on: [],
        estimated_files: 2,
        plan: "semantic-v1",
      },
      {
        task_id: "semantic-task",
        phase_id: "verification",
        phase_type: "testing",
        depends_on: ["contract"],
        estimated_files: 1,
        plan: "semantic-v1",
      },
    ],
  });
});

test("semantic generation rejects provider fields outside the output contract", async () => {
  const provider = {
    id: "invalid-test-provider",
    async generate() {
      return {
        phases: [
          {
            phase_id: "implementation",
            phase_type: "implementation",
            depends_on: [],
            prompt: "Persist provider prose",
          },
        ],
      };
    },
  };

  await assert.rejects(
    generateNativePhasePlan({
      taskId: "semantic-task",
      taskDescription: "Reject undeclared provider output.",
      provider,
    }),
    /provider phase 0 contains unsupported field prompt/,
  );
});

test("semantic generation rejects undeclared provider root fields", async () => {
  const provider = {
    id: "invalid-root-provider",
    async generate() {
      return {
        explanation: "This prose is outside the contract.",
        phases: [
          {
            phase_id: "implementation",
            phase_type: "implementation",
            depends_on: [],
          },
        ],
      };
    },
  };

  await assert.rejects(
    generateNativePhasePlan({
      taskId: "semantic-task",
      taskDescription: "Reject undeclared root output.",
      provider,
    }),
    /provider output contains unsupported field explanation/,
  );
});

test("semantic generation rejects malformed provider output before graph construction", async () => {
  const provider = {
    id: "malformed-test-provider",
    async generate() {
      return { phases: "not-an-array" };
    },
  };

  await assert.rejects(
    generateNativePhasePlan({
      taskId: "semantic-task",
      taskDescription: "Reject malformed provider output.",
      provider,
    }),
    /provider output phases must be a non-empty array/,
  );
});

test("semantic generation applies native dependency validation to provider output", async () => {
  const provider = {
    id: "invalid-graph-provider",
    async generate() {
      return {
        phases: [
          {
            phase_id: "verification",
            phase_type: "testing",
            depends_on: ["missing-implementation"],
          },
        ],
      };
    },
  };

  await assert.rejects(
    generateNativePhasePlan({
      taskId: "semantic-task",
      taskDescription: "Validate the generated dependency graph.",
      provider,
    }),
    /verification depends on unknown phase missing-implementation/,
  );
});

test("semantic generation validates the task request before calling a provider", async () => {
  let called = false;
  const provider = {
    id: "unused-provider",
    async generate() {
      called = true;
      return { phases: [] };
    },
  };

  await assert.rejects(
    generateNativePhasePlan({ taskId: "semantic-task", taskDescription: " ", provider }),
    /taskDescription must be a non-empty string/,
  );
  assert.equal(called, false);
});

test("semantic generation requires an identified provider implementation", async () => {
  await assert.rejects(
    generateNativePhasePlan({
      taskId: "semantic-task",
      taskDescription: "Require an explicit provider boundary.",
      provider: { generate: async () => ({ phases: [] }) },
    }),
    /provider.id must be a non-empty string/,
  );
});

test("semantic generation requires every declared provider phase field", async () => {
  const provider = {
    id: "incomplete-test-provider",
    async generate() {
      return {
        phases: [{ phase_id: "implementation", phase_type: "implementation" }],
      };
    },
  };

  await assert.rejects(
    generateNativePhasePlan({
      taskId: "semantic-task",
      taskDescription: "Require explicit dependency edges.",
      provider,
    }),
    /provider phase 0 is missing required field depends_on/,
  );
});

test("semantic generation requires a native task identity", async () => {
  await assert.rejects(
    generateNativePhasePlan({
      taskId: "",
      taskDescription: "Generate a graph with a native task identity.",
      provider: {
        id: "unused-provider",
        async generate() {
          throw new Error("must not be called");
        },
      },
    }),
    /taskId must be a non-empty string/,
  );
});

test("a provider cannot weaken the validation contract it receives", async () => {
  const provider = {
    id: "contract-mutating-provider",
    async generate({ output_contract: outputContract }) {
      outputContract.phase.required.length = 0;
      return {
        phases: [{ phase_id: "implementation", phase_type: "implementation" }],
      };
    },
  };

  await assert.rejects(
    generateNativePhasePlan({
      taskId: "semantic-task",
      taskDescription: "Keep provider validation authoritative.",
      provider,
    }),
    /provider phase 0 is missing required field depends_on/,
  );
});
