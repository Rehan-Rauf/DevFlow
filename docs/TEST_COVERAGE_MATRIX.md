# DevFlow Test Coverage Matrix

Updated: 2026-10-11

## Status definitions

- **Working and verified**: behavior was exercised by an observed test/build/
  runtime check.
- **Implemented but unverified**: source exists, but no corresponding executed
  verification is recorded.
- **Broken**: a defect was confirmed by source inspection or execution.
- **Missing**: no implementation/test was found.
- **Blocked**: execution depends on unavailable/unconfigured infrastructure.

No feature is labeled verified merely because it builds or its files exist.

## Release gate status — 2026-10-11

| Stage | Status | Evidence | Remaining gaps |
|---|---|---|---|
| Internal development | VERIFIED | Backend tests, frontend tests, frontend build, mocked Chromium journeys, and disposable integration tests passed in the latest observed run. | Live provider and broader external-service verification remain absent. |
| Private beta / invited users | PARTIALLY VERIFIED | Authorization, task/comment realtime safeguards, membership revocation, AI/vector access checks, and selected mocked browser journeys are covered. | Live-backend browser journeys, operational evidence, and production security review remain missing. |
| Public commercial launch | NOT VERIFIED | No deployment-level validation, backup/restore test, or hardened token strategy is in place. | Cookie migration and live provider/deployment readiness remain blockers. |

The current frontend token implementation stored in `localStorage` is treated as
an acknowledged residual risk, not as a verified-safe production choice.
Playwright Chromium is configured and four mocked API journeys passed; this is
not live-backend E2E validation. Live provider calls remain intentionally
excluded from routine validation and require explicit configuration and budget
approval.

## Automated test audit update — 2026-10-10

The backend suite uses Node's built-in `node:test` runner. Vitest and Playwright
are configured for frontend behavior and mocked browser journeys. The following
table records historical audit results:

| Command | Result |
|---|---|
| `npm run test:unit` (from `Backend/`) | **Passed:** 19 tests, 0 failed, 0 skipped. |
| `npm run test:integration:isolated` (from `Backend/`) | **Passed:** 5 top-level tests, 0 failed; `devflow_test_phase3a_1e5d7782` was freshly created, all 16 migrations applied, auth-version migration/login/session invalidation and memory scope/CRUD checks passed, and the exact disposable DB was dropped. |
| `npm run build` (from `Frontend/`) | **Passed:** Vite production build; 119 modules transformed. |
| `node --check` on changed backend tests and test support | **Passed.** |
| Live API diagnostic `POST http://127.0.0.1:5001/api/auth/login` using a non-existent probe identity | **Reproduced:** HTTP 500, generic `Unable to login.` response; a concurrent `pg_stat_activity` check confirmed the API connection was to `cms` on local PostgreSQL. No credentials or real user data were sent. |
| Configured database schema/history inspection (before repair) | **Observed:** database `cms`, schema `public`, loopback PostgreSQL port 5432; `public.users.auth_version` absent; 31 user rows; legacy `public.pgmigrations` contains the prior `initial-schema` record. |
| `npm run db:migrate -- 016_repair_auth_version.sql` with expected DB/schema/address/port guards | **Applied and verified:** target was PostgreSQL `::1:5432`, database `cms`, schema `public`; `users.auth_version` is `INTEGER NOT NULL DEFAULT 0`, user count remained 31, and the legacy `pgmigrations` record remained unchanged. |
| Restarted live API signup/login/session smoke test (`localhost:5001`) | **Passed:** restart and health check succeeded; test confirmed the API process connects to `cms`; temporary account signup 201, invalid credentials 401, valid login 200, authenticated `/me` 200; after incrementing `auth_version`, old token received 401; exact temporary user removed. |
| `git diff --check` | **Passed** after the login-schema repair changes. |

The isolated integration suite uses deterministic test-only OpenRouter chat
and embedding responses. These prove application/database behavior, not live
provider integration.

## Global AI history continuation — latest observed checks

