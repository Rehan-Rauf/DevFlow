# DevFlow Architecture

## Verified technology choices

- Frontend: React 18, React Router 7, Vite 6, plain CSS.
- Backend: Node.js, Express 4, Socket.IO 4.
- Persistence: PostgreSQL through parameterized `pg` queries; no ORM.
- Authentication: JWT bearer tokens, bcrypt password hashes, persisted token
  revocation, password-reset token records.
- AI: OpenRouter chat/completions and embeddings through backend services;
  PostgreSQL pgvector for knowledge and memory embeddings.
- Realtime: authenticated Socket.IO connections, per-user rooms, and
  authorized per-task rooms.

Socket.IO currently uses its default in-memory adapter and the delivery code
inspects local sockets, so the supported topology is one backend process.
`SOCKET_IO_INSTANCE_COUNT` defaults to `1`; if set to an invalid value or a
value above `1`, startup fails. Deployments that scale the backend must set
this value to their actual instance count; no distributed adapter is
implemented or verified.

Framework/package versions above use the checked-in manifests and lockfile
resolution; the runtime observed in this workspace is Node 24.19.0/npm 11.17.0.
The repository does not state a tested Node support range.

## Runtime topology and request paths

```text
Browser (React routes/components)
  ├── HTTP JSON ──> Express routes ──> auth middleware ──> controllers/services
  │                                                   └──> PostgreSQL / pgvector
  └── Socket.IO ──> JWT + revocation verification
                     ├── user:<userId> notification room
                     └── task:<taskId> room after assertTaskAccess

Backend AI services ──> OpenRouter chat/embedding APIs (when configured)
Backend email service ──> SendGrid (when configured)
```

### Frontend

`Frontend/src/main.jsx` mounts the application. `Frontend/src/App.jsx` declares
public login/signup/reset/invitation routes and wraps workspace pages in
`AuthProvider`, `ProtectedRoute`, and `Layout`. Pages call the shared API module
in `Frontend/src/services/api.js`; AI-specific requests are grouped in
`aiService.js`. Components and screen styles are under `src/components/`,
`src/pages/`, and `src/styles/`. Auth and theme state live in React contexts.

### HTTP backend

`Backend/src/server.js` loads `Backend/.env`, creates the Express/HTTP/Socket.IO
servers, installs CORS and JSON parsing, exposes `/api/health`, and mounts
feature routers. Feature routes apply JWT middleware and delegate to
controllers. Controllers use parameterized PostgreSQL statements and shared
authorization/retrieval services.

Task comments are readable by organization owners, project admins, and the
assigned project member under the current task-access policy. Comment creation
and deletion have API routes and authorized task-room events; no comment-edit
route is implemented. Task deletion locks the task, project, organization,
and existing membership rows while it captures the event audience and deletes
the task in one transaction.

### Persistence and migrations

`Backend/src/config/database.js` requires `DB_HOST`, `DB_PORT`, `DB_NAME`,
`DB_USER`, and `DB_PASSWORD`, then creates a `pg.Pool`.
`Backend/src/db/migrate.js` executes sorted `.sql` files in
`Backend/src/db/migrations/` and exits nonzero on failure. The 16 ordered SQL
migrations were applied and replayed against a fresh isolated PostgreSQL
database, including pgvector and legacy-row preservation checks.
`npm run db:migrate` is the sole supported migration command; the unused
node-pg-migrate dependency, config, and script were retired. Its empty
historical JavaScript migration artifact is retained because deployed
migration history has not been inspected. The SQL runner is replay-oriented,
does not maintain a ledger, and does not establish that a production schema is
current. The configured local development database's legacy `pgmigrations`
table records only the old `initial-schema` run; it does not prove the ordered
SQL migrations were applied.

Database entities introduced or used by the checked-in SQL migrations:

- Accounts/security: `users` (including `auth_version`),
  `revoked_auth_tokens`, `password_reset_tokens`,
  `password_reset_rate_limits`, `auth_security_events`.
- Workspace/project management: `organizations`, `organization_members`,
  `organization_invitations`, `projects`, `project_members`, `project_statuses`,
  `task_role_tags`, `tasks`, `task_comments`, `task_activity`, `notifications`,
  `labels`, `task_labels`.
- AI/chat/knowledge: `knowledge_base`, `knowledge_embeddings`,
  `ai_task_messages`, `ai_global_messages`, `ai_chat_sessions`, `ai_memories`.
- Agent audit/confirmation: `task_agent_confirmations`,
  `task_agent_tool_events`.
- pgvector extension and indexes are required by vector migrations. These
  entities are evidenced by migration files; the 001–016 migration sequence
  was successfully applied and replayed on an isolated database, not on
  production.

### Authentication and authorization

HTTP auth reads bearer JWTs in `authMiddleware.js`, checks token revocation and
the database `auth_version`, and populates `req.user`. Password reset uses
short-lived hashed single-use tokens, rate limits, audit digests, and rotates
`auth_version`, invalidating existing HTTP and Socket.IO sessions.
Organization authorization is centralized in `authorizationMiddleware.js`;
project/task controllers additionally apply existing membership/role rules.
AI retrieval validates task scope through `assertTaskAccess` before fetching
content. Full cross-tenant role/resource combinations still need integration
tests.

## Private-beta readiness note

The application is currently authenticated with bearer JWTs stored in the
browser via `localStorage`. This design is functional and already protected by
server-side revocation checks, but it remains a security risk under realistic
XSS conditions. It is therefore suitable for internal testing and controlled
invite-only validation only when browser content is tightly constrained and the
token exposure risk is accepted. A production or public-beta deployment should
not proceed until a secure-auth redesign is designed and verified: HttpOnly,
Secure, SameSite cookies with CSRF protections, compatible CORS settings, and
Socket.IO auth that preserves the authenticated principal without exposing the
JWT to JavaScript.

