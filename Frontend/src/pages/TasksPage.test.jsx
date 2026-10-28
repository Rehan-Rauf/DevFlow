import React from "react";
import { render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { beforeEach, describe, expect, test, vi } from "vitest";

import TasksPage from "./TasksPage";
import { api } from "../services/api";

vi.mock("../services/api", () => ({
  api: {
    getMyTasks: vi.fn(),
    organizations: vi.fn(),
    projectStatuses: vi.fn(),
    createTask: vi.fn(),
    updateTask: vi.fn(),
    deleteTask: vi.fn(),
    analyzeTask: vi.fn(),
    projects: vi.fn(),
    members: vi.fn(),
    projectMembers: vi.fn(),
  },
}));

vi.mock("../components/ui/SelectField", () => ({
  default: ({ value, onChange, options = [], placeholder = "Select an option", disabled = false, "aria-label": ariaLabel }) => (
    <select
      aria-label={ariaLabel || placeholder}
      value={value}
      onChange={onChange}
      disabled={disabled}
    >
      <option value="">{placeholder}</option>
      {options.map((option) => (
        <option key={String(option.value)} value={String(option.value)}>
          {option.label}
        </option>
      ))}
    </select>
  ),
}));

vi.mock("socket.io-client", () => ({
  io: () => ({
    on: vi.fn(),
    disconnect: vi.fn(),
  }),
}));

vi.mock("../context/AuthContext", () => ({
  useAuth: () => ({ user: { id: 1, name: "Alice" } }),
}));

describe("TasksPage", () => {
  beforeEach(() => {
    localStorage.clear();
    vi.clearAllMocks();
  });

  test("loads tasks and shows the tasks page", async () => {
    api.getMyTasks.mockResolvedValue({ data: [] });
    api.organizations.mockResolvedValue({ data: [] });

    render(<TasksPage />);

    await waitFor(() => expect(api.getMyTasks).toHaveBeenCalled());
    expect(screen.getByRole("heading", { name: /tasks/i })).toBeTruthy();
  });

  test("allows creating a task with a valid payload", async () => {
    api.getMyTasks.mockResolvedValue({ data: [] });
    api.organizations.mockResolvedValue({ data: [{ id: 5, name: "Acme", my_role: "owner" }] });
    api.projects.mockResolvedValue({ data: [{ id: 10, name: "Platform" }] });
    api.members.mockResolvedValue({ data: [{ id: 2, name: "Bob" }] });
    api.analyzeTask.mockResolvedValue({
      data: {
        title: "Ship release",
        description: "Ship the release candidate with QA validation.",
        priority: "high",
        status: "todo",
        valid: true,
      },
    });
    api.createTask.mockResolvedValue({ data: { id: 99, title: "Ship release" } });

    render(<TasksPage />);

    await waitFor(() => expect(api.organizations).toHaveBeenCalled());
    const user = userEvent.setup();

    await user.click(screen.getByRole("button", { name: /create with ai/i }));
    const orgSelect = screen.getByLabelText(/^Organization$/i);
    await user.selectOptions(orgSelect, "5");
    await waitFor(() => expect(api.projects).toHaveBeenCalledWith("5"));

    const projectSelect = screen.getByLabelText(/^Project$/i);
    await user.selectOptions(projectSelect, "10");

    const prompt = screen.getByRole("textbox");
    await user.type(prompt, "Ship release with QA validation.");
    await user.click(screen.getByRole("button", { name: /analyze with ai/i }));

    await waitFor(() => expect(api.analyzeTask).toHaveBeenCalled());
    await waitFor(() => expect(screen.getByText(/review your task/i)).toBeTruthy());

    await user.click(screen.getByRole("button", { name: /create task/i }));
    await waitFor(() => expect(api.createTask).toHaveBeenCalled());
  });
});
