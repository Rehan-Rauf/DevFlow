import { afterEach, describe, expect, test, vi } from "vitest";
import aiService, {
  chatSessionHistory,
  taskAgent,
  taskChat,
  taskChatEnd,
  taskChatHistory,
} from "./aiService";

const { apiMock } = vi.hoisted(() => ({
  apiMock: {
    taskAgent: vi.fn(),
    taskChat: vi.fn(),
    taskChatEnd: vi.fn(),
    taskChatHistory: vi.fn(),
    chatSessionHistory: vi.fn(),
  },
}));

vi.mock("./api", () => ({ api: apiMock }));

afterEach(() => vi.clearAllMocks());

describe("aiService task API exports", () => {
  test("exports the same authenticated API methods used by both task panels", async () => {
    apiMock.taskAgent.mockResolvedValue({ success: true });
    apiMock.taskChat.mockResolvedValue({ success: true });
    apiMock.taskChatEnd.mockResolvedValue({ success: true });
    apiMock.taskChatHistory.mockResolvedValue({ success: true });
    apiMock.chatSessionHistory.mockResolvedValue({ success: true });

    await taskAgent(42, "Update this task");
    await taskChat(42, "Summarize this task");
    await taskChatHistory(42);
    await taskChatEnd(42);
    await chatSessionHistory("session-1");

    expect(aiService.taskAgent).toBe(taskAgent);
    expect(apiMock.taskAgent).toHaveBeenCalledWith(42, "Update this task");
    expect(apiMock.taskChat).toHaveBeenCalledWith(42, "Summarize this task");
    expect(apiMock.taskChatHistory).toHaveBeenCalledWith(42);
    expect(apiMock.taskChatEnd).toHaveBeenCalledWith(42);
    expect(apiMock.chatSessionHistory).toHaveBeenCalledWith("session-1");
  });
});
