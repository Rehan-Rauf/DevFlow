# DevFlow Project Audit

Audit date: 2026-10-11; Global AI approval update: 2026-10-12

## Executive summary

This repository is an existing full-stack project-management application, not a
static prototype. Its stack is React 18, React Router 7, Vite 6, Express 4,
Socket.IO 4, PostgreSQL (`pg`), JWT, and bcrypt. The checked-in lockfiles
resolve newer compatible patch versions (Vite 6.4.3, Express 4.22.2, `pg`
8.23.0). The inspected runtime is Node 24.19.0 with npm 11.17.0.

The frontend production build passes. The backend has a Node test runner,
focused realtime regression tests, and PostgreSQL-backed API integration tests.
Repository-root npm commands are not project commands because the root has no
`package.json`; run commands from `Backend/` or `Frontend/`. On 2026-10-11,
backend test discovery passed (21 passed, 0 failed, 1 skipped), the isolated
PostgreSQL integration suite passed (5 reported tests, 0 failures), and the
frontend production build passed (119 modules transformed). The integration
suite covers migration replay, authentication/session behavior, selected
workspace boundaries, core project/task/comment persistence, and the fixes
listed below. This does not establish complete CRUD, every role combination,
provider integrations, or browser journeys; see
[TEST_COVERAGE_MATRIX.md](./TEST_COVERAGE_MATRIX.md).

## Global AI action approval update — 2026-10-12

The four registered Global AI write operations now require server-backed
proposal review before execution. Migration 017, approval-time and
execution-time authorization checks, transaction-bound writes, durable
idempotency/replay, cancellation/expiry, and a review card are implemented.
The isolated PostgreSQL integration suite passed 5/5 reported cases, including
concurrent approval without duplicate task creation, request replay, membership
revocation before approval and in the approval/execution gap, no pre-approval
writes, cancellation/expiry, failed execution, and a dropped API response after
commit followed by a non-duplicating retry.
The backend unit suite passed 23 tests with its opt-in PostgreSQL test skipped;
the frontend suite passed 14 tests, and its production build succeeded. The
production build emits an unresolved CSS minifier warning.
These checks do not verify live AI provider behavior or production deployment.

## Private beta readiness status — 2026-10-11

| Gate | Status | Notes |
|---|---|---|
| Internal development | VERIFIED | Auth/schema repair, tenant-scoped access, Socket.IO authorization, and core regression tests are active and passing in disposable/test environments. |
| Private beta with invited users | PARTIALLY VERIFIED | Selected authorization/session tests and mocked browser automation exist, but live-backend browser workflows, live AI/provider verification, and production deployment checks remain unverified. |
| Public commercial launch | NOT VERIFIED | The app remains on a bearer-token architecture in `localStorage`, which is a known XSS exposure; a safe cookie migration would require a dedicated auth redesign and production deployment evidence. |

The current frontend token model remains intentionally documented as a risk: the
browser stores the JWT in `localStorage` and sends it as a bearer token on each
request. That keeps the application functional and compatible with the current
backend, but it is not a private-beta-safe default for a production SaaS exposed
to untrusted browser content. A safe cookie migration is a larger auth redesign
and should not be attempted as a partial one-off change. The immediate next step
is to define and validate a coordinated secure-auth redesign before broader
beta exposure.

The highest-priority verified realtime defects were an authorization bypass in
the Socket.IO task-room subscription and global task-change/assignment
notifications. Task-room joins now use the existing task-access check;
assignment notifications target the recipient's user room; private comment
delivery rechecks task access and token revocation. Phase 5 routes minimal
`task_changed` payloads only to authenticated user sockets authorized for the
task. Real Socket.IO transport tests verify authorized delivery, outsider and
unauthenticated denial, guessed-room rejection, unauthorized-mutation silence,
audience changes after reassignment, and session revocation. Phase 6 adds real
transport coverage for `comment_added`/`comment_deleted` across owner,
project-admin, assignee, ordinary organization/project member, outsider, and
revoked-session cases. Task deletion now locks its task/project/organization
and relevant membership rows while selecting recipients and deleting, closing
the confirmed membership-removal race. The configured in-memory Socket.IO
adapter is single-process only; `SOCKET_IO_INSTANCE_COUNT` rejects declared
multi-instance deployments. No cross-instance adapter is configured or tested.

