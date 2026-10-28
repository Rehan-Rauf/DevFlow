import { useEffect, useMemo, useRef, useState } from "react";
import { useNavigate } from "react-router-dom";
import { api } from "../services/api";
import "../styles/command-palette.css";

// Static navigation commands, always available.
const STATIC_COMMANDS = [
  { id: "open-ai", label: "Open AI Agent", hint: "AI", path: null, action: "ai" },
  { id: "nav-dashboard", label: "Go to Dashboard", hint: "Navigation", path: "/dashboard" },
  { id: "nav-organizations", label: "Go to Organizations", hint: "Navigation", path: "/organizations" },
  { id: "nav-projects", label: "Go to Projects", hint: "Navigation", path: "/projects" },
  { id: "nav-tasks", label: "Go to My Tasks", hint: "Navigation", path: "/tasks" },
  { id: "nav-knowledge", label: "Go to Knowledge Search", hint: "Navigation", path: "/knowledge" },
];

export default function CommandPalette({ onOpenAI }) {
  const navigate = useNavigate();
  const [open, setOpen] = useState(false);
  const [query, setQuery] = useState("");
  const [activeIndex, setActiveIndex] = useState(0);
  const [data, setData] = useState({ organizations: [], projects: [], tasks: [] });
  const [loaded, setLoaded] = useState(false);
  const inputRef = useRef(null);

  // Global Cmd+K / Ctrl+K to open, Esc to close.
  useEffect(() => {
    function handleKeyDown(e) {
      const isCombo = (e.metaKey || e.ctrlKey) && e.key.toLowerCase() === "k";

      if (isCombo) {
        e.preventDefault();
        setOpen((o) => !o);
        return;
      }

      if (e.key === "Escape") {
        setOpen(false);
      }
    }

    window.addEventListener("keydown", handleKeyDown);
    return () => window.removeEventListener("keydown", handleKeyDown);
  }, []);

  useEffect(() => {
    const openPalette = () => setOpen(true);
    window.addEventListener("devflow:open-command-palette", openPalette);
    return () => window.removeEventListener("devflow:open-command-palette", openPalette);
  }, []);

  // Load searchable data lazily, once, the first time the palette opens.
  useEffect(() => {
    if (!open || loaded) return;

    let cancelled = false;

    async function load() {
      try {
        const [orgRes, projectRes, taskRes] = await Promise.all([
          api.organizations(),
          api.projects(),
          api.getMyTasks(),
        ]);

        if (!cancelled) {
          setData({
            organizations: orgRes.data || [],
            projects: projectRes.data || [],
            tasks: taskRes.data || [],
          });
          setLoaded(true);
        }
      } catch (e) {
        console.error("Command palette failed to load data:", e);
      }
    }

    load();
    return () => {
      cancelled = true;
    };
  }, [open, loaded]);

  useEffect(() => {
    if (open) {
      setQuery("");
      setActiveIndex(0);
      setTimeout(() => inputRef.current?.focus(), 0);
    }
  }, [open]);

  const results = useMemo(() => {
    const q = query.trim().toLowerCase();

    const commands = STATIC_COMMANDS.map((c) => ({ ...c, type: "command" }));

    const orgs = data.organizations.map((o) => ({
      id: `org-${o.id}`,
      label: o.name,
      hint: "Organization",
      path: `/organizations/${o.id}`,
      type: "organization",
    }));

    const projects = data.projects.map((p) => ({
      id: `project-${p.id}`,
      label: p.name,
      hint: p.organization_name ? `Project · ${p.organization_name}` : "Project",
      path: `/projects/${p.id}`,
      type: "project",
    }));

    const tasks = data.tasks.map((t) => ({
      id: `task-${t.id}`,
      label: t.title,
      hint: t.project_name ? `Task · ${t.project_name}` : "Task",
      path: `/tasks/${t.id}`,
      type: "task",
    }));

    const all = [...commands, ...orgs, ...projects, ...tasks];

    if (!q) return all.slice(0, 8);

    return all.filter((item) => item.label.toLowerCase().includes(q)).slice(0, 20);
  }, [query, data]);

  function go(item) {
    if (!item) return;
    setOpen(false);

    if (item.action === "ai") {
      onOpenAI?.();
      return;
    }

    navigate(item.path);
  }

  function handleKeyDown(e) {
    if (e.key === "ArrowDown") {
      e.preventDefault();
      setActiveIndex((i) => Math.min(i + 1, results.length - 1));
    } else if (e.key === "ArrowUp") {
      e.preventDefault();
      setActiveIndex((i) => Math.max(i - 1, 0));
    } else if (e.key === "Enter") {
      e.preventDefault();
      go(results[activeIndex]);
    }
  }

  if (!open) return null;

  return (
    <div className="cmdk-overlay" onClick={() => setOpen(false)}>
      <div className="cmdk-panel" onClick={(e) => e.stopPropagation()}>
        <input
          ref={inputRef}
          className="cmdk-input"
          placeholder="Search or jump to…"
          value={query}
          onChange={(e) => {
            setQuery(e.target.value);
            setActiveIndex(0);
          }}
          onKeyDown={handleKeyDown}
        />

        <div className="cmdk-results">
          {results.length === 0 && <div className="cmdk-empty">No matches.</div>}

          {results.map((item, i) => (
            <button
              key={item.id}
              type="button"
              className={`cmdk-row ${i === activeIndex ? "cmdk-row-active" : ""}`}
              onMouseEnter={() => setActiveIndex(i)}
              onClick={() => go(item)}
            >
              <span className="cmdk-row-label">{item.label}</span>
              <span className="cmdk-row-hint">{item.hint}</span>
            </button>
          ))}
        </div>

        <div className="cmdk-footer">
          <span>↑↓ navigate</span>
          <span>↵ open</span>
          <span>esc close</span>
        </div>
      </div>
    </div>
  );
}