| Command / check | Result |
|---|---|
| `npm test` (from `Backend/`) | **Passed:** 24 discovered; 23 passed, 0 failed, 1 opt-in PostgreSQL test skipped because no integration DB was configured for this invocation. |
| `npm run test:integration:isolated` (from `Backend/`) | **Passed:** 5 passed, 0 failed/skipped; fresh migrations and recent-chat list, owned history retrieval/deletion, close-all preservation, and independent-memory retention ran against an exact loopback-only disposable database, which was dropped afterward. |
| `npm test` (from `Frontend/`) | **Passed:** 11 tests across 5 files, including Global AI history listing/opening/view-only behavior, close-all, and confirmed conversation deletion. |
| `npm run build` (from `Frontend/`) | **Passed:** Vite transformed 119 modules and generated the production bundle. A CJS API deprecation notice and CSS minifier warning at `<stdin>:3034` were emitted; the warning source was not traced in this task. |
| `npm run test:e2e -- --output "C:\Users\pc\AppData\Local\Temp\devflow-global-agent-e2e"` (from `Frontend/`) | **Passed:** 4 Chromium tests covering unauthenticated redirect/login, logout/protected routes, end-chat controls, and task workflow. API calls were mocked; this is not live-backend E2E validation. |
| `git diff --check` | **Passed:** no whitespace errors reported. |

No developer database was modified. The browser tests do not cover the new
Global AI history UI against a live API; its history UI behavior is covered by
Vitest, while its list/retrieve/delete server paths are covered by the isolated
PostgreSQL suite.

## Global AI action approval — 2026-10-12

| Command / check | Result |
|---|---|
| `npm test` (from `Backend/`) | **Passed:** 24 discovered; 23 passed, 0 failed, 1 opt-in PostgreSQL test skipped because no test database was configured for this invocation. |
| `npm run test:integration:isolated` (from `Backend/`) | **Passed:** fresh migration 017 and all PostgreSQL integration checks; 5 passed, 0 failed/skipped against `devflow_test_phase3a_024ee7bd`, which was dropped afterward. Coverage includes no execution before approval, cross-user denial, project access revoked before approval and in the approval/execution gap, concurrent/replayed approval without duplicate tasks, a response dropped after commit followed by stored-result retry, cancellation/expiry, failure rollback, and pending proposal retention when chats close/delete. |
| `npm test` (from `Frontend/`) | **Passed:** 14 tests across 5 files, including approval result rendering, cancellation without approval, and pending proposal rediscovery. |
| `npm run build` (from `Frontend/`) | **Passed:** Vite transformed 119 modules. It emitted a CSS minifier warning (`Unexpected "}"` at generated input line 3117) and a CJS API deprecation notice; the production bundle was generated. |
| `npm run test:e2e -- --output "C:\Users\pc\AppData\Local\Temp\devflow-global-action-e2e"` (from `Frontend/`) | **Passed:** 4 Chromium tests. API calls are mocked; the approval lifecycle was not exercised in a real browser against the backend. |
| `git diff --check` | **Passed:** no whitespace errors. |

The isolated runner created and dropped only its random-named loopback test
database. No developer database was modified. Live provider behavior and
production operation remain unverified.

## Full functional audit verification — 2026-10-11

Commands were run from the package directories. The isolated integration
helper created and dropped only the named disposable database below; no
development database was modified during this audit.

| Command / check | Result |
|---|---|
| `npm test` (from `Backend/`) | **Passed:** 20 discovered tests; 19 passed, 0 failed, 1 opt-in PostgreSQL test skipped because no test database was configured for this invocation. |
| `npm run test:integration:isolated` (from `Backend/`) | **Passed:** created `devflow_test_phase3a_0f6f3fb6` on loopback; fresh application and repeat migrations completed; 5 reported tests passed, 0 failed; the exact disposable database was dropped. |
| `npm run build` (from `Frontend/`) | **Passed:** Vite production build; 119 modules transformed. No frontend test runner/script exists, so focused frontend tests were unavailable. |
| Knowledge search unsafe-ID regression | **Passed** in the isolated API suite: unsafe organization and project IDs return 400. |
| Knowledge search log/error-redaction regressions | **Passed** in the isolated API suite: raw query text was absent from captured backend output; simulated provider details were not included in the client 500 response. |
| `git diff --check` | **Passed** after audit changes. |

