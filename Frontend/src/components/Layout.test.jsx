import { act, fireEvent, render, screen } from "@testing-library/react";
import { MemoryRouter, Route, Routes } from "react-router-dom";
import { beforeEach, describe, expect, test, vi } from "vitest";
import Layout from "./Layout";

vi.mock("../context/AuthContext", () => ({
  useAuth: () => ({
    user: { id: 1, name: "Test User", email: "test@example.test" },
    logout: vi.fn(),
  }),
}));

vi.mock("../context/ThemeContext", () => ({
  useTheme: () => ({ theme: "system", setTheme: vi.fn() }),
}));

vi.mock("./CommandPalette", () => ({ default: () => null }));

vi.mock("./GlobalAIChat", () => ({
  default: ({ open, onClose }) => (open
    ? <section aria-label="Global AI drawer"><button onClick={onClose}>Close AI drawer</button></section>
    : null),
}));

vi.mock("./QuickTaskModal", () => ({
  default: ({ isOpen }) => (isOpen ? <section role="dialog" aria-label="Create task" /> : null),
}));

vi.mock("./TaskAgentDialog", () => ({
  default: ({ open, scope }) => open
    ? <section role="dialog" aria-label="Task Agent">{scope ? `${scope.entityType}:${scope.entityId}` : "Choose a task"}</section>
    : null,
}));

function renderLayout() {
  return render(
    <MemoryRouter initialEntries={["/tasks"]}>
      <Routes>
        <Route element={<Layout />}>
          <Route path="/tasks" element={<div>Tasks page content</div>} />
        </Route>
      </Routes>
    </MemoryRouter>,
  );
}

describe("Layout shared workspace controls", () => {
  beforeEach(() => localStorage.clear());

  test("navbar AI opens the shared drawer without a competing floating launcher", () => {
    renderLayout();
    const navbarAgent = screen.getByRole("button", { name: "Open AI Agent", exact: true });

    expect(navbarAgent).toHaveClass("topbar-ai-agent");
    expect(navbarAgent).toHaveTextContent("AI Agent");
    expect(screen.getAllByRole("button", { name: "Open AI Agent", exact: true })).toHaveLength(1);
    expect(screen.queryByRole("button", { name: "Open AI Agent launcher" })).not.toBeInTheDocument();
    expect(screen.getByText("Tasks page content")).toBeInTheDocument();
    expect(screen.queryByRole("region", { name: "Global AI drawer" })).not.toBeInTheDocument();

    fireEvent.click(navbarAgent);
    expect(screen.getByRole("region", { name: "Global AI drawer" })).toBeInTheDocument();
    expect(screen.getByRole("button", { name: "Open AI Agent", exact: true })).toHaveAttribute("aria-pressed", "true");

    fireEvent.click(screen.getByRole("button", { name: "Close AI drawer" }));
    fireEvent.click(navbarAgent);
    expect(screen.getByRole("region", { name: "Global AI drawer" })).toBeInTheDocument();
  });

  test("search is available from the navbar and dispatches the command palette event", () => {
    renderLayout();
    const openPalette = vi.fn();
    window.addEventListener("devflow:open-command-palette", openPalette);

    fireEvent.click(screen.getByRole("button", { name: "Search workspace" }));
    expect(openPalette).toHaveBeenCalledOnce();
    window.removeEventListener("devflow:open-command-palette", openPalette);
  });

  test("navbar quick task action opens the existing quick task dialog surface", () => {
    renderLayout();
    fireEvent.click(screen.getByRole("button", { name: "Create Task" }));
    expect(screen.getByRole("dialog", { name: "Create task" })).toBeInTheDocument();
  });

  test("Task Agent opens from its contextual event without duplicate dialogs", () => {
    renderLayout();
    act(() => {
      window.dispatchEvent(new CustomEvent("devflow:open-task-agent"));
      window.dispatchEvent(new CustomEvent("devflow:open-task-agent"));
    });

    expect(screen.getAllByRole("dialog", { name: "Task Agent" })).toHaveLength(1);
    expect(screen.getByRole("dialog", { name: "Task Agent" })).toHaveTextContent("Choose a task");

    act(() => {
      window.dispatchEvent(new CustomEvent("devflow:open-task-agent", {
        detail: { entityType: "project", entityId: 10 },
      }));
    });
    expect(screen.getAllByRole("dialog", { name: "Task Agent" })).toHaveLength(1);
    expect(screen.getByRole("dialog", { name: "Task Agent" })).toHaveTextContent("project:10");
  });

  test("Global AI, Task Agent, and task creation do not stack competing overlays", () => {
    renderLayout();
    fireEvent.click(screen.getByRole("button", { name: "Open AI Agent", exact: true }));
    expect(screen.getByRole("region", { name: "Global AI drawer" })).toBeInTheDocument();

    act(() => window.dispatchEvent(new CustomEvent("devflow:open-task-agent")));
    expect(screen.queryByRole("region", { name: "Global AI drawer" })).not.toBeInTheDocument();
    expect(screen.getByRole("dialog", { name: "Task Agent" })).toBeInTheDocument();

    fireEvent.click(screen.getByRole("button", { name: "Create Task" }));
    expect(screen.queryByRole("dialog", { name: "Task Agent" })).not.toBeInTheDocument();
    expect(screen.getByRole("dialog", { name: "Create task" })).toBeInTheDocument();
  });
});
