import { useEffect, useState } from "react";
import { NavLink, Outlet, useLocation, useNavigate } from "react-router-dom";
import { io } from "socket.io-client";
import { useAuth } from "../context/AuthContext";
import { useTheme } from "../context/ThemeContext";
import SelectField from "./ui/SelectField";
import CommandPalette from "./CommandPalette";
import GlobalAIChat from "./GlobalAIChat";
import QuickTaskModal from "./QuickTaskModal";
import TaskAgentDialog from "./TaskAgentDialog";
import "../styles/layout.css";

// Adding a new top-level area now only requires one entry here.
const NAVIGATION = [
  { to: "/overview", label: "Overview", icon: "⌂" },
  { to: "/organizations", label: "Organizations", icon: "◉" },
  { to: "/projects", label: "Projects", icon: "◫" },
  { to: "/tasks", label: "Tasks", icon: "✓" },
  { to: "/knowledge", label: "Knowledge base", icon: "⌕" },
];

function getPageTitle(pathname) {
  if (pathname.startsWith("/overview")) return "Overview";
  if (pathname.startsWith("/organizations")) return "Organizations";
  if (pathname.startsWith("/projects")) return "Projects";
  if (pathname.startsWith("/tasks")) return "Tasks";
  if (pathname.startsWith("/knowledge")) return "Knowledge";
  if (pathname.startsWith("/profile")) return "Profile";
  return "Workspace";
}

function getAIContext(pathname) {
  const match = pathname.match(/^\/(organizations|projects|tasks)\/(\d+)$/);
  if (!match) return null;
  return { entityType: match[1].slice(0, -1), entityId: Number(match[2]) };
}