These results do not verify a browser journey, successful semantic knowledge
retrieval against live embeddings, private comment delivery over actual
Socket.IO transport, or external OpenRouter/SendGrid services.

## Secure realtime task-event verification — 2026-10-11

| Command / check | Result |
|---|---|
| `npm test` (from `Backend/`) | **Passed:** 20 discovered tests; 19 passed, 0 failed, and 1 opt-in PostgreSQL test was skipped because no test database was configured for this invocation. |
| `npm run test:integration:isolated` (from `Backend/`) | **Passed:** all 5 reported tests, 0 failed, including real Socket.IO client/server connections on disposable database `devflow_test_phase3a_e227422a`; the exact database was dropped after the run. |
| Socket.IO task-event transport cases | **Passed:** authenticated owner/assignee delivery with minimal task IDs; unauthenticated connection rejection; outsider task-room join denial and no outsider delivery; unauthorized mutation silence; delivery follows assignee changes; revoked socket session is disconnected and receives no later event. |
| `npm run build` (from `Frontend/`) | **Passed:** Vite production build; 119 modules transformed. No frontend test runner is configured. |
| `git diff --check` | **Passed** after the Phase 5 implementation and documentation updates. |

No development database was modified for these Phase 5 checks. The tests do not
cover private comment transport, multi-node Socket.IO adapters, or every role
combination.

## Realtime comment authorization and deletion race verification — 2026-10-11

| Command / check | Result |
|---|---|
| `npm test` (from `Backend/`) | **Passed:** 22 discovered tests; 21 passed, 0 failed, and 1 opt-in PostgreSQL test was skipped because this invocation did not configure an integration database. |
| `npm run test:integration:isolated` (from `Backend/`) | **Passed:** 5 reported tests, 0 failed or skipped on disposable database `devflow_test_phase3a_995ced9f`; the exact test database was dropped. |
| Comment API/realtime authorization matrix | **Passed:** real clients verified owner, project admin, and assigned project member delivery of `comment_added`/`comment_deleted`; ordinary organization members, unassigned project members, task creator status alone, and outsiders were denied API access/room joins and received no comment events. Unauthenticated requests/connections were rejected. Unauthorized create/delete operations emitted no protected comment event. |
| Comment session revocation | **Passed:** after `auth_version` changed, the project-admin API token returned 401, its live socket disconnected on the next private event, and it received no subsequent comment payload. |
| Task deletion membership-change race | **Passed:** integration test held a project-admin role update open, observed the delete transaction waiting on the membership row lock, committed the downgrade, and verified the former admin received no deletion event while the owner and assignee did. |
| Multi-node Socket.IO | **Not tested; unsupported:** the application uses the process-local in-memory adapter. Actual backend startup with `SOCKET_IO_INSTANCE_COUNT=2` was rejected before listening; no distributed adapter is configured. |
| `npm run build` (from `Frontend/`) | **Passed:** Vite production build; 119 modules transformed. |
| `git diff --check` | **Passed** after Phase 6 changes. |

No development database was modified. There is no comment-edit API in the
current routes. The role matrix verifies the existing task-access policy, not
all organization/project authorization combinations.

## Executed checks