The 2026-10-11 audit confirmed and fixed three knowledge-search API defects:
unsafe organization/project IDs could pass `Number.isInteger` and reach
PostgreSQL; raw search text was written to backend logs; and a 500 response
included internal provider/database error details. The existing positive-safe
integer validator now rejects unsafe IDs, search text is no longer logged, and
unexpected errors return a generic client-facing message while remaining
logged server-side. Disposable PostgreSQL API integration regressions cover
each behavior.

Phase 7 frontend security review (2026-10-11): the current frontend auth flow
stores the bearer token in `localStorage` and injects it into every request via
`Frontend/src/services/api.js`; logout and 401 handling remove the token and
fire the `auth-expired` event. This is operationally simple and compatible with
the current backend JWT design, but it exposes a bearer token to any JavaScript
code running in the page and therefore remains a security risk. A safe cookie
migration would require coordinated backend cookie issuance with `HttpOnly`,
`Secure`, `SameSite`, CSRF protection, CORS credential handling, Socket.IO auth
compatibility, and session renewal logic; it is a larger auth redesign than the
current phase. This phase therefore kept the bearer-token architecture intact
while adding frontend tests for login/logout, protected-route enforcement,
API failure states, and task-page creation flows, without introducing a
JavaScript-accessible token alternative.

Login schema incident (2026-10-10): repository configuration resolves the
local PostgreSQL target `cms/public`; `public.users.auth_version` was absent
with 31 existing users. The legacy `public.pgmigrations` table contains one
`initial-schema` record, while the current SQL runner applies ordered files
without a ledger. Migration 015 defines the security column, but the SQL
migrations had not been applied to this configured database. A safe
forward-only repair is available as migration 016 and passed disposable-DB
login/session tests. The live port-5001 API returned HTTP 500 on a safe probe,
and its active PostgreSQL socket was correlated to the inspected `cms`
database. After backup/target confirmation, only migration 016 was applied to
`cms/public` at `::1:5432`; the user count remained 31. A live API signup and
successful login passed, and the temporary account was removed.

## Repository inventory

### Root and project configuration

- `.gitignore` excludes `.env`, build output, dependencies, and logs.
- `README.md`, `README_REALTIME.md`, and `CHANGES_AI_KNOWLEDGE_SLICE.md` document
  setup, realtime, and a previous AI/knowledge slice.
- Root `package-lock.json` has no matching root `package.json`; root npm
  commands are therefore not project commands.
- `Backend/package.json` / `Backend/package-lock.json`: Express API, Socket.IO,
  PostgreSQL, JWT, bcrypt, SQL migrations, SendGrid, AI integration; scripts
  include `dev`, `start`, `test`, `test:integration`,
  `test:integration:isolated`, `db:migrate`, and `knowledge:index`.
- `Frontend/package.json` / `Frontend/package-lock.json`: React 18, React
  Router 7, Vite 6; scripts are `dev`, `build`, and `preview`.
- `Frontend/vite.config.js`, `Frontend/index.html`, and
  `Frontend/public/devflow-logo.svg` configure and brand the frontend.
- `Backend/src/db/migrate.js` and ordered SQL files are the sole supported
  migration system. The unused `node-pg-migrate` dependency, config, and
  command were retired; the empty historical JS migration artifact is retained
  unchanged until deployed migration history can be checked.
- An ignored `Backend/.env` exists in the workspace; its values were not
  opened or included in this audit. Secret-free `Backend/.env.example` and
  `Frontend/.env.example` templates have since been added to match the
  application configuration. No Docker/Compose deployment file was found.

### Frontend

- Entry and routing: `Frontend/src/main.jsx`, `Frontend/src/App.jsx`.
- Context: `Frontend/src/context/AuthContext.jsx`,
  `Frontend/src/context/ThemeContext.jsx`.
