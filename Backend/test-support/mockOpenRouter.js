if (process.env.DEVFLOW_TEST_MOCK_OPENROUTER === "1") {
  const originalFetch = global.fetch;
  global.fetch = async (input, options) => {
    const url = typeof input === "string" ? input : input.url;
    if (url === "https://openrouter.ai/api/v1/embeddings") {
      const request = JSON.parse(options.body);
      if (request.input === "devflow-integration-force-embedding-failure") {
        return new Response(
          JSON.stringify({ error: { message: "private embedding provider diagnostic" } }),
          { status: 503, headers: { "Content-Type": "application/json" } },
        );
      }
      return new Response(
        JSON.stringify({ data: [{ embedding: Array.from({ length: 1536 }, (_, index) => index === 0 ? 0.1 : 0) }] }),
        { status: 200, headers: { "Content-Type": "application/json" } },
      );
    }
    if (url !== "https://openrouter.ai/api/v1/chat/completions") {
      return originalFetch(input, options);
    }

    const request = JSON.parse(options.body);
    const lastMessage = request.messages?.[request.messages.length - 1];
    let message;
    const hasLatestToolResult = lastMessage?.role === "tool";
    if (request.tools?.length && !hasLatestToolResult) {
      const toolNames = request.tools.map((tool) => tool.function.name);
      const requestText = String(
        request.messages?.filter((entry) => entry.role === "user").at(-1)?.content || "",
      ).toLowerCase();
      const asksForTaskUpdate = /\b(change|set|mark|update)\b/.test(requestText)
        && /\b(status|priority|title|description|assignee|due date)\b/.test(requestText);
      const toolName = toolNames.includes("delete_task") && /\bdelete\b/.test(requestText)
        ? "delete_task"
        : toolNames.includes("update_task") && asksForTaskUpdate
          ? "update_task"
          : toolNames.includes("create_task") && /\bcreate\b/.test(requestText)
            ? "create_task"
        : toolNames.includes("update_current_task")
          ? "update_current_task"
          : toolNames[0];
      const argumentsByTool = {
        create_organization: { name: "AI-created integration organization", description: "Created through the tested AI tool." },
        create_project: { name: "AI-created integration project", description: "Created through the tested AI tool." },
        create_task: { title: "AI-created integration task", description: "Created through the tested AI tool.", priority: "high" },
        update_task: /\bstatus\b/.test(requestText)
          ? { status: "done" }
          : { priority: "high" },
        update_current_task: { priority: "urgent" },
      };
      if (toolNames.includes("update_task") && /\bupdate this task\b/.test(requestText) && !asksForTaskUpdate) {
        message = { role: "assistant", content: "What would you like me to update?" };
      } else {
        message = {
          role: "assistant",
          tool_calls: [{
            id: `integration-${toolName}`,
            type: "function",
            function: { name: toolName, arguments: JSON.stringify(argumentsByTool[toolName] || {}) },
          }],
        };
      }
    } else if (hasLatestToolResult) {
      message = { role: "assistant", content: "The requested integration action completed." };
    } else {
      message = { role: "assistant", content: '{"relevant":true}' };
    }

    return new Response(
      JSON.stringify({ choices: [{ message }] }),
      { status: 200, headers: { "Content-Type": "application/json" } },
    );
  };
}