| Command / check | Scope | Result |
|---|---|---|
| `npm run test:unit` (Backend, test-suite audit) | Focused backend unit tests | **Passed:** 19 tests, 0 failures, 0 skipped. |
| `npm run test:integration:isolated` (Backend, test-suite audit) | Fresh PostgreSQL schema, API and memory scope workflows | **Passed:** `devflow_test_phase3a_cf8e82d5`; all 15 migrations applied; 4 top-level tests passed; exact disposable database dropped. |
| `npm run test:integration:isolated` (auth-version repair) | Targeted migration and login/session regression | **Passed:** `devflow_test_phase3a_24242179`; migration 016 applied twice after simulated column absence; existing fixture account/password preserved, valid login succeeded, invalid credentials returned 401, and incrementing the version invalidated the token; all 16 migrations passed and disposable DB was dropped. |
| `npm run build` (Frontend, test-suite audit) | Vite production bundle | **Passed:** Vite 6.4.3; 119 modules transformed. |
| `node --check` on changed backend test and test-support files | JavaScript syntax | **Passed.** |
| `npm test` (from repository root, test-suite audit) | Incorrect working directory | **Failed with ENOENT** because root has no `package.json`; running from `Backend/` is required. From `Backend/`, default suite passes with the integration suite skipped when no explicit test DB is configured. |
| `npm run build` (run from `Frontend/`, after Phase 2 changes) | Vite production bundle | **Passed**: Vite 6.4.3, 119 modules transformed, output emitted under `Frontend/dist/`. |
| `npm test` (run from `Backend/`) | Unit tests and opt-in integration suite | **Passed**: 16 unit tests, 0 failures; PostgreSQL integration test skipped because this invocation did not set the explicit test DB variable. |
| `DEVFLOW_TEST_DATABASE_NAME=devflow_phase2_test_20261010 npm run test:integration` (run from `Backend/`) | PostgreSQL-backed API/migration suite | **Passed**: 4 tests, 0 failures, against an isolated PostgreSQL 18.4 database explicitly named for testing. |
| `node --check` on changed backend source and integration test files | JavaScript syntax | **Passed** for all checked files. |
| `npm run db:migrate` (run from `Backend/` against the empty isolated test DB) | Fresh-schema migration application | **Passed**: all 14 SQL migrations applied in filename order. |
| SQL migrations 001–014 replayed in the isolated test database | Migration repeatability, pgvector and preservation | **Passed**; the suite verified `vector` exists and a legacy `knowledge_base` row remains after replay. This is not evidence about any production database. |
| `$env:PORT='5101'; npm start` and `GET http://localhost:5101/api/health` | Backend startup and health route | **Passed** on port 5101; response was `{"success":true,"message":"DevFlow API is running."}`. Port 5001 was occupied by a pre-existing listener; the attempted start there failed with `EADDRINUSE`. |
| `git diff --check` | Patch whitespace/errors | **Passed**. |
| `npm test` (Backend, Phase 3A) | Backend unit regressions | **Passed**: 19 passed, 0 failed; 1 PostgreSQL suite skipped because no test database was configured for this invocation. |
| `npm run test:integration:isolated` (Backend, Phase 3A) | Fresh SQL schema + PostgreSQL API tests | **Passed**: `devflow_test_phase3a_085c9223` was created on loopback; all 15 SQL migrations applied and replayed; 4 integration tests passed; pgvector and preserved legacy knowledge row verified; exact DB dropped. |
| `node --check` on changed backend JS files | Syntax | **Passed**. |
| `npm audit --omit=dev` (Backend, Phase 3A) | Production dependencies | **Passed**: 0 reported vulnerabilities after compatible lockfile updates. |
| `npm audit` (Backend, after selected follow-up) | All dependencies | **Passed**: 0 reported vulnerabilities after removing nodemon and changing the dev script to Node `--watch`. |
| `git diff --check` (Phase 3A) | All current worktree changes | **Passed** on the final worktree after documentation updates. |
| `git check-ignore Backend/.env.example Frontend/.env.example` | Environment templates | **Passed**: neither example file is excluded by the repository ignore rules; inspected entries are placeholders/local URLs, not credentials. |
| `npm run build` / `npm test` from repository root | Wrong working directory | **Not applicable / failed with ENOENT**: root has no `package.json`; this is not an application build/test failure. |
| PostgreSQL migrations and selected DB-backed API workflows | Database integration | **Passed** on the named disposable database; the suite creates/requeries users, invitation membership, project, task, comment, activity, and notification records, forces a task-create transaction rollback, and checks selected authorization/constraint failures. |
| OpenRouter, embeddings, SendGrid | External services | **Not run**; credentials/provider availability are not verified. |
| Browser/authenticated end-to-end journey | UI + API + DB | **Not run**. |

## Frontend screen inventory