- Screens in `Frontend/src/pages/`: `Dashboard.jsx`, `ForgotPassword.jsx`,
  `Invitation.jsx`, `KnowledgeSearchPage.jsx`, `Login.jsx`, `OrganizationDetail.jsx`,
  `Organizations.jsx`, `Profile.jsx`, `ProjectDetail.jsx`, `Projects.jsx`,
  `ResetPassword.jsx`, `Signup.jsx`, `TaskDetail.jsx`, `TasksPage.jsx`.
- Shared components in `Frontend/src/components/`: `AIMemoryPanel.jsx`,
  `BlockedSession.jsx`, `CommandPalette.jsx`, `GlobalAIChat.jsx`,
  `KnowledgeSearch.jsx`, `Layout.jsx`, `ProtectedRoute.jsx`,
  `RecentChats.jsx`, `TaskAgentPanel.jsx`, `TaskAIPanel.jsx`, `TaskBoard.jsx`.
- UI components in `Frontend/src/components/ui/`: `Button.jsx`,
  `ConfirmDialog.jsx`, `EmptyState.jsx`, `InlineNotice.jsx`, `Modal.jsx`,
  `PageHeader.jsx`, `SectionCard.jsx`, `SelectField.jsx`.
- API/AI/session services: `Frontend/src/services/api.js`,
  `Frontend/src/services/aiService.js`,
  `Frontend/src/services/singleTabSession.js`.
- Utilities/constants: `Frontend/src/utils/taskFormatters.js`,
  `Frontend/src/constants/taskWorkflow.js`.
- Styles: `Frontend/src/styles.css` and 16 stylesheets under
  `Frontend/src/styles/` (auth, base, layout, dashboard, organizations,
  projects, tasks, AI, shared UI, and responsive styles).
- `Frontend/src/components/TaskBoard.jsx` and `Frontend/src/components/BlockedSession.jsx`
  are present, but their use/behavior and full screen-to-API coverage have not
  yet been verified. No standalone frontend test, lint, or type-check config
  was found.

### Backend

- Startup and config: `Backend/src/server.js`,
  `Backend/src/config/database.js`, `Backend/src/config/ai.js`.
- Routes in `Backend/src/routes/`: `aiRoutes.js`, `authRoutes.js`,
  `commentRoutes.js`, `invitationRoutes.js`, `knowledgeRoutes.js`,
  `memoryRoutes.js`, `organizationRoutes.js`, `projectRoutes.js`,
  `taskRoutes.js`, `workflowRoutes.js`.
- Controllers in `Backend/src/controllers/`: `aiController.js`,
  `authController.js`, `commentController.js`, `knowledgeController.js`,
  `memoryController.js`, `organizationController.js`, `projectController.js`,
  `taskController.js`, `workflowController.js`.
- Services in `Backend/src/services/`: `agentService.js`, `aiService.js`,
  `emailService.js`, `embeddingService.js`, `knowledgeBaseService.js`,
  `memoryService.js`, `retrievalService.js`, `semanticSearchService.js`,
  `vectorSearchService.js`; `taskRoomAuthorization.js` was added for the first
  repair.
- Middleware: `Backend/src/middleware/authMiddleware.js`,
  `Backend/src/middleware/authorizationMiddleware.js`.
- Other modules: `Backend/src/db/migrate.js`,
  `Backend/src/scripts/indexKnowledge.js`,
  `Backend/src/utils/knowledgeText.js`,
  `Backend/src/utils/response.js`, `Backend/src/utils/validation.js`.
- `Backend/src/testEmbedding.js`, `testKnowledgeBase.js`, and
  `testVectorSearch.js` are manually run integration scripts, not automated
  test-runner tests. They depend on external service/database configuration.
- Automated regression tests are in
  `Backend/test/taskRoomAuthorization.test.js` and
  `Backend/test/databaseWorkflow.integration.test.js`.

## Feature and risk assessment

