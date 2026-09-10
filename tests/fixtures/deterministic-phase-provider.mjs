export default {
  id: "deterministic-test-provider",
  async generate({ task_description: taskDescription }) {
    if (!taskDescription.includes("semantic phase generation")) {
      throw new Error("unexpected deterministic test task");
    }
    return {
      phases: [
        {
          phase_id: "implementation",
          phase_type: "implementation",
          depends_on: [],
          estimated_files: 2,
        },
        {
          phase_id: "verification",
          phase_type: "testing",
          depends_on: ["implementation"],
          estimated_files: 1,
        },
      ],
    };
  },
};