All screens are routed through `Frontend/src/App.jsx`. A screen/API mapping is
listed below; no frontend component test suite was present during the audit.

| Screen | Main components / services | API / data | Status and test gap |
|---|---|---|---|
| Login (`pages/Login.jsx`) | Auth context, shared layout styles | `/api/auth/login` | Implemented but unverified; login, invalid credentials, expired session tests missing. |
| Signup (`pages/Signup.jsx`) | Auth context | `/api/auth/signup` | Implemented but unverified; form and persistence journey missing. |
| Forgot password (`pages/ForgotPassword.jsx`) | Auth API | `/api/auth/forgot-password` | Backend request/anti-enumeration response and rate limits tested with controlled email capture; frontend form and live SendGrid remain unverified. |
| Reset password (`pages/ResetPassword.jsx`) | Auth API | `/api/auth/reset-password` | Backend hash storage, policy, expiry, reuse, invalid token, password update, and old-session invalidation tested; frontend journey remains unverified. |
| Invitation (`pages/Invitation.jsx`) | Auth/API | `/api/invitations/:token` and accept endpoints | Implemented but unverified; expired/used/cross-org acceptance tests missing. |
| Overview (`pages/Dashboard.jsx`) | `Layout`, dashboard styles | Organizations/project/task APIs (confirm exact calls in journey tests) | Implemented but unverified; data and empty/error states need tests. |
| Organizations (`pages/Organizations.jsx`) | Organization forms and shared UI | `/api/organizations` | Implemented but unverified; CRUD, role visibility, empty/error cases missing. |
| Organization detail (`pages/OrganizationDetail.jsx`) | Member/invitation management | `/api/organizations/:id` and member/invitation routes | Implemented but unverified; owner/admin/member matrix missing. |
| Projects (`pages/Projects.jsx`) | Project listing | `/api/projects` | Implemented but unverified; organization scoping and empty/error cases missing. |
| Project detail (`pages/ProjectDetail.jsx`) | `TaskBoard`, UI controls, Socket.IO | Project, member, status, role-tag, task APIs | UI journey, CRUD, and status/role coverage remain incomplete; backend task-event audience is transport-tested as recorded above. |
| Tasks (`pages/TasksPage.jsx`) | Task list, command/AI UI | `/api/tasks`, organizations, AI | Implemented but unverified; filters, access, and task journeys missing. |
| Task detail (`pages/TaskDetail.jsx`) | `TaskAIPanel`, `TaskAgentPanel`, comments, `ConfirmDialog` | Task, comments, `/api/ai/task/:id/*`, Socket.IO | Production build and backend task/comment transport/authorization tests pass; destructive confirmation/replay API is integration-tested; browser journey remains unverified. |
| Knowledge search (`pages/KnowledgeSearchPage.jsx`) | `KnowledgeSearch` | `/api/knowledge/search` | Implemented but unverified; pgvector/provider integration blocked pending setup. |
| Profile (`pages/Profile.jsx`) | Profile/preferences UI | `/api/auth/me` and client preferences | Implemented but unverified; persistence and accessibility tests missing. |

## Reusable component inventory

