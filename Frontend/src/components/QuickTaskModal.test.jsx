import { fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import { beforeEach, describe, expect, test, vi } from "vitest";
import { api } from "../services/api";
import QuickTaskModal from "./QuickTaskModal";

vi.mock("../services/api", () => ({
  api: {
    organizations: vi.fn(),
    getOrganization: vi.fn(),
    getProject: vi.fn(),
    getTask: vi.fn(),
    projects: vi.fn(),
    projectStatuses: vi.fn(),
    createTask: vi.fn(),
  },
}));

const organizations = [{ id: 7, name: "Northwind" }];
const projects = [{ id: 21, name: "Payments" }];

describe("QuickTaskModal", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    api.organizations.mockResolvedValue({ data: organizations });
    api.projects.mockResolvedValue({ data: projects });
    api.projectStatuses.mockResolvedValue({ data: [{ key: "todo", label: "To do" }] });
    api.getProject.mockResolvedValue({ data: { id: 21, organization_id: 7 } });
    api.createTask.mockResolvedValue({ data: { id: 92, title: "Review release" } });
  });

  test("preselects the project context and creates a persisted task in that project", async () => {
    const onSuccess = vi.fn();
    render(<QuickTaskModal isOpen context={{ entityType: "project", entityId: 21 }} onClose={vi.fn()} onSuccess={onSuccess} />);

    fireEvent.change(await screen.findByLabelText("Task title"), { target: { value: "Review release" } });
    expect(screen.getByRole("button", { name: "Organization" })).toHaveTextContent("Northwind");
    expect(screen.getByRole("button", { name: "Project" })).toHaveTextContent("Payments");

    await waitFor(() => expect(screen.getByRole("button", { name: "Create task" })).toBeEnabled());
    fireEvent.click(screen.getByRole("button", { name: "Create task" }));
    await waitFor(() => expect(api.createTask).toHaveBeenCalledWith({
      title: "Review release",
      description: "",
      priority: "medium",
      status: "todo",
      organizationId: 7,
      projectId: 21,
    }));
    expect(onSuccess).toHaveBeenCalledWith(expect.objectContaining({ id: 92, title: "Review release" }));
  });

  test("home context lets the user select an authorized organization and project", async () => {
    const onSuccess = vi.fn();
    render(<QuickTaskModal isOpen context={null} onClose={vi.fn()} onSuccess={onSuccess} />);

    await screen.findByRole("button", { name: "Organization" });
    fireEvent.click(screen.getByRole("button", { name: "Organization" }));
    fireEvent.click(within(screen.getByRole("listbox", { name: "Organization" })).getByRole("option", { name: "Northwind" }));
    await waitFor(() => expect(api.projects).toHaveBeenCalledWith("7"));
    fireEvent.click(screen.getByRole("button", { name: "Project" }));
    fireEvent.click(within(screen.getByRole("listbox", { name: "Project" })).getByRole("option", { name: "Payments" }));
    fireEvent.change(screen.getByLabelText("Task title"), { target: { value: "Prepare deploy" } });
    await waitFor(() => expect(screen.getByRole("button", { name: "Create task" })).toBeEnabled());
    fireEvent.click(screen.getByRole("button", { name: "Create task" }));

    await waitFor(() => expect(onSuccess).toHaveBeenCalledOnce());
    expect(api.createTask).toHaveBeenCalledWith(expect.objectContaining({ organizationId: 7, projectId: 21 }));
  });

  test("failed API creation stays in the dialog and never reports success", async () => {
    const onSuccess = vi.fn();
    api.createTask.mockRejectedValue(new Error("Permission denied"));
    render(<QuickTaskModal isOpen context={{ entityType: "project", entityId: 21 }} onClose={vi.fn()} onSuccess={onSuccess} />);
    fireEvent.change(await screen.findByLabelText("Task title"), { target: { value: "Review release" } });
    await waitFor(() => expect(screen.getByRole("button", { name: "Create task" })).toBeEnabled());
    fireEvent.click(screen.getByRole("button", { name: "Create task" }));

    expect(await screen.findByRole("alert")).toHaveTextContent("Permission denied");
    expect(onSuccess).not.toHaveBeenCalled();
    expect(screen.getByRole("dialog", { name: "Create task" })).toBeInTheDocument();
  });
});