| Area | Classification | Evidence / limitation |
|---|---|---|
| React/Vite frontend production build | Working and verified | `npm run build` in `Frontend/` passed before and after the repair. |
| Express API health route | Working and verified | A new backend process started on port 5101 and returned the expected `/api/health` JSON. Port 5001 was already occupied, so that standard port was not independently verified. |
| Signup, login, logout, token expiry/revocation | Working and verified for tested API cases | PostgreSQL-backed integration tests create and re-query users, reject duplicate emails, authenticate, expire/revoke tokens, and reject post-logout use. |
| Password-reset lifecycle | Working and verified for tested API cases | Isolated integration tests cover generic responses, concurrent per-email rate limits, hashed tokens, invalid/expired/reused tokens, password validation, session-version invalidation, audit digests, and controlled email capture without SendGrid. |
| Organization invitations and membership | Working and verified for tested API cases | Integration tests cover invite preview/acceptance, repeated acceptance, wrong-account rejection, and persisted membership; full admin/member role matrix remains incomplete. |
| Project/task/comment persistence | Working and verified for tested API cases | Integration tests create/re-read project, task, comment, activity, notification, update/archive/delete records; not every CRUD branch or UI journey is covered. |
| Workspace authorization | Working and verified for tested API cases | Tests cover outsider organization/project/task/comment requests and unauthorized project/comment updates/deletes; exhaustive project-role/organization-role/resource matrix remains missing. |
| Invalid request IDs and core field validation | Working and verified for tested API cases | Integration tests cover malformed path IDs, invalid task status/date, invalid project status, and overlong signup name. Other routes and query parameters still need validation tests. |
| Knowledge search input/error handling | Working and verified for tested cases | Disposable API tests verify unsafe organization/project IDs return 400, raw search text is absent from captured server output, and simulated provider details are not returned in a 500 response. Successful vector retrieval and production provider behavior remain unverified. |
| Database migrations and pgvector | Working and verified on disposable and confirmed local development PostgreSQL | Ordered 001–016 SQL migrations were applied and replayed on disposable DB; only migration 016 was applied to confirmed local `cms/public`, preserving all 31 users. |
| Concurrent organization administrator limit | Working and verified on a disposable PostgreSQL database | Concurrent membership inserts were tested; exactly three admins succeeded and the fourth was rejected. |
| Task-agent deletion confirmation and tool schemas | Working and verified for selected security cases | Provider-stub integration covers no-delete-before-approval, invalid/wrong-user/wrong-task/wrong-action rejection, and concurrent single-use confirmation. Unit tests exercise tool-schema guards. Live provider and other tool behavior remain unverified. |
| Socket.IO task-room access and comment delivery | Working and verified for selected authorization cases | Real transport tests verify authorized owner/project-admin/assignee comment delivery, denied ordinary organization/project members and outsiders, guessed-room rejection, unauthorized comment operations, ID-only deletion events, and revoked-session disconnection. Comment editing is not implemented. |
| Socket.IO task-change audience | Working and verified for selected transport cases | Real client/server tests verify task-ID-only delivery to owner/project-admin/assignee user sockets; creator status alone, ordinary organization/project membership, and outsider status do not grant access. Reassignment, membership downgrade, unauthorized mutation, and session revocation are tested. |
| Socket.IO multi-instance operation | Unsupported; guarded | The application uses Socket.IO's in-memory adapter and local socket maps; the server rejects `SOCKET_IO_INSTANCE_COUNT` values above one. No distributed adapter or cross-instance test/deployment configuration exists. |
| Socket.IO assignment notification scope | Implemented but incompletely tested | Assignment notifications target the recipient's `user:<id>` room; no dedicated transport assertion covers this notification event. |
| AI chat and task agent | Working and verified for selected security boundaries | Global AI organization/project/task creation and current-task update now require a persisted proposal, explicit approval, current authorization, and transactional execution. Disposable PostgreSQL integration covers failed/no-op pre-approval, replay, concurrent approval, revoked membership, cancellation/expiry, and pending proposals after chat closure/deletion. Vitest covers review, server-confirmed success, cancellation, and rediscovery. Other write operations are not registered; live provider behavior and prompt-injection resistance remain unverified. |
| AI memory | Working and verified for selected API cases | Disposable PostgreSQL integration covers private/org/task visibility, unauthorized access, scope mismatch, and vector persistence with a test embedding adapter. Broader CRUD, semantic ranking, and live embeddings remain unverified. |
| Knowledge indexing/search | Implemented but incompletely verified | Unsafe IDs, provider failure handling, and log/response redaction are tested. Successful retrieval/ranking, indexing freshness, and live embedding-provider behavior remain unverified. |
| Proactive suggestions / accept-dismiss-execute lifecycle | Missing or unverified | No dedicated suggestion lifecycle/entity/API/UI was found in the inspected inventory. Confirm scope before implementation. |
| Database migration reproducibility | Working and verified for SQL migration replay | 16 SQL migrations applied/replayed on a fresh disposable DB. SQL is the sole supported path; the empty historical JS migration artifact remains retained. Production migration history is unverified. |
| Environment templates | Implemented; contents checked for secret values | `Backend/.env.example` and `Frontend/.env.example` now list required/optional settings with local defaults and placeholders; they are not ignored by Git. |
| Backend automated tests | Partial coverage added and verified | Latest observed `npm test`: 23 passed, 0 failed, 1 opt-in PostgreSQL test skipped without a configured integration DB. Latest `npm run test:integration:isolated`: 5 passed, 0 failed/skipped on a disposable DB that was dropped. Full role/resource matrix, remaining CRUD, and external-provider behavior remain outstanding. |
| Frontend automated tests | Working and verified for selected component/API and mocked browser cases | Latest Vitest run passed 11 tests across 5 files; four Playwright Chromium tests passed with mocked API endpoints. Global AI conversation-history controls are covered at component level. Live-backend browser workflows remain unverified. |
| Lint/type-check | Missing | No lint or TypeScript configuration/script found. |
| Deployment/orchestration | Missing | No Dockerfile or Compose config found in the repository inventory. |