| Component | Primary surface | Test status |
|---|---|---|
| `components/Layout.jsx` | Authenticated navigation, user-room notifications | Implemented but unverified; notification audience/runtime tests missing. |
| `components/ProtectedRoute.jsx` | Auth route guard | Implemented but unverified; redirect/session tests missing. |
| `components/BlockedSession.jsx` | Single-tab/session restriction | Implemented but unverified; browser storage/lifecycle tests missing. |
| `components/CommandPalette.jsx` | Navigation/action palette | Implemented but unverified; keyboard and action tests missing. |
| `components/GlobalAIChat.jsx` | Workspace AI chat | Implemented but unverified; API and provider tests missing. |
| `components/RecentChats.jsx` | AI chat history | Implemented but unverified; API/loading/empty tests missing. |
| `components/KnowledgeSearch.jsx` | Knowledge search UI | Implemented but unverified; result/error tests missing. |
| `components/AIMemoryPanel.jsx` | Scoped memory CRUD/search | Backend API integration now verifies private/org/task visibility, user ownership, and same-scope deduplication; the React component and browser flow remain unverified. |
| `components/TaskAIPanel.jsx` | Task conversation | Implemented but unverified; task access and provider tests missing. |
| `components/TaskAgentPanel.jsx` | Task-agent tool execution | Confirmation flow is exercised by PostgreSQL API integration tests; UI interaction and other agent tools remain unverified. |
| `components/TaskBoard.jsx` | Project task board | Implemented but unverified; drag/drop and persistence tests missing. |
| `components/ui/Button.jsx` | Shared action | Implemented but unverified; keyboard/disabled-state tests missing. |
| `components/ui/ConfirmDialog.jsx` | Destructive action confirmation | Implemented but unverified; focus/keyboard/cancel tests missing. |
| `components/ui/EmptyState.jsx` | Empty collection states | Implemented but unverified; screen-reader test missing. |
| `components/ui/InlineNotice.jsx` | Inline error/status | Implemented but unverified; announcement semantics need review. |
| `components/ui/Modal.jsx` | Modal interactions | Implemented but unverified; focus trap/escape tests missing. |
| `components/ui/PageHeader.jsx` | Screen header | Implemented but unverified; no isolated UI tests. |
| `components/ui/SectionCard.jsx` | Shared panel | Implemented but unverified; no isolated UI tests. |
| `components/ui/SelectField.jsx` | Custom selection control | Implemented but unverified; keyboard/ARIA tests missing. |

## API endpoint inventory

Endpoint definitions are mapped to controllers/routes. Selected handlers have
been exercised against the isolated test database; each row records the tested
cases and remaining gaps. Auth and workspace authorization still need broader
positive and negative role/resource coverage.

| Route family | Endpoints | Test coverage |
|---|---|---|
| Health | `GET /api/health` | Working and verified on port 5101 and by integration-server readiness check. |
| Auth | `POST /api/auth/signup`, `/login`, `/forgot-password`, `/reset-password`; `GET /me`; `PUT /me`; `POST /logout` | Signup/login/logout, duplicate signup, expiry/revocation, profile and password-reset lifecycle tested on selected API paths; exhaustive session/profile edge cases remain. |
| Organizations | `GET/POST /api/organizations`; `GET/PUT/DELETE /:id`; member list/add/update/remove; invitation list/revoke | Create/persist, outsider read denial, malformed ID, invitation acceptance and membership persistence tested; remaining CRUD and role paths unverified. |
| Invitations | `GET /api/invitations/:token`; accept; accept-and-create-account | Preview, authenticated accept, persisted membership, repeat acceptance, and wrong-account rejection tested; expiry and create-account path remain unverified. |
| Projects | list/create/get/update/delete; member list/add/remove | Create/read/update/archive and member add tested; outsider read/update denial and malformed ID tested. Delete and remaining CRUD unverified. |
| Workflow | status list/create/update/delete/reorder; role-tag list/create/update/delete | Invalid project status is rejected; other workflow routes and persistence remain unverified. |
| Tasks | list/create/get/update/delete; `POST /api/tasks/analyze` | Create/read/update/delete, assignment, status/priority, activity and notification persistence; malformed ID/date/status and outsider/unauthorized access tested. List filters and AI analyze remain unverified. |
| Comments | task comment list/create; delete by comment ID | Create/list/delete and activity persistence tested; assignee/outsider access and unauthorized delete tested. Realtime payload delivery and threading remain unverified. |
| AI | Task chat/history/end/agent; global chat/history/end; close-all; owned session history/recent list/delete | Disposable PostgreSQL tests cover recent listing, owned history and deletion boundaries, close-all history preservation, message cascade deletion, and independent memory retention. Global AI context-bound actions and task-agent destructive confirmation use server-side authorization. Live provider behavior, proposal/approval UI, and idempotent action execution remain gaps. |
| AI memories | list/search/create/get/patch/delete | Isolated PostgreSQL API tests verify unscoped user privacy, organization-member visibility, outsider denials, task-access scoping, owner-only read/update/delete, duplicate suppression, and persisted vectors via deterministic embedding stub. Search-result ranking, content edits/deletes, task/project scope mismatch permutations, and live embedding behavior remain unverified. |
| Knowledge | authenticated search | Blocked on PostgreSQL pgvector and embedding provider configuration. |

