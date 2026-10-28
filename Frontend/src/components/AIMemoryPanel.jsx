import { useEffect, useState } from "react";
import Modal from "./ui/Modal";
import Button from "./ui/Button";
import ConfirmDialog from "./ui/ConfirmDialog";
import { api } from "../services/api";

const TYPES = ["preference", "decision", "requirement", "constraint", "context", "plan", "fact"];
const emptyForm = { type: "context", content: "", importance: 5 };

export default function AIMemoryPanel({ isOpen, onClose, scope = {}, title = "AI Memory" }) {
  const [memories, setMemories] = useState([]);
  const [filter, setFilter] = useState("");
  const [form, setForm] = useState(emptyForm);
  const [editing, setEditing] = useState(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");
  const [confirm, setConfirm] = useState(null);
  const [confirmClear, setConfirmClear] = useState(false);

  async function load() {
    setError("");
    try {
      const response = await api.memories({ ...scope, ...(filter ? { type: filter } : {}) });
      setMemories(response.data || []);
    } catch (requestError) {
      setError(requestError.message || "Unable to load memories.");
    }
  }

  useEffect(() => {
    if (isOpen) load();
  }, [isOpen, filter, scope.taskId, scope.projectId, scope.organizationId]);

  function startEdit(memory = null) {
    setEditing(memory);
    setForm(memory ? { type: memory.type, content: memory.content, importance: memory.importance } : emptyForm);
    setError("");
  }

  async function save(event) {
    event.preventDefault();
    if (!form.content.trim()) return;
    setBusy(true);
    try {
      const response = editing
        ? await api.updateMemory(editing.id, form)
        : await api.createMemory({ ...form, ...scope });
      setMemories((current) => editing
        ? current.map((memory) => memory.id === editing.id ? response.data : memory)
        : [response.data, ...current]);
      setEditing(null);
      setForm(emptyForm);
    } catch (requestError) {
      setError(requestError.message || "Unable to save memory.");
    } finally {
      setBusy(false);
    }
  }

  async function remove() {
    setBusy(true);
    try {
      await api.deleteMemory(confirm.id);
      setMemories((current) => current.filter((memory) => memory.id !== confirm.id));
      setConfirm(null);
    } catch (requestError) {
      setError(requestError.message || "Unable to forget memory.");
    } finally {
      setBusy(false);
    }
  }

  async function clearAll() {
    setBusy(true);
    setError("");
    try {
      await api.clearMemories();
      setMemories([]);
      setConfirmClear(false);
    } catch (requestError) {
      setError(requestError.message || "Unable to clear saved memories.");
    } finally {
      setBusy(false);
    }
  }

  return (
    <>
      <Modal isOpen={isOpen} onClose={onClose} title={title} closeDisabled={busy} className="ai-memory-modal">
        <div className="ai-memory-toolbar">
          <select value={filter} onChange={(event) => setFilter(event.target.value)} aria-label="Filter memories">
            <option value="">All</option>
            {TYPES.map((type) => <option key={type} value={type}>{type[0].toUpperCase() + type.slice(1)}s</option>)}
          </select>
          {memories.length > 0 && (
            <Button variant="danger" onClick={() => setConfirmClear(true)} disabled={busy}>
              Clear all memories
            </Button>
          )}
          <Button onClick={() => startEdit()}>+ Add Memory</Button>
        </div>
        {error && <div className="ai-error" role="alert">{error}</div>}
        {editing && (
          <form className="ai-memory-form" onSubmit={save}>
            <select value={form.type} onChange={(event) => setForm({ ...form, type: event.target.value })}>
              {TYPES.map((type) => <option key={type} value={type}>{type}</option>)}
            </select>
            <textarea value={form.content} onChange={(event) => setForm({ ...form, content: event.target.value })} placeholder="What should AI remember?" rows={3} />
            <label>Importance: {form.importance}
              <input type="range" min="1" max="10" value={form.importance} onChange={(event) => setForm({ ...form, importance: Number(event.target.value) })} />
            </label>
            <div className="ai-memory-form__actions">
              <Button type="button" variant="secondary" onClick={() => setEditing(null)}>Cancel</Button>
              <Button type="submit" loading={busy}>Save</Button>
            </div>
          </form>
        )}
        {!memories.length && !editing ? <p className="ai-empty-state">No memories yet. Add a memory or ask the AI to remember something important.</p> : (
          <div className="ai-memory-list">
            {memories.map((memory) => (
              <article className="ai-memory-item" key={memory.id}>
                <div><span className="ai-memory-type">{memory.type}</span><span className="ai-memory-importance">{"★".repeat(Math.min(5, Math.ceil(memory.importance / 2)))}</span></div>
                <p>{memory.content}</p>
                <div className="ai-memory-item__actions">
                  <button type="button" onClick={() => startEdit(memory)}>Edit</button>
                  <button type="button" onClick={() => setConfirm(memory)}>Forget</button>
                </div>
              </article>
            ))}
          </div>
        )}
      </Modal>
      <ConfirmDialog isOpen={Boolean(confirm)} onClose={() => !busy && setConfirm(null)} onConfirm={remove} busy={busy} title="Forget memory" description="Permanently remove this memory from AI retrieval?" confirmLabel="Forget memory" />
      <ConfirmDialog
        isOpen={confirmClear}
        onClose={() => !busy && setConfirmClear(false)}
        onConfirm={clearAll}
        busy={busy}
        title="Clear saved AI memory"
        description="Permanently delete all of your saved AI memories? Conversation history will not be deleted."
        confirmLabel="Clear all memories"
      />
    </>
  );
}