/** Application shell: navigation, live notices, and the global AI assistant. */
export default function Layout() {
  const { user, logout } = useAuth();
  const { theme, setTheme } = useTheme();
  const location = useLocation();
  const navigate = useNavigate();
  const [isMobileMenuOpen, setIsMobileMenuOpen] = useState(false);
  const [isAiOpen, setIsAiOpen] = useState(false);
  const [isTaskAgentOpen, setIsTaskAgentOpen] = useState(false);
  const [taskAgentScope, setTaskAgentScope] = useState(null);
  const [isQuickTaskOpen, setIsQuickTaskOpen] = useState(false);
  const [toasts, setToasts] = useState([]);

  const pageTitle = getPageTitle(location.pathname);
  const aiContext = getAIContext(location.pathname);

  function openGlobalAI() {
    setIsTaskAgentOpen(false);
    setIsQuickTaskOpen(false);
    setIsAiOpen(true);
  }

  function openTaskAgent(scope = aiContext) {
    setIsAiOpen(false);
    setIsQuickTaskOpen(false);
    setTaskAgentScope(scope);
    setIsTaskAgentOpen(true);
  }

  function openQuickTask() {
    setIsAiOpen(false);
    setIsTaskAgentOpen(false);
    setIsQuickTaskOpen(true);
  }

  function openSearch() {
    window.dispatchEvent(new Event("devflow:open-command-palette"));
  }

  function handleAgentTaskDeleted() {
    setIsTaskAgentOpen(false);
    navigate("/tasks");
  }

  useEffect(() => {
    const openTaskAgentFromPage = (event) => {
      openTaskAgent(event.detail || aiContext);
    };

    window.addEventListener("devflow:open-task-agent", openTaskAgentFromPage);
    return () => window.removeEventListener("devflow:open-task-agent", openTaskAgentFromPage);
  }, [location.pathname]);

  useEffect(() => {
    // Tablet/desktop par menu dobara band ho jata hai taake layout stable rahe.
    const closeMenuOnDesktop = () => {
      if (window.innerWidth > 900) setIsMobileMenuOpen(false);
    };

    window.addEventListener("resize", closeMenuOnDesktop);
    return () => window.removeEventListener("resize", closeMenuOnDesktop);
  }, []);

  useEffect(() => {
    // Escape se chhota-screen navigation asani se close ho sakta hai.
    const closeMenuWithEscape = (event) => {
      if (event.key === "Escape") setIsMobileMenuOpen(false);
    };

    window.addEventListener("keydown", closeMenuWithEscape);
    return () => window.removeEventListener("keydown", closeMenuWithEscape);
  }, []);

  async function handleLogout() {
    await logout();
    setIsMobileMenuOpen(false);
    navigate("/login", { replace: true });
  }

  useEffect(() => {
    const token = localStorage.getItem("cms_token");
    if (!token) return undefined;

    const socket = io(import.meta.env.VITE_SOCKET_URL || "http://localhost:5001", {
      auth: { token },
    });

    // Notifications belonging to other users are ignored before they reach UI state.
    socket.on("notification", (notification) => {
      if (notification.userId && Number(notification.userId) !== Number(user?.id)) return;

      const id = `${Date.now()}-${Math.random()}`;
      setToasts((current) => [...current, { ...notification, id }]);
      window.setTimeout(() => {
        setToasts((current) => current.filter((toast) => toast.id !== id));
      }, 4500);
    });

    return () => socket.disconnect();
  }, [user?.id]);

  return (
    <div className={`app-shell${isAiOpen ? " app-shell--ai-open" : ""}`}>
      {isMobileMenuOpen && (
        <button className="mobile-scrim" onClick={() => setIsMobileMenuOpen(false)} aria-label="Close navigation menu" />
      )}

      <aside className={`sidebar ${isMobileMenuOpen ? "open" : ""}`}>
        <div className="brand">
          <div className="brand-mark">
            <img src="/devflow-logo.svg" alt="DevFlow" />
          </div>
          <div><strong>DevFlow</strong><span>Workspace</span></div>
        </div>

        <div className="workspace-pill"><span className="dot" />Team workspace</div>

        <nav className="nav" aria-label="Workspace navigation">
          <p className="nav-section-label">Workspace</p>
          {NAVIGATION.map((item) => (
            <NavLink key={item.to} to={item.to} onClick={() => setIsMobileMenuOpen(false)}>
              <span aria-hidden="true">{item.icon}</span>
              <span>{item.label}</span>
            </NavLink>
          ))}
        </nav>

        <div className="sidebar-footer">
          <NavLink className="sidebar-profile-link" to="/profile" onClick={() => setIsMobileMenuOpen(false)}>
            <div className="avatar">{user?.name?.[0]?.toUpperCase() || "U"}</div>
            <div><strong>{user?.name || "User"}</strong><span>Profile and account</span></div>
            <span className="sidebar-profile-chevron" aria-hidden="true">›</span>
          </NavLink>
          <label className="theme-select">
            <span>Theme</span>
            <SelectField
              value={theme}
              onChange={(event) => setTheme(event.target.value)}
              aria-label="Theme preference"
              options={[
                { value: "light", label: "Light" },
                { value: "dark", label: "Dark" },
                { value: "system", label: "System" },
              ]}
            />
          </label>
          <button className="ghost-button" type="button" onClick={handleLogout}>Log out</button>
        </div>
      </aside>

      <main className="main-content">
        <header className="topbar">
          <button
            className="menu-btn"
            onClick={() => setIsMobileMenuOpen(true)}
            aria-label="Open navigation menu"
            aria-expanded={isMobileMenuOpen}
          >
            ☰
          </button>
          <div className="topbar-title">{pageTitle}</div>
          <div className="topbar-actions">
            <button
              type="button"
              className="topbar-search"
              onClick={openSearch}
              aria-label="Search workspace"
              title="Search workspace (Ctrl+K)"
            >
              <span aria-hidden="true">⌕</span>
              <span>Search</span>
              <kbd>Ctrl K</kbd>
            </button>
            <button
              type="button"
              className={`topbar-create-task${isQuickTaskOpen ? " is-active" : ""}`}
              onClick={openQuickTask}
              aria-label="Create Task"
              title="Create Task"
            >
              <span aria-hidden="true">+</span>
              <span>Create Task</span>
            </button>
            <button
              type="button"
              className={`topbar-ai-agent${isAiOpen ? " is-active" : ""}`}
              onClick={openGlobalAI}
              aria-label="Open AI Agent"
              aria-pressed={isAiOpen}
              title="Open AI Agent"
            >
              <span aria-hidden="true">✦</span>
              <span>AI Agent</span>
            </button>
            <NavLink className="topbar-user" to="/profile" aria-label={`Open profile for ${user?.name || "user"}`}>
              <span className="avatar">{user?.name?.[0]?.toUpperCase() || "U"}</span>
            </NavLink>
          </div>
        </header>

        <Outlet />
      </main>

      <CommandPalette onOpenAI={openGlobalAI} />

      <GlobalAIChat
        open={isAiOpen}
        sessionId={null}
        context={aiContext}
        onClose={() => setIsAiOpen(false)}
        onMinimize={() => setIsAiOpen(false)}
      />
      <TaskAgentDialog
        open={isTaskAgentOpen}
        scope={taskAgentScope}
        onClose={() => setIsTaskAgentOpen(false)}
        onTaskDeleted={handleAgentTaskDeleted}
      />
      <QuickTaskModal
        isOpen={isQuickTaskOpen}
        context={aiContext}
        onClose={() => setIsQuickTaskOpen(false)}
        onSuccess={(task) => {
          setIsQuickTaskOpen(false);
          const id = `${Date.now()}-${Math.random()}`;
          setToasts((current) => [...current, {
            id,
            title: "Task created",
            message: `"${task.title}" was added to the selected project.`,
          }]);
          window.setTimeout(() => {
            setToasts((current) => current.filter((toast) => toast.id !== id));
          }, 4500);
        }}
      />

      <div className="toast-stack" aria-live="polite">
        {toasts.map((toast) => (
          <div className="toast" key={toast.id}>
            <b>{toast.title || "Notification"}</b>
            <span>{toast.message}</span>
          </div>
        ))}
      </div>
    </div>
  );
}