## Backend service, data, and agent inventory

| Surface | Implementations | Coverage/status |
|---|---|---|
| Authentication/security middleware | `authMiddleware.js`, `authorizationMiddleware.js` | JWT expiry, token revocation, and auth-version session invalidation are tested; selected route authorization verified; exhaustive role/resource matrix remains. |
| Organization/project/task/comment/workflow controllers | Nine controllers under `Backend/src/controllers/` | Selected auth, workspace, persistence, invalid-input, activity, and notification paths verified; workflow controller and remaining CRUD branches unverified. |
| AI/retrieval/memory/knowledge/email services | Eleven services under `Backend/src/services/` | Memory scope and selected retrieval boundaries pass isolated API tests; tool schema and task-room services have unit tests; many other service branches and live providers remain unverified. |
| Registered task-agent tools | `get_task`, `get_project`, `get_tasks`, `create_task`, `update_task`, `delete_task`, `search_knowledge` in `agentService.js` | Runtime argument schema validation has unit cases for unsupported tool/field, invalid type/enum/length; server-side scoped delete and single-use confirmation are integration-tested. Other tool/provider paths remain unverified. |
| Memory capabilities | Create/list/get/update/delete, similarity retrieval, explicit remember/forget | DB-backed API tests now cover private/org/task visibility, ownership denial, and same-scope deduplication. Search ranking, explicit forget/extraction behavior, and UI journeys remain unverified. |
| SQL entity groups | Account/security (`users`, token tables); workspace/project/task/comment/notification/labels; project workflow/tags/invitations; AI chats/memories; knowledge/vector tables | 001–016 schema applied/replayed on isolated PostgreSQL; tested entities are listed above; AI/memory and unexercised constraints remain unverified. |
| SQL migrations | `001_schema.sql` through `016_repair_auth_version.sql` | All 16 SQL files applied and replayed on a new isolated PostgreSQL database; legacy `knowledge_base` data survived; pgvector verified. The 016 repair migration was additionally applied twice after removing `auth_version` in the disposable DB, preserving an existing fixture account. SQL runner is authoritative; the legacy `pgmigrations` record is not proof of SQL migration application. |

## First-repair focused test mapping

| Test | Required behavior | Status |
|---|---|---|
| `Backend/test/taskRoomAuthorization.test.js` — authorized room | Existing task-access authorizer succeeds before room join. | Passed. |
| Same — forbidden/not found | No room join; identical public error avoids disclosing task existence. | Passed for both 403 and 404. |
| Same — malformed ID | Reject invalid types, malformed/decimal strings, nonpositive values, and unsafe integers before authorization/database call. | Passed. |
| Same — infrastructure failure | Log server-side, avoid join, report explicit generic error to socket. | Passed. |
| Same — leave room | Valid own-room leave works; malformed room ID ignored. | Passed. |
| Same — event-time access revalidation | Recheck every current task-room socket before private comment delivery; remove revoked resource access. | Passed with isolated helper test for one authorized and one revoked socket. |
| Same — token revocation | A private task/comment event disconnects sockets with a revoked/invalidated auth token without delivering the payload. | Passed with isolated helper test and real Socket.IO transport tests for both task and comment events. |
| Task-change payload / notification integration | Assert no task row is exposed; send task-change events only to the authorized audience. | Real transport tests verify ID-only task events and authorization-based audiences; assignment notification persistence is tested, but its socket event lacks a dedicated transport assertion. |
| Task-agent destructive confirmation | First delete request cannot delete; exact action, same user/task, short expiry, single-use jti, and concurrent replay rejection. | Passed in PostgreSQL integration test with isolated provider stub; same-token concurrent requests produce one successful deletion and one denied/not-found response. |
| Agent tool argument schemas | Only registered tool names and schema-defined object fields/types/enums/safe string sizes are accepted. | Passed in `Backend/test/agentToolSecurity.test.js`; tool behavior beyond delete remains unverified. |
| Password reset lifecycle | Enumeration-resistant response, per-email/IP rate limit, hashed tokens, invalid/expired/reused token denial, strong password, session invalidation, and audit digests. | Passed on fresh isolated DB with controlled test email adapter; rate-limit burst verified and no real email provider used. Wrong client-supplied user ID cannot redirect the token's stored target. |
| Task comments privacy integration | Only authorized task-room sockets may receive comment content or deletion IDs. | Real transport tests verify owner/project-admin/assignee delivery, denied roles and operations, guessed-room rejection, and revoked-session suppression. Browser behavior and multi-node transport remain unverified/unsupported. |

