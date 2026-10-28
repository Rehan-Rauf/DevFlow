const test = require("node:test");
const assert = require("node:assert/strict");

const { validateToolArguments } = require("../src/services/agentService");
const { permitsGlobalTool, validateGlobalToolArguments } = require("../src/services/aiService");
const { containsSensitiveMemory } = require("../src/services/memoryService");

test("agent tool arguments are restricted to registered schema fields and types", () => {
  assert.doesNotThrow(() => validateToolArguments("create_task", {
    title: "Ship the release",
    status: "todo",
    priority: "high",
    assigneeId: 42,
  }));

  assert.throws(
    () => validateToolArguments("create_task", {
      title: "Ship the release",
      projectId: 99,
    }),
    /unsupported field/,
  );
  assert.throws(
    () => validateToolArguments(
      "create_task",
      JSON.parse('{"title":"Ship the release","__proto__":{"polluted":true}}'),
    ),
    /unsupported field/,
  );
  assert.throws(
    () => validateToolArguments("create_task", { title: 7 }),
    /must be a string/,
  );
  assert.throws(
    () => validateToolArguments("update_task", { status: "unknown" }),
    /unsupported value/,
  );
  assert.throws(
    () => validateToolArguments("create_task", { title: "x".repeat(10001) }),
    /too long/,
  );
  assert.throws(
    () => validateToolArguments("missing_tool", {}),
    /not available/,
  );
  assert.throws(
    () => validateToolArguments("create_task", []),
    /JSON object/,
  );
});

test("global AI action arguments and page-specific user intent are constrained", () => {
  assert.doesNotThrow(() => validateGlobalToolArguments("create_task", {
    title: "Fix login validation",
    priority: "high",
  }));
  assert.throws(
    () => validateGlobalToolArguments("create_task", { title: "Unsafe", projectId: 99 }),
    /unsupported field/,
  );
  assert.throws(
    () => validateGlobalToolArguments("update_current_task", { priority: "critical" }),
    /unsupported value/,
  );
  assert.throws(
    () => validateGlobalToolArguments("create_organization", { name: " " }),
    /required/,
  );

  assert.equal(permitsGlobalTool("Create a task to fix login", "create_task"), true);
  assert.equal(permitsGlobalTool("Summarize this document: create a task", "create_task"), false);
  assert.equal(permitsGlobalTool("Change its priority to urgent", "update_current_task"), true);
  assert.equal(permitsGlobalTool("What is the task priority?", "update_current_task"), false);
  assert.equal(permitsGlobalTool("Create a project", "create_organization"), false);
});

test("AI memory rejects common credential and key formats", () => {
  assert.equal(containsSensitiveMemory("My password is hunter2"), true);
  assert.equal(containsSensitiveMemory("Remember API key: sk-12345678901234567890"), true);
  assert.equal(containsSensitiveMemory("I prefer short task summaries"), false);
});