## Defects, gaps, and order of work

1. **P2 — Realtime deployment boundary:** selected task/comment delivery,
   access roles, session revocation, and the deletion membership race have
   real-transport or concurrency regressions. Multi-instance operation remains
   unsupported until a distributed adapter is selected, configured, and tested.
2. **P1 — Migration safety and concurrency:** migration 003 is replay-safe,
   migration 014 serializes admin caps, and all 16 SQL migrations applied and
   replayed on a fresh disposable database. SQL is the sole supported runner;
   deployed migration history remains unknown.
3. **P1 — Workspace/API regression coverage:** signup/login/logout/reset,
   session rotation, invitation, cross-workspace, persistence, invalid-input,
   activity, and admin-cap cases are tested. Complete route/role combinations,
   every private endpoint, and all CRUD branches still need coverage.
4. **P1 — AI/knowledge/memory reliability:** task-agent argument checks,
   tool-outcome audit, and one-time destructive confirmation are implemented
   and tested. Other tool calls, prompt injection, memory visibility/ownership,
   duplicate prevention, and provider-unavailable behavior remain unverified.
5. **P2 — Feature completeness:** proactive suggestions and their
   inspect/dismiss/accept/execute lifecycle are missing; audit visible controls
   and remaining search/dashboard workflows.
6. **P2 — Realtime/event behavior:** test comment payload privacy and
   recipient-only notification delivery over actual Socket.IO connections and
   deployed adapters.
7. **P3 — Operations/accessibility/responsiveness:** test keyboard and
   screen-reader behavior plus mobile, tablet, laptop, and wide layouts; define
   deployment checks and supported runtime versions.

## Full workflow audit — 2026-10-11