## Authorization inventory and exercised boundaries

The backend route inventory is documented in `ARCHITECTURE.md`; the tested
boundaries below are not a claim of exhaustive authorization completion.

| Surface | Existing roles / access policy | Current evidence |
|---|---|---|
| Public auth and invitation entry points | Anonymous signup/login/reset request/reset consumption and invitation preview/acceptance routes; authenticated `/me` and logout. | Signup/login/logout, generic reset response, reset lifecycle, invalid/expired/reused token cases, invitation acceptance tested. Frontend flows and all invitation lifecycle edge cases remain open. |
| Organization records/members/invitations | `owner`, `admin`, `user`; org membership gates private reads; owner/admin role checks are enforced by existing authorization helpers; owner-only actions remain distinct. | Selected owner/member/outsider and invitation cases are covered; complete per-operation role matrix (including admin-vs-owner denials) remains. |
| Projects/workflow configuration | Organization membership and project membership; project `project_admin` manages sensitive project operations; project `member` access is limited. Project creator is typically made project admin. | Selected cross-workspace access and project persistence/update/archive tests; each workflow/member CRUD role combination remains open. |
| Tasks/comments/activity | Task access is organization owner, project admin, or assigned project member; creator status alone does not grant access. Comments have no edit route and follow task access. | Selected API and actual Socket.IO tests cover owner/project-admin/assignee access, denied ordinary org/project members, creator-only status, outsider, unauthorized mutations, session revocation, and deletion membership race. Nested replies and full role matrix remain. |
| AI task-agent tools | Explicit seven-tool registry; task scope is server-derived; mutations reauthorize; destructive delete requires a user/task/action-bound single-use confirmation. | Tool argument checks and delete success/denials/replay covered; other tool paths, adversarial prompt injection tests, and live provider behavior remain. |
| Socket.IO | Authenticated user rooms; task room joins require task access; task-change events go only to authorized user sockets; comment delivery rechecks session and task access for each task-room socket. Task deletion recipients are selected under task/project/organization and membership row locks in the deletion transaction. | Real transport tests cover task/comment delivery, owner/project-admin/assignee roles, denied organization/project members and outsiders, creator-only denial, guessed-room joins, unauthorized mutations, reassignment/downgrade, revocation, and membership-change/delete race. Multi-node delivery is unsupported and guarded by the instance-count setting. |
| Unauthenticated private access | Private HTTP routes require JWT auth; anonymous users have only intentional public auth/invitation endpoints. | Anonymous requests to selected private route families return 401; not every route has an individual anonymous regression. |

## Remaining critical journey gaps

1. Complete organization/project/workflow CRUD and exhaustive cross-org/role
   matrix.
2. Signup → login → reset/session rotation → invitation/membership → project →
   task/assignment → comment → logout/revocation is covered for selected API
   flows; add remaining membership lifecycle and role combinations.
3. Select and test a distributed Socket.IO adapter before supporting multiple
   backend instances; also expand beyond the existing task/comment role matrix.
4. AI read-only tool call, authorized mutations, rejected tool calls, retrieved
   prompt-injection behavior, and provider failures.
5. Memory visibility across user/org/project/task scopes and duplicate writes.
6. Remaining invitation expiry/create-account lifecycle; live email provider
   delivery remains external and untested.
7. Frontend keyboard, accessibility semantics, mobile/tablet/desktop layouts,
   and visible control behavior.
