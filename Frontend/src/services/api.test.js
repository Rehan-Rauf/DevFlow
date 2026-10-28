import { afterEach, describe, expect, test, vi } from "vitest";

import { api } from "./api";

const originalFetch = global.fetch;

afterEach(() => {
  global.fetch = originalFetch;
  localStorage.clear();
});

describe("api client", () => {
  test("sends bearer tokens only when they are present and clears stale sessions on 401", async () => {
    const fetchMock = vi.fn().mockResolvedValue({
      ok: true,
      status: 200,
      json: async () => ({ ok: true, data: { id: 1 } }),
    });
    global.fetch = fetchMock;
    localStorage.setItem("cms_token", "abc123");

    await api.me();

    expect(fetchMock).toHaveBeenCalledWith(
      "http://localhost:5001/api/auth/me",
      expect.objectContaining({
        headers: expect.objectContaining({
          Authorization: "Bearer abc123",
        }),
      })
    );

    const badResponse = {
      ok: false,
      status: 401,
      json: async () => ({ message: "Session expired" }),
    };
    global.fetch = vi.fn().mockResolvedValue(badResponse);
    localStorage.setItem("cms_token", "expired");

    await expect(api.me()).rejects.toThrow("Session expired");
    expect(localStorage.getItem("cms_token")).toBeNull();
  });

  test("returns a clear error message when the backend reports a failure", async () => {
    global.fetch = vi.fn().mockResolvedValue({
      ok: false,
      status: 400,
      json: async () => ({ message: "Invalid email or password" }),
    });

    await expect(api.login({ email: "bad@example.com", password: "bad" })).rejects.toThrow("Invalid email or password");
  });

  test("posts task-agent actions to the authenticated task-scoped endpoint", async () => {
    const fetchMock = vi.fn().mockResolvedValue({
      ok: true,
      status: 200,
      json: async () => ({ success: true, data: { answer: "Updated." } }),
    });
    global.fetch = fetchMock;
    localStorage.setItem("cms_token", "task-token");

    await api.taskAgent(42, "Change the status", "confirmation-token", "delete_task");

    expect(fetchMock).toHaveBeenCalledWith(
      "http://localhost:5001/api/ai/task/42/agent",
      expect.objectContaining({
        method: "POST",
        headers: expect.objectContaining({ Authorization: expect.stringContaining("Bearer ") }),
        body: JSON.stringify({
          message: "Change the status",
          confirmationToken: "confirmation-token",
          confirmationAction: "delete_task",
        }),
      }),
    );
  });

  test("preserves task-agent backend and authentication errors", async () => {
    global.fetch = vi.fn().mockResolvedValue({
      ok: false,
      status: 403,
      json: async () => ({ success: false, message: "You do not have access to this task." }),
    });

    await expect(api.taskAgent(42, "Show task details")).rejects.toMatchObject({
      message: "You do not have access to this task.",
      status: 403,
    });
  });
});
