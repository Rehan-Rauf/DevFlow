import { fireEvent, render, screen, waitFor } from "@testing-library/react";
import { MemoryRouter } from "react-router-dom";
import { useState } from "react";
import { beforeEach, describe, expect, test, vi } from "vitest";
import TaskAgentDialog from "./TaskAgentDialog";

const { apiMock, aiServiceMock } = vi.hoisted(() => ({
  apiMock: {
    getTask: vi.fn(),
    getMyTasks: vi.fn(),
    tasks: vi.fn(),
    projects: vi.fn(),
  },
  aiServiceMock: {
    taskChatHistory: vi.fn(),
    taskChatEnd: vi.fn(),
    chatSessionHistory: vi.fn(),
    taskAgent: vi.fn(),
  },
}));

vi.mock("../services/api", () => ({ api: apiMock }));
vi.mock("../services/aiService", () => ({ default: aiServiceMock }));

const task = {
  id: 42,
  title: "Fix login flow",
  project_id: 10,
  project_name: "Launch",
  organization_id: 5,
  organization_name: "Northwind",
};

function renderDialog(props = {}) {
  return render(
    <MemoryRouter>
      <TaskAgentDialog open scope={null} onClose={vi.fn()} {...props} />
    </MemoryRouter>,
  );
}

function ControlledTaskAgentDialog({ scope, onClosed }) {
  const [open, setOpen] = useState(true);
  return (
    <>
      <button type="button" onClick={() => setOpen(true)}>Reopen task agent</button>
      <TaskAgentDialog
        open={open}
        scope={scope}
        onClose={() => {
          setOpen(false);
          onClosed?.();
        }}
      />
    </>
  );
}

describe("TaskAgentDialog", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    apiMock.getTask.mockResolvedValue({ data: task });
    apiMock.getMyTasks.mockResolvedValue({ data: [task] });
    apiMock.tasks.mockResolvedValue({ data: [task] });
    apiMock.projects.mockResolvedValue({ data: [] });
    aiServiceMock.taskChatHistory.mockResolvedValue({
      data: { messages: [], sessionStatus: "ACTIVE" },
    });
  });

  test("opens the task from task-page context in the Task Assistant workspace", async () => {
    renderDialog({ scope: { entityType: "task", entityId: 42 } });

    expect(apiMock.getTask).toHaveBeenCalledWith(42);
    expect(await screen.findByRole("dialog", { name: "Task Assistant" })).toBeInTheDocument();
    expect(screen.getByText("Fix login flow")).toBeInTheDocument();
    expect(screen.getByRole("tab", { name: /Ask AI/ })).toHaveAttribute("aria-selected", "true");
    expect(await screen.findByText(/Ask anything about this task/)).toBeInTheDocument();
    expect(aiServiceMock.taskChatHistory).toHaveBeenCalledWith(42);
  });

  test("requires an explicit task choice globally and fetches its real context", async () => {
    renderDialog();

    expect(await screen.findByLabelText("Choose a task")).toBeInTheDocument();
    expect(apiMock.getMyTasks).toHaveBeenCalledOnce();
    expect(apiMock.getTask).not.toHaveBeenCalled();

    fireEvent.change(screen.getByLabelText("Choose a task"), { target: { value: "42" } });
    expect(await screen.findByText("Fix login flow")).toBeInTheDocument();
    expect(apiMock.getTask).toHaveBeenCalledWith("42");
    expect(aiServiceMock.taskChatHistory).toHaveBeenCalledWith(42);
  });

  test("uses project-scoped tasks and verifies the selected task belongs to that project", async () => {
    renderDialog({ scope: { entityType: "project", entityId: 10 } });

    expect(await screen.findByLabelText("Choose a task in this project")).toBeInTheDocument();
    expect(apiMock.tasks).toHaveBeenCalledWith(10);
    fireEvent.change(screen.getByLabelText("Choose a task in this project"), { target: { value: "42" } });
    expect(await screen.findByText("Fix login flow")).toBeInTheDocument();

    apiMock.getTask.mockResolvedValueOnce({ data: { ...task, project_id: 11 } });
    fireEvent.change(screen.getByLabelText("Choose a task in this project"), { target: { value: "" } });
    fireEvent.change(screen.getByLabelText("Choose a task in this project"), { target: { value: "42" } });
    expect(await screen.findByRole("alert")).toHaveTextContent("does not belong to this project");
  });

  test("shows API failures and retries task loading", async () => {
    apiMock.getMyTasks.mockRejectedValueOnce(new Error("Connection unavailable"));
    renderDialog();

    expect(await screen.findByRole("alert")).toHaveTextContent("Connection unavailable");
    fireEvent.click(screen.getByRole("button", { name: "Retry" }));

    await waitFor(() => expect(apiMock.getMyTasks).toHaveBeenCalledTimes(2));
    expect(await screen.findByLabelText("Choose a task")).toBeInTheDocument();
  });

  test("closing and reopening only reloads saved task chat; it does not end or delete it", async () => {
    const onClose = vi.fn();
    render(
      <MemoryRouter>
        <ControlledTaskAgentDialog scope={{ entityType: "task", entityId: 42 }} onClosed={onClose} />
      </MemoryRouter>,
    );

    await screen.findByRole("dialog", { name: "Task Assistant" });
    const historyCallsBeforeClose = aiServiceMock.taskChatHistory.mock.calls.length;
    fireEvent.click(screen.getByRole("button", { name: "Close Task Assistant" }));
    expect(onClose).toHaveBeenCalledOnce();
    expect(aiServiceMock.taskChatEnd).not.toHaveBeenCalled();
    expect(screen.queryByRole("dialog", { name: "Task Assistant" })).not.toBeInTheDocument();
    fireEvent.click(screen.getByRole("button", { name: "Reopen task agent" }));
    await screen.findByRole("dialog", { name: "Task Assistant" });
    await waitFor(() => expect(aiServiceMock.taskChatHistory.mock.calls.length).toBeGreaterThan(historyCallsBeforeClose));
    expect(aiServiceMock.taskChatEnd).not.toHaveBeenCalled();
  });
});