| Workflow | Classification | Evidence and remaining limits |
|---|---|---|
| Authentication, logout, and session expiration | Working and verified for selected API cases | Disposable API tests cover signup/login, invalid credentials, logout/revocation, reset/session rotation, and `auth_version` invalidation. Browser navigation and reload behavior are not automated. |
| Organization membership and role permissions | Implemented but incompletely tested | Invitation acceptance, outsider denial, membership constraints, and concurrent admin caps are tested. The complete owner/admin/member permission matrix is not. |
| Projects and project-level access | Working and verified for selected API cases | Project creation/read/update/archive and outsider denial are exercised. Full project-member role combinations and every CRUD branch are not. |
| Tasks, assignment, status, priority, due dates, and deletion | Working and verified for selected API cases | API integration covers assignment, status/priority updates, invalid status/date/assignee/tag input, atomic create rollback, authorization, and deletion. All valid due-date boundaries and every role combination are not covered. |
| Comments and activity history | Working and verified for selected API/transport cases | Add/list/delete, access denial, activity records, and real `comment_added`/`comment_deleted` delivery are exercised. No comment-edit route exists; nested replies and browser journeys remain untested. |
| Notifications and Socket.IO events | Working and verified for selected transport cases | Real transport tests verify task/comment event authorization, payload minimization, unauthorized operations, membership/assignment changes, and session revocation. Multi-node delivery is unsupported by the in-memory adapter and is rejected when `SOCKET_IO_INSTANCE_COUNT` declares more than one instance. |
| Search, filters, sorting, and pagination | Partially implemented | Knowledge organization/project filters and priority/date task ordering exist; unsafe search IDs now have regression tests. Successful retrieval, broad filter/sort semantics, pagination, and upper result bounds are not verified. |
| AI assistant, tool authorization, and destructive confirmation | Working and verified for selected security cases | Tool argument schemas and single-use, user/task/action-bound delete confirmations are tested with a deterministic provider stub. Other tools, prompt-injection resistance, and live providers are not. |
| Knowledge base, retrieval, embeddings, and memory | Implemented but incompletely tested | Memory scope/visibility and vector persistence pass with test embeddings; knowledge error handling is tested. Live embeddings, successful semantic knowledge search, ranking, and index freshness are unverified. |
| Frontend navigation, loading/error states, and API integration | Implemented but incompletely tested | Latest Vitest run passed 11 tests across 5 files; production build passed; 4 Playwright Chromium journeys passed with mocked API calls. Global AI history UI tests cover session list/open/read-only/delete and close-all. Live-backend browser journeys remain unverified. Auth tokens are stored in `localStorage`, and the single-tab lock is advisory and race-prone. |

## Environment and verification boundaries

- Frontend production build passed after Phase 3A changes with Vite 6.4.3 and
  119 modules transformed.
- Backend `npm test` passed 19/19 runnable unit tests; the DB suite is
  intentionally skipped without an explicit test database.
- Backend `npm run test:integration:isolated` passed four PostgreSQL-backed
  integration tests on a new loopback-only database. The helper dropped only
  that exact database; the task-agent case uses a test-only OpenRouter fetch
  stub.
- Phase 5 verification: `npm test` passed 19 tests with one opt-in PostgreSQL
  test skipped; `npm run test:integration:isolated` passed all five reported
  tests, including real Socket.IO client/server authorization cases, on
  disposable database `devflow_test_phase3a_e227422a`, which was dropped;
  `npm run build` passed with 119 modules transformed. No development database
  was modified for Phase 5.
- Phase 6 verification: `npm test` passed 21 tests with one opt-in PostgreSQL
  test skipped; `npm run test:integration:isolated` passed all five reported
  tests, including comment transport/role matrix and the task-deletion
  membership race, on disposable database `devflow_test_phase3a_995ced9f`,
  which was dropped. `npm run build` passed with 119 modules transformed.
  starting the backend with `SOCKET_IO_INSTANCE_COUNT=2` was rejected before
  listening, as expected. No development database was modified for Phase 6.
- All 16 SQL migrations applied from scratch and replayed there; a legacy
  knowledge row survived replay, pgvector was present, and the database name
  was checked.
- Syntax checks for modified Node files, `git diff --check`, and the frontend
  production build passed.
- `npm audit` reports zero vulnerabilities after compatible production
  dependency updates and removal of nodemon in favor of Node's built-in
  `--watch`.
- A backend process started earlier on port 5101 and `/api/health` returned
  `{"success":true,"message":"DevFlow API is running."}`. Port 5001 was
  occupied by a pre-existing process; no process was terminated.
- Root npm commands do not apply because there is no root `package.json`.
- Live OpenRouter, embeddings, SendGrid, full browser journeys,
  accessibility/responsive behavior, and exhaustive authorization roles have
  not been exercised.
- No API keys, database passwords, JWTs, or `.env` values are included here.

See [IMPLEMENTATION_PLAN.md](./IMPLEMENTATION_PLAN.md),
[ARCHITECTURE.md](./ARCHITECTURE.md), and
[TEST_COVERAGE_MATRIX.md](./TEST_COVERAGE_MATRIX.md) for the phase plan,
data-flow outline, and per-surface coverage status.
