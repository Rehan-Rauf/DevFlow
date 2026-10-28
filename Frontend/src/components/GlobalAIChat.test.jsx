import { fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import { MemoryRouter } from "react-router-dom";
import { beforeEach, describe, expect, test, vi } from "vitest";
import { api } from "../services/api";
import GlobalAIChat from "./GlobalAIChat";

vi.mock("../services/api", () => ({
  api: {
    globalChatHistory: vi.fn(),
    chatSessionHistory: vi.fn(),
    recentChats: vi.fn(),
    deleteChatSession: vi.fn(),
    globalChat: vi.fn(),
    globalActionProposals: vi.fn(),
    approveGlobalAction: vi.fn(),
    cancelGlobalAction: vi.fn(),
    globalChatEnd: vi.fn(),
    closeAllChats: vi.fn(),
    memories: vi.fn(),
    createMemory: vi.fn(),
    updateMemory: vi.fn(),
    deleteMemory: vi.fn(),
    clearMemories: vi.fn(),
    getTask: vi.fn(),
    getProject: vi.fn(),
    getOrganization: vi.fn(),
  },
}));

describe("GlobalAIChat", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    api.globalChatHistory.mockResolvedValue({ data: { messages: [] } });
    api.globalActionProposals.mockResolvedValue({ data: { proposals: [] } });
    api.chatSessionHistory.mockResolvedValue({
      data: {
        session: { id: 31, chatType: "GLOBAL", status: "ENDED" },
        messages: [{ id: 4, role: "assistant", content: "Saved answer." }],
      },
    });
    api.recentChats.mockResolvedValue({
      data: {
        chats: [
          { id: 31, chat_type: "GLOBAL", status: "ENDED", title: "Release plan" },
          { id: 32, chat_type: "TASK", status: "ENDED", title: "Task conversation" },
        ],
      },
    });
    api.deleteChatSession.mockResolvedValue({ data: { conversationDeleted: true, memoriesDeleted: false } });
    api.closeAllChats.mockResolvedValue({ data: { ended: 2 } });
    api.memories.mockResolvedValue({ data: [] });
    api.getProject.mockResolvedValue({ data: { id: 17, name: "Payments", organization_name: "Northwind" } });
  });

  test("shows its current context and closes all sessions without deleting memory", async () => {
    const onClose = vi.fn();
    const closeAllEvent = vi.fn();
    window.addEventListener("devflow:close-all-ai-chats", closeAllEvent);

    render(
      <MemoryRouter>
        <GlobalAIChat
          open
          onClose={onClose}
          context={{ entityType: "project", entityId: 17 }}
        />
      </MemoryRouter>,
    );

    expect(screen.getByRole("region", { name: "DevFlow AI chat" })).toBeInTheDocument();
    expect(screen.getByRole("heading", { name: "DevFlow AI" })).toBeInTheDocument();
    expect(await screen.findAllByText("Northwind → Payments")).toHaveLength(2);
    fireEvent.click(screen.getByRole("button", { name: "Conversation actions" }));
    fireEvent.click(screen.getByRole("button", { name: "Close all chats" }));
    const dialog = await screen.findByRole("dialog", { name: "Close all AI chats" });
    expect(await screen.findByRole("heading", { name: "Close all AI chats" })).toBeInTheDocument();
    expect(screen.getByText(/Saved conversation history and AI memories will be preserved/)).toBeInTheDocument();
    fireEvent.click(within(dialog).getByRole("button", { name: "Close all chats" }));

    await waitFor(() => expect(api.closeAllChats).toHaveBeenCalledOnce());
    expect(closeAllEvent).toHaveBeenCalledOnce();
    expect(onClose).toHaveBeenCalledOnce();
    window.removeEventListener("devflow:close-all-ai-chats", closeAllEvent);
  });

  test("lists, opens, and closes saved Global AI conversation history", async () => {
    render(
      <MemoryRouter>
        <GlobalAIChat open onClose={vi.fn()} />
      </MemoryRouter>,
    );

    fireEvent.click(screen.getByRole("button", { name: "Conversation actions" }));
    fireEvent.click(screen.getByRole("button", { name: "History" }));
    expect(await screen.findByRole("button", { name: "Release plan Ended" })).toBeInTheDocument();
    expect(screen.queryByText("Task conversation")).not.toBeInTheDocument();
    fireEvent.click(screen.getByRole("button", { name: "Release plan Ended" }));

    expect(await screen.findByText("Saved answer.")).toBeInTheDocument();
    expect(api.chatSessionHistory).toHaveBeenCalledWith(31);
    expect(screen.getByRole("textbox")).toBeDisabled();
    fireEvent.click(screen.getByRole("button", { name: "Conversation actions" }));
    fireEvent.click(screen.getByRole("button", { name: "Close history" }));
    await waitFor(() => expect(api.globalChatHistory).toHaveBeenCalledTimes(2));
  });

  test("deletes only the selected conversation after confirmation", async () => {
    render(
      <MemoryRouter>
        <GlobalAIChat open onClose={vi.fn()} />
      </MemoryRouter>,
    );

    fireEvent.click(screen.getByRole("button", { name: "Conversation actions" }));
    fireEvent.click(screen.getByRole("button", { name: "History" }));
    const deleteButton = await screen.findByRole("button", { name: "Delete Release plan" });
    fireEvent.click(deleteButton);
    const dialog = await screen.findByRole("dialog", { name: "Delete conversation" });
    expect(within(dialog).getByText(/Saved AI memory is stored separately/)).toBeInTheDocument();
    fireEvent.click(within(dialog).getByRole("button", { name: "Delete conversation" }));

    await waitFor(() => expect(api.deleteChatSession).toHaveBeenCalledWith(31));
    expect(screen.queryByRole("button", { name: "Release plan" })).not.toBeInTheDocument();
    expect(screen.getByText("No saved Global AI conversations.")).toBeInTheDocument();
  });

  test("keeps History and Memory available from the compact actions menu", async () => {
    render(
      <MemoryRouter>
        <GlobalAIChat open onClose={vi.fn()} />
      </MemoryRouter>,
    );
    fireEvent.click(screen.getByRole("button", { name: "Conversation actions" }));
    fireEvent.click(screen.getByRole("button", { name: "Memory" }));
    expect(await screen.findByRole("dialog", { name: "AI Memory" })).toBeInTheDocument();
    expect(api.memories).toHaveBeenCalled();
  });

  test("presents consequential changes for approval and reports only the server-confirmed result", async () => {
    const proposal = {
      id: "f9a67656-a6a3-4c9c-8bf0-725ca7bf8bc3",
      operation: "create_task",
      summary: 'Create task "Prepare release" in Payments.',
      status: "proposed",
      expiresAt: "2026-10-12T12:00:00.000Z",
      target: { organizationName: "Northwind", projectName: "Payments" },
      changes: { after: { title: "Prepare release", priority: "high" } },
    };
    api.globalChat.mockResolvedValue({
      data: {
        answer: "I prepared this change for review. Nothing has been changed yet.",
        actionProposals: [proposal],
        actionResults: [],
      },
    });
    api.approveGlobalAction.mockResolvedValue({
      data: {
        replayed: false,
        proposal: { ...proposal, status: "succeeded" },
        result: {
          success: true,
          resourceType: "task",
          resource: { id: 91, title: "Prepare release" },
        },
      },
    });

    render(
      <MemoryRouter>
        <GlobalAIChat open onClose={vi.fn()} context={{ entityType: "project", entityId: 17 }} />
      </MemoryRouter>,
    );

    fireEvent.change(await screen.findByRole("textbox"), { target: { value: "Create a task for preparing the release" } });
    fireEvent.click(screen.getByRole("button", { name: "Send" }));

    const card = await screen.findByRole("article", { name: "AI action proposal" });
    expect(within(card).getByText("Awaiting approval")).toBeInTheDocument();
    expect(within(card).getByText(/Northwind → Payments/)).toBeInTheDocument();
    expect(within(card).getByText('Create task "Prepare release" in Payments.')).toBeInTheDocument();
    expect(within(card).getByRole("button", { name: "Approve" })).toBeEnabled();

    fireEvent.click(within(card).getByRole("button", { name: "Approve" }));
    await waitFor(() => expect(api.approveGlobalAction).toHaveBeenCalledWith(proposal.id));
    expect(await screen.findByText("Succeeded")).toBeInTheDocument();
    expect(await screen.findByText("The approved action was saved successfully.")).toBeInTheDocument();
    expect(screen.getByRole("link", { name: "Prepare release" })).toHaveAttribute("href", "/tasks/91");
  });

  test("cancels a proposal without approving or creating its action", async () => {
    const proposal = {
      id: "f9a67656-a6a3-4c9c-8bf0-725ca7bf8bc3",
      summary: 'Create task "Prepare release" in Payments.',
      status: "proposed",
      expiresAt: "2026-10-12T12:00:00.000Z",
      target: { organizationName: "Northwind", projectName: "Payments" },
      changes: { after: { title: "Prepare release" } },
    };
    api.globalChat.mockResolvedValue({
      data: { answer: "Nothing has been changed yet.", actionProposals: [proposal] },
    });
    api.cancelGlobalAction.mockResolvedValue({
      data: { proposal: { ...proposal, status: "cancelled" } },
    });

    render(
      <MemoryRouter>
        <GlobalAIChat open onClose={vi.fn()} context={{ entityType: "project", entityId: 17 }} />
      </MemoryRouter>,
    );

    fireEvent.change(await screen.findByRole("textbox"), { target: { value: "Create a task for release" } });
    fireEvent.click(screen.getByRole("button", { name: "Send" }));
    const card = await screen.findByRole("article", { name: "AI action proposal" });
    fireEvent.click(within(card).getByRole("button", { name: "Cancel" }));

    await waitFor(() => expect(api.cancelGlobalAction).toHaveBeenCalledWith(proposal.id));
    expect(within(card).getByText("Cancelled")).toBeInTheDocument();
    expect(api.approveGlobalAction).not.toHaveBeenCalled();
  });

  test("keeps pending proposals discoverable when the panel is reopened", async () => {
    const proposal = {
      id: "5e1cf6b0-3b04-46a7-a7d8-c9223cc3e7f4",
      summary: 'Create project "Roadmap" in Northwind.',
      status: "proposed",
      expiresAt: "2026-10-12T12:00:00.000Z",
      target: { organizationName: "Northwind" },
      changes: { after: { name: "Roadmap" } },
    };
    api.globalActionProposals.mockResolvedValue({ data: { proposals: [proposal] } });
    const { rerender } = render(
      <MemoryRouter>
        <GlobalAIChat open onClose={vi.fn()} />
      </MemoryRouter>,
    );

    expect(await screen.findByRole("article", { name: "AI action proposal" })).toBeInTheDocument();
    rerender(
      <MemoryRouter>
        <GlobalAIChat open={false} onClose={vi.fn()} />
      </MemoryRouter>,
    );
    rerender(
      <MemoryRouter>
        <GlobalAIChat open onClose={vi.fn()} />
      </MemoryRouter>,
    );
    expect(await screen.findByText("Awaiting approval")).toBeInTheDocument();
  });

  test("renders assistant Markdown safely with headings, lists, code, and tables", async () => {
    api.globalChat.mockResolvedValue({
      data: {
        answer: [
          "## Project status",
          "",
          "Use `release-check` before shipping.",
          "",
          "- Verify tests",
          "- Review blockers",
          "",
          "| Area | Status |",
          "| --- | --- |",
          "| API | Ready |",
          "",
          "<img src=x onerror=alert(1)>",
        ].join("\n"),
        actionProposals: [],
      },
    });
    render(
      <MemoryRouter>
        <GlobalAIChat open onClose={vi.fn()} />
      </MemoryRouter>,
    );

    fireEvent.change(await screen.findByRole("textbox"), { target: { value: "Summarize the project" } });
    fireEvent.click(screen.getByRole("button", { name: "Send" }));

    const conversation = screen.getByRole("region", { name: "DevFlow AI chat" });
    expect(await within(conversation).findByRole("heading", { name: "Project status" })).toBeInTheDocument();
    expect(within(conversation).getByText("release-check")).toBeInTheDocument();
    expect(within(conversation).getByRole("list")).toBeInTheDocument();
    expect(within(conversation).getByRole("table")).toBeInTheDocument();
    expect(within(conversation).queryByRole("img")).not.toBeInTheDocument();
  });

  test("keeps the context-aware composer footer visible and supports Enter versus Shift+Enter", async () => {
    api.globalChat.mockResolvedValue({ data: { answer: "Ready.", actionProposals: [] } });
    render(
      <MemoryRouter>
        <GlobalAIChat open onClose={vi.fn()} context={{ entityType: "project", entityId: 17 }} />
      </MemoryRouter>,
    );
    const composer = screen.getByRole("form");
    const textbox = await screen.findByRole("textbox", { name: "Message DevFlow AI" });
    expect(await screen.findAllByText("Northwind → Payments")).toHaveLength(2);
    expect(composer).toHaveClass("ai-input-row");
    expect(within(composer).getByText("Enter to send · Shift+Enter for new line")).toBeInTheDocument();

    fireEvent.change(textbox, { target: { value: "First line" } });
    fireEvent.keyDown(textbox, { key: "Enter", shiftKey: true });
    expect(api.globalChat).not.toHaveBeenCalled();
    expect(textbox).toHaveValue("First line");

    fireEvent.keyDown(textbox, { key: "Enter" });
    await waitFor(() => expect(api.globalChat).toHaveBeenCalledWith("First line", { entityType: "project", entityId: 17 }, expect.any(String)));
  });
});