Covered task and comment mutations insert corresponding `task_activity`
records in the same transaction. Task assignment notifications persist in
`notifications` and are emitted to the recipient's user room. Migration 014
serializes administrator-count checks per organization to enforce the existing
maximum under concurrent membership changes. Selected reset, invitation,
outsider-denial, task/comment persistence, and session-invalidation cases are
covered by the isolated database suite.

### AI agent and memory

`agentService.js` provides a registered set of seven named task-agent tools
(`get_task`, `get_project`, `get_tasks`, `create_task`, `update_task`,
`delete_task`, `search_knowledge`) and dispatches tool calls through explicit
cases. Task-agent HTTP handling validates task access before execution; tool
arguments are checked against registered schemas and outcomes are audited
without arguments. Deletion requires a short-lived user/task/action-bound
confirmation JWT with a single-use jti; approval invokes the authorized delete
directly instead of asking the model to choose a mutation again.
`retrievalService.js` scopes task/project/org data; `memoryService.js` persists user-owned
memories with optional org/project/task scope and embeddings. Provider calls
require external OpenRouter configuration. Code inspection does not establish
that live provider requests, every argument boundary, or every memory visibility
rule work correctly. Retrieved task/comment/knowledge content is identified as
untrusted in the system prompt; server-side scope checks remain the authority.
The isolated integration test stubs the provider response and covers tool
argument guards and delete confirmation/replay protections.

The Global AI panel resolves the current organization/project/task context on
the server before returning context or exposing context-bound tools. Explicit
write intent is required for global organization/project/task actions, and
task mutations use the existing task authorization services. Recent Global AI
sessions can be listed and an owned session's messages can be reopened;
ended sessions are read-only. Closing all chats ends active sessions without
deleting history or memories. Deleting one conversation removes its session
and cascading messages while preserving independent memory records. These
session-list, owner-scope, retrieval, deletion, and memory-preservation paths
are covered by disposable PostgreSQL tests.

Global AI's supported consequential writes (`create_organization`,
`create_project`, `create_task`, and `update_current_task`) create persistent
review proposals instead of changing data during chat. Migration
`017_global_ai_action_proposals.sql` stores the validated arguments, exact
targets, preview, creator, expiry, lifecycle status, and result. Approval and
execution revalidate the authenticated user's access; execution locks the
proposal and writes the business change and terminal result in one PostgreSQL
transaction. A per-user request ID and unique proposal idempotency key prevent
duplicate proposals, while replayed approvals return the persisted result.
Pending proposals remain discoverable after closing or deleting their chat.
Only these four existing Global AI write tools are covered; comments,
dependencies, project updates, organization settings, and deletion are not
registered as Global AI tools. Disposable PostgreSQL integration tests cover
pre-approval non-execution, cancellation/expiry, revoked membership, repeated
and concurrent approval, stored replay, failure, and chat closure/deletion.

### Realtime

User notifications are delivered through `user:<id>` rooms. Full task comments
are emitted through `task:<id>` rooms. A client-provided task ID is validated
and authorized before a task-room join. Before emitting private comment events,
each current room member's auth version/token and task access are rechecked;
stale sockets are removed and revoked-token sockets are disconnected. Task-list
invalidations remain global but include only an ID so existing list and project
screens can refresh without receiving the task row itself.

## API surface

Mounted routes:

- `/api/health`: `GET`.
- `/api/auth`: `POST /signup`, `POST /login`, `POST /forgot-password`,
  `POST /reset-password`, `GET /me`, `PUT /me`, `POST /logout`.
- `/api/organizations`: `GET/POST /`, `GET/PUT/DELETE /:id`,
  `GET /:id/members`, `POST /:id/members`,
  `PUT/DELETE /:id/members/:userId`, `GET /:id/invitations`,
  `DELETE /:id/invitations/:invitationId`.
- `/api/invitations`: `GET /:token`, `POST /:token/accept`,
  `POST /:token/accept-and-create-account`.
- `/api/projects`: `GET/POST /`, `GET/PUT/DELETE /:id`,
  `GET/POST /:id/members`, `DELETE /:id/members/:userId`.
- `/api/projects/:id`: workflow router provides status list/create/update/delete/
  reorder and role-tag list/create/update/delete.
- `/api/tasks`: `POST /analyze`, `GET/POST /`, `GET/PUT/DELETE /:id`.
- `/api/comments`: `GET/POST /task/:taskId`, `DELETE /:id`.
- `/api/ai`: task chat/history/end, task agent, global chat/history/end,
  close-all, recent sessions, owned session history, and owned conversation
  deletion.
- `/api/ai/memories`: list/search/create/get/update/delete.
- `/api/knowledge`: authenticated knowledge search.

Endpoint existence and route middleware were inspected; this is not evidence
that every handler was integration-tested.

## Startup

The documented development process uses two terminals:

1. `cd Backend`; install dependencies; configure an ignored `Backend/.env`;
   run `npm run db:migrate`; run `npm run dev`.
2. `cd Frontend`; install dependencies; optionally configure frontend env; run
   `npm run dev`.

Secret-free `Backend/.env.example` and `Frontend/.env.example` templates are
checked in for the documented local setup. A backend process started on port
5101 and returned the expected health JSON. Port 5001 was occupied by a
pre-existing listener, so the changed server was not independently verified on
its default port. The integration suite started a separate API process pointed
at the isolated test database and passed selected database-backed requests.
OpenRouter, SendGrid, full browser journeys, and production database behavior
remain unverified.
