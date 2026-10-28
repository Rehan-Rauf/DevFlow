import { render, screen, within } from "@testing-library/react";
import { MemoryRouter } from "react-router-dom";
import userEvent from "@testing-library/user-event";
import { beforeEach, describe, expect, test, vi } from "vitest";
import TaskAgentWorkspace from "./TaskAgentWorkspace";

const { apiMock } = vi.hoisted(() => ({
  apiMock: {
    taskChat: vi.fn(),
    taskChatHistory: vi.fn(),
    taskAgent: vi.fn(),
  },
}));

vi.mock("../services/aiService", () => ({ default: apiMock }));

describe("TaskAgentWorkspace", () => {
  beforeEach(() => {
    apiMock.taskChat.mockReset();
    apiMock.taskChatHistory.mockResolvedValue({
      data: { messages: [], sessionStatus: "ACTIVE" },
    });
    apiMock.taskAgent.mockReset();
  });

  test("shows separate modes and keeps the supplied task and project context", async () => {
    render(
      <MemoryRouter>
        <TaskAgentWorkspace
          taskId={42}
          task={{ id: 42, title: "Fix login flow" }}
          projectId={10}
          organizationId={5}
        />
      </MemoryRouter>,
    );

    expect(screen.getByText("Fix login flow")).toBeInTheDocument();
    expect(screen.getByRole("tab", { name: /Ask AI/ })).toHaveAttribute("aria-selected", "true");
    expect(screen.getByRole("tab", { name: /Take Action/ })).toHaveAttribute("aria-selected", "false");
    expect(await screen.findByText(/Ask anything about this task/)).toBeInTheDocument();
    expect(screen.getByLabelText("Ask the task agent").closest('[role="tabpanel"]')).toHaveAttribute("hidden");
    expect(screen.getByText(/Project #10/)).toBeInTheDocument();
    expect(screen.getByText(/Organization #5/)).toBeInTheDocument();
    expect(apiMock.taskChatHistory).toHaveBeenCalledWith(42);

    await userEvent.setup().click(screen.getByRole("tab", { name: /Take Action/ }));
    expect(screen.getByLabelText("Ask the task agent").closest('[role="tabpanel"]')).not.toHaveAttribute("hidden");
  });

  test("shows an empty state without inventing a task ID", () => {
    render(<TaskAgentWorkspace />);

    expect(screen.getByText("Choose a task to open its assistant workspace.")).toBeInTheDocument();
    expect(screen.queryByLabelText("Ask the task agent")).not.toBeInTheDocument();
  });

  test("Ask AI sends the selected task ID and renders the backend answer", async () => {
    apiMock.taskChat.mockResolvedValue({
      data: { answer: "Facts: **Status** is todo.\n\nNext steps: clarify the acceptance criteria." },
    });
    const user = userEvent.setup();
    render(
      <MemoryRouter>
        <TaskAgentWorkspace taskId={42} task={{ id: 42, title: "Task context" }} />
      </MemoryRouter>,
    );

    await user.click(screen.getByRole("button", { name: "Summarize this task" }));

    expect(await screen.findByText(/Facts:/)).toBeInTheDocument();
    expect(apiMock.taskChat).toHaveBeenCalledWith(42, "Summarize this task");
  });

  test("Ask AI sends on Enter, supports Shift+Enter, and retries failed requests", async () => {
    apiMock.taskChat
      .mockRejectedValueOnce(new Error("AI service unavailable"))
      .mockResolvedValueOnce({ data: { answer: "The task is ready for review." } });
    const user = userEvent.setup();
    render(
      <MemoryRouter>
        <TaskAgentWorkspace taskId={42} task={{ id: 42, title: "Keyboard task" }} />
      </MemoryRouter>,
    );
    const input = screen.getByPlaceholderText("Ask AI about this task…");
    await user.type(input, "What is the status?");
    await user.keyboard("{Shift>}{Enter}{/Shift}");
    expect(apiMock.taskChat).not.toHaveBeenCalled();
    expect(input).toHaveValue("What is the status?\n");

    await user.keyboard("{Enter}");
    expect(await screen.findByRole("alert")).toHaveTextContent("AI service unavailable");
    expect(apiMock.taskChat).toHaveBeenCalledOnce();
    await user.click(screen.getByRole("button", { name: "Retry request" }));
    expect(await screen.findByText("The task is ready for review.")).toBeInTheDocument();
    expect(apiMock.taskChat).toHaveBeenCalledTimes(2);
  });

  test("Take Action reports only backend-confirmed changes and refreshes the created project's tasks", async () => {
    apiMock.taskAgent.mockResolvedValue({
      data: {
        answer: "The task priority is now high.",
        changes: [
          {
            type: "updated",
            task: { id: 42, title: "Task context" },
            before: { priority: "medium" },
            after: { priority: "high" },
          },
          {
            type: "created",
            task: { id: 57, title: "Fix Login API", project_id: 10 },
          },
        ],
      },
    });
    const createdEvent = vi.fn();
    window.addEventListener("devflow:task-created", createdEvent);
    const user = userEvent.setup();
    render(
      <MemoryRouter>
        <TaskAgentWorkspace
          taskId={42}
          task={{ id: 42, title: "Task context" }}
          projectId={10}
        />
      </MemoryRouter>,
    );

    await user.click(screen.getByRole("tab", { name: /Take Action/ }));
    const input = screen.getByLabelText("Ask the task agent");
    await user.type(input, "Set this task's priority to High");
    await user.click(within(input.closest(".task-agent-panel")).getByRole("button", { name: "Send" }));

    await screen.findByText(/Created task · Fix Login API/);
    expect(document.querySelector(".task-agent-change")).toHaveTextContent(/medium.*high/);
    expect(apiMock.taskAgent).toHaveBeenCalledWith(42, "Set this task's priority to High", null, null);
    expect(createdEvent).toHaveBeenCalledOnce();
    expect(createdEvent.mock.calls[0][0].detail).toEqual({ taskId: 57, projectId: 10 });
    window.removeEventListener("devflow:task-created", createdEvent);
  });

  test("requires backend-issued confirmation before requesting task deletion", async () => {
    apiMock.taskAgent
      .mockResolvedValueOnce({
        data: {
          answer: "Deleting this task cannot be undone. Confirm deletion to continue.",
          requiresConfirmation: true,
          confirmationToken: "signed-confirmation",
          confirmationAction: "delete_task",
        },
      })
      .mockResolvedValueOnce({ data: { answer: "The task was deleted.", deleted: true } });
    const onTaskDeleted = vi.fn();
    const user = userEvent.setup();
    render(
      <MemoryRouter>
        <TaskAgentWorkspace taskId={42} task={{ id: 42, title: "Delete me" }} onTaskDeleted={onTaskDeleted} />
      </MemoryRouter>,
    );

    await user.click(screen.getByRole("tab", { name: /Take Action/ }));
    await user.type(screen.getByLabelText("Ask the task agent"), "Delete this task");
    await user.click(screen.getByRole("button", { name: "Send" }));
    expect(await screen.findByRole("dialog", { name: "Delete task" })).toBeInTheDocument();
    expect(apiMock.taskAgent).toHaveBeenCalledOnce();

    await user.click(within(screen.getByRole("dialog", { name: "Delete task" })).getByRole("button", { name: "Delete task" }));
    expect(await screen.findByText("The task was deleted.")).toBeInTheDocument();
    expect(apiMock.taskAgent).toHaveBeenLastCalledWith(42, "Delete this task", "signed-confirmation", "delete_task");
    expect(onTaskDeleted).toHaveBeenCalledOnce();
  });

  test("does not show a success change when the agent returns no backend change record", async () => {
    apiMock.taskAgent.mockResolvedValue({ data: { answer: "Please clarify which field you want to change." } });
    const user = userEvent.setup();
    render(
      <MemoryRouter>
        <TaskAgentWorkspace taskId={42} task={{ id: 42, title: "Ambiguous task" }} />
      </MemoryRouter>,
    );

    await user.click(screen.getByRole("tab", { name: /Take Action/ }));
    await user.type(screen.getByLabelText("Ask the task agent"), "Update this task");
    await user.click(screen.getByRole("button", { name: "Send" }));

    expect(await screen.findByText("Please clarify which field you want to change.")).toBeInTheDocument();
    expect(screen.queryByText(/Updated task ·/)).not.toBeInTheDocument();
  });

  test("shows a useful Task AI history error and allows retry", async () => {
    apiMock.taskChatHistory
      .mockRejectedValueOnce(new Error("AI service unavailable"))
      .mockResolvedValueOnce({ data: { messages: [], sessionStatus: "ACTIVE" } });

    render(
      <MemoryRouter>
        <TaskAgentWorkspace taskId={42} task={{ id: 42, title: "Retry history" }} />
      </MemoryRouter>,
    );

    expect(await screen.findByRole("alert")).toHaveTextContent("AI service unavailable");
    await userEvent.setup().click(screen.getByRole("button", { name: "Retry loading history" }));
    expect(await screen.findByText(/Ask anything about this task/)).toBeInTheDocument();
  });

  test("preserves failed agent requests and retries them through the real Task Agent panel", async () => {
    apiMock.taskAgent
      .mockRejectedValueOnce(new Error("Model unavailable"))
      .mockResolvedValueOnce({ data: { answer: "Task updated." } });

    render(
      <MemoryRouter>
        <TaskAgentWorkspace taskId={42} task={{ id: 42, title: "Retry agent" }} />
      </MemoryRouter>,
    );
    await userEvent.setup().click(screen.getByRole("tab", { name: /Take Action/ }));
    const input = screen.getByLabelText("Ask the task agent");
    const user = userEvent.setup();
    const taskAgentPanel = within(input.closest(".task-agent-panel"));
    await user.type(input, "Update the task status");
    await user.click(taskAgentPanel.getByRole("button", { name: "Send" }));
    expect(await screen.findByRole("alert")).toHaveTextContent("Model unavailable");
    expect(input).toHaveValue("Update the task status");
    await user.click(taskAgentPanel.getByRole("button", { name: "Retry request" }));

    expect(await screen.findByText("Task updated.")).toBeInTheDocument();
    expect(apiMock.taskAgent).toHaveBeenCalledTimes(2);
    expect(apiMock.taskAgent).toHaveBeenLastCalledWith(42, "Update the task status", null, null);
  });
});
