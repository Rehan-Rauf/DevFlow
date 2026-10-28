# DevFlow Implementation Plan

Updated: 2026-10-11

## Delivery rules

- Work in the existing React/Vite, Express/Socket.IO, and PostgreSQL stack.
- Keep every result labeled as verified only after executing its relevant test,
  build, database command, or browser check.
- Run database-changing checks only against an explicitly disposable/test
  database. Do not print or check in environment secrets.
- Each phase ends with focused regression tests, a security/accessibility
  review, and updates to the audit and coverage matrix.

## Release gates and readiness tiers

| Readiness tier | Status | Required evidence |
|---|---|---|
| Internal development | VERIFIED | Backend/frontend tests pass; permissions and auth/session protections are exercised in disposable DB and Socket.IO tests. |
| Private beta with invited users | PARTIALLY VERIFIED | Strong local security validation exists, but browser automation, live AI-provider checks, and deploy-time operational validations are not complete. |
| Public commercial launch | NOT VERIFIED | Requires production deployment evidence, secure token strategy, backup/restore validation, incident procedures, and broader role-matrix coverage. |

### Browser automation and secure-token status

A browser automation tool is not currently configured in the frontend package,
so the critical login/task journeys are not yet executed as real browser tests.
The current app remains on a bearer-token design stored in `localStorage` and
is therefore not considered production-safe without a dedicated browser-security
hardening plan. The next phase must either perform a single coherent cookie
migration or explicitly accept the current risk with documented mitigations and
a beta-only rollout. No partial migration should be attempted while the API
expects bearer headers and the Socket.IO auth flow still reads the same token.

## Phases

| Phase | Scope | State | Exit criteria |
|---|---|---|---|
| 0. Repository audit | Inventory routes, screens, components, entities, services, config, existing checks, and defects. | Complete; see `PROJECT_AUDIT.md`. | Real file inventory and honest external-service limits recorded. |
| 1. Realtime access repair | Authorize task-room joins, minimize task-change payloads, restrict task events to authorized recipients, scope assignment notifications, add regression tests. | Complete for selected task/comment transport cases, role checks, session revocation, and transactional deletion audience selection. Multi-node operation remains unsupported; the default adapter is process-local and a declared instance count above one is rejected. | Backend unit and disposable PostgreSQL/Socket.IO client tests pass; frontend production build passes. |
| 2. Startup and database reproducibility | Verify health endpoint/configuration and run ordered migrations against disposable PostgreSQL. | Complete for the authoritative SQL runner; node-pg-migrate script/config/dependency retired, historical empty migration retained. | All 16 SQL files applied and replayed; pgvector presence and legacy-row preservation observed on fresh isolated DB. |
| 3. Authentication and workspace authorization | Test signup/login/logout/reset, revocation, organization/project roles, task/comment access, invitation boundaries. | In progress: password reset/rate limit/session rotation and selected member/invitation/workspace checks verified; exhaustive role matrix remains. | Expand allowed/denied tests for every route/resource and role combination. |
| 4. Core project workflows | Test organization/project/task CRUD, comments, statuses, role tags, assignment, notifications, and persistence. | In progress: project/task/comment create/read/update/delete, archive, activity and notification persistence are tested; not all APIs or frontend flows. | Cover remaining CRUD/workflow APIs and UI journeys. |
| 5. AI tools, retrieval, and memory | Test tool allowlisting/argument guards/confirmation, authorized retrieval, memory scoping/deduplication, provider errors. | In progress: Global AI context-bound actions, explicit-intent checks, memory controls, close-all, recent-session listing, owned history retrieval/deletion, and memory-preserving conversation deletion are implemented. Disposable PostgreSQL tests cover list/read ownership and deletion behavior; live provider behavior and several AI security/reliability cases remain unverified. | Add explicit review/approval for global consequential writes, idempotency, and remaining provider/retrieval/memory security tests. |
| 6. Frontend journeys and accessibility | Cover auth, organizations, projects, tasks, AI/memory, errors, keyboard and responsive behavior. | In progress: Vitest component/API tests and a mocked Playwright Chromium suite are configured; auth/task/modal Playwright journeys passed, as did Global AI history/close-all component tests. These do not exercise the live backend or all browser journeys. | Extend browser coverage to real disposable API workflows, workspace isolation, session expiry, and the Global AI action/history journeys. |
| 7. Suggestions and remaining gaps | Implement proactive suggestions using real project data, duplicate prevention, and inspect/dismiss/accept/execute flow. | Pending | Persisted, authorized lifecycle and tests; user requirements already define the requested lifecycle. |
| 8. Deployment and release checks | Document exact Node/PostgreSQL/pgvector/provider requirements; add deployment files only if appropriate; run release checks. | Pending | Reproducible setup, security checks, builds, tests, and explicit remaining risks. |

## Global AI conversation-history continuation

The existing Global AI panel now exposes an owned-session history list, loads a
selected saved conversation, keeps ended sessions read-only, and offers a
confirmed per-conversation delete. Conversation deletion removes its messages
without deleting the separately stored user memories. The recent-chat SQL
sorts on the selected last-message timestamp. Backend handlers are exported as
route-level functions, and PostgreSQL tests exercise recent listing, owner-only
history retrieval/deletion, close-all preservation, and message/memory cleanup.

Observed verification for this continuation:

- `Backend`: `npm test` — 23 passed, 0 failed, 1 opt-in PostgreSQL test skipped
  because no integration DB was configured for that invocation.
- `Backend`: `npm run test:integration:isolated` — 5 passed, 0 failed/skipped;
  the exact loopback-only disposable database was dropped afterward.
- `Frontend`: `npm test` — 11 passed across 5 files.
- `Frontend`: `npm run build` — passed; 119 modules transformed. Vite emitted
  a CJS API deprecation notice and CSS minifier syntax warning at `<stdin>:3034`;
  bundle generation succeeded, but the warning source was not traced in this task.
- `Frontend`: `npm run test:e2e -- --output
  "C:\Users\pc\AppData\Local\Temp\devflow-global-agent-e2e"` — 4 mocked
  Chromium journeys passed. These tests intercept API requests and do not
  verify a live backend or production deployment.

No developer database was modified. The broader workflow is not production
ready: the bearer token remains in `localStorage`, and live provider/deployment
behavior remains unverified.

## Global AI consequential-action approval — 2026-10-12

The existing Global AI write tools now create persistent, expiring proposals
with validated arguments, exact target metadata, before/after preview, and
server-generated summaries. The chat renders accessible review cards with
Approve and Cancel controls. Approval rechecks ownership and current resource
permissions, then atomically records the permitted task/project/organization
change and its result. Repeated and concurrent approvals are serialized by
PostgreSQL row locks; replay returns the stored result rather than repeating
the side effect. Request IDs are unique per user and cannot be reused for a
different operation, argument set, or target. Closing a chat does not alter
proposal state.

The currently supported proposal operations are organization creation, project
creation, task creation, and update of the page-context task. Other write
operations are not present in the Global AI tool registry and remain
unsupported. The lifecycle does not promise exactly-once behavior outside the
transactional database boundary; unknown outcomes are checked against the
persisted proposal before retrying. The existing localStorage bearer-token
risk remains and was not changed.

Observed verification for this milestone:

- `Backend`: `npm test` — 23 passed, 0 failed, 1 opt-in PostgreSQL integration
  test skipped because no test database was configured for this invocation.
- `Backend`: `npm run test:integration:isolated` — 5 passed, 0 failed/skipped
  against a fresh loopback-only disposable PostgreSQL database; migration 017
  was applied and replayed there, a proxied response was dropped after a task
  approval committed, retry returned the stored result without a duplicate,
  and the exact database was dropped afterward.
- `Frontend`: `npm test` — 14 passed across 5 files, including proposal review,
  server-confirmed success, cancellation, and pending proposal rediscovery.
- `Frontend`: `npm run build` — succeeded; Vite transformed 119 modules. It
  emitted a CSS minifier warning (`Unexpected "}"` at generated input line
  3117) and the Vite CJS API deprecation notice.
- `Frontend`: `npm run test:e2e -- --output
  "C:\Users\pc\AppData\Local\Temp\devflow-global-action-e2e"` — 4 Chromium
  tests passed. The existing browser tests mock API calls and do not exercise
  the approval flow against the live backend.
- Developer databases were not modified. Live OpenRouter calls, deployment
  controls, and public-launch readiness remain unverified.

## First repair — implementation record

Files changed:

- `Backend/src/services/taskRoomAuthorization.js`: validates task IDs,
  authorizes room subscriptions via the existing task access guard, avoids room
  joins on access/infrastructure errors, and reports subscription errors.
- `Backend/src/server.js`: uses the reusable room handler and existing
  `assertTaskAccess` authorization path.
- `Backend/src/controllers/taskController.js`: removes full task rows from
  global task-change events and directs task-assignment notifications to the
  recipient's authenticated user room.
- `Frontend/src/pages/TaskDetail.jsx`: displays task-room subscription errors.
- `Backend/test/taskRoomAuthorization.test.js`: covers authorized, forbidden,
  nonexistent, invalid-ID, infrastructure-error, and leave-room behavior.
- `Backend/package.json`: adds `npm test` using Node's built-in test runner.

The task detail room is now the only channel for full comment payloads and can
only be joined after access authorization. Existing list/detail clients still
receive global task-change invalidation events, but those events contain only
the task ID, not its title, description, or other record fields.

## Phase 2 implementation and verification

The database-backed API suite exposed and repaired two defects: the task
creation access query omitted its organization-membership result, and assigned
task reads compared PostgreSQL `BIGINT` strings strictly against numeric JWT
IDs. Task create/update and comment create/delete now persist activity records
within their mutation transactions.

Migration `003_fix_knowledge_schema.sql` no longer drops the legacy
`knowledge_base` table when migrations are replayed. Migration 014 serializes
organization-admin-limit checks using a transaction-scoped advisory lock. Core
project/task request validation now rejects malformed IDs and invalid project
statuses/task dates before unsafe database operations.

Against the isolated PostgreSQL 18.4 database `devflow_phase2_test_20261010`,
the full 001–014 SQL migration set was applied from scratch and replayed. The
integration suite confirmed migration replay preserves a legacy knowledge row,
pgvector is installed, signup/login/logout and token expiry/revocation work,
invitation acceptance persists, selected cross-workspace requests are denied,
and project, task, comment, task activity, and assignment-notification writes
persist. A forced task-activity insert failure proved task creation rolls back
atomically. Concurrent admin membership inserts allowed exactly three admins.
Never run these tests against production; the integration suite requires an
explicitly named DevFlow test database.

Continuing into the next high-priority AI phase exposed a destructive-action
gap: the task agent's delete tool called the database deletion service without
checking its confirmation context. The tool now returns an explicit
confirmation-required result until the route validates a short-lived token
bound to the same user and task. The isolated integration test mocks only the
OpenRouter HTTP response and checks unauthenticated-to-the-tool attempts,
malformed, wrong-user and wrong-task tokens, and successful confirmation
persistence. Live provider behavior and all other agent/memory cases remain
unverified.

Commands actually run after Phase 2 changes:

- `npm test` from `Backend/`: 16 passed, 0 failed, 1 database suite skipped
  because this run did not set the integration database environment variable.
- `npm run db:migrate` from `Backend/` against the empty disposable database:
  all 14 migrations passed in filename order.
- `DEVFLOW_TEST_DATABASE_NAME=devflow_phase2_test_20261010 npm run test:integration`
  from `Backend/`: 4 passed, 0 failed.
- `npm run build` from `Frontend/`: passed; Vite transformed 119 modules.
- `node --check` on changed backend source/test files: passed.
- `git diff --check`: passed.

No database credentials or values from the ignored environment file are
documented. At the Phase 2 handoff, OpenRouter, SendGrid, memory/AI
end-to-end behavior, frontend journeys, password reset, and the untested
authorization combinations remained unverified. Phase 3A evidence and the
remaining gaps are recorded below.

## Phase 3A execution record — auth/session, agent, and realtime security

The repository's existing roles were retained: organization `owner`, `admin`,
and `user`; project `project_admin` and `member`; system `admin` and `user`.
There is no dedicated guest role. Owners/admins are not treated as project
admins by implication. Task access continues to use project membership,
organization ownership, and assignment rules in the existing services.

Password reset now has an atomic per-email (3/hour) and per-IP (20/hour) limit,
generic responses for registered and unregistered addresses, transactionally
replaced reset tokens, SHA-256 token storage, one-hour expiry, row-locked
single-use consumption, password policy/hash enforcement, audit events with
HMAC digests rather than raw email/IP/token values, and user `auth_version`
rotation. HTTP and Socket.IO token checks reject old sessions after reset.
Automated tests use a test-only email capture adapter and never call SendGrid.

Task-agent tool arguments are checked at runtime against the explicit registered
tool schema (including unknown-property, type, enum, and length checks); tool
outcomes are audited without recording arguments. Delete approval is bound to
user, exact task/action, JWT expiry, and UUID jti. A transactionally inserted
unique jti prevents concurrent/repeated use, and server-side role checks are
repeated under task/membership row locks immediately before deletion. The
approved request executes deletion directly rather than asking the model to
choose a tool again. Agent prompts identify retrieved task/comment/knowledge
content as untrusted; enforcement still depends on server-side scopes and
permissions, not model compliance.

The earlier security review found that authorized task-room sockets stayed in
rooms after access or token revocation. Every private comment event now
revalidates each socket's token and task access, removes stale room membership,
and disconnects revoked-token sockets. Unit regressions cover allowed delivery,
access removal, and token revocation. Actual networked Socket.IO delivery,
multi-node adapter behavior, and membership-change event integration remain
unverified.

Migration choice: `npm run db:migrate` is the sole supported path and runs the
ordered SQL migrations. The node-pg-migrate dependency, config, and command
were removed; the empty historical JS migration file remains untouched to
avoid deleting a possibly recorded artifact. No deployed database was
inspected, so operators must verify deployed schema/history before making
production changes. Fresh DB verification creates only a random
`devflow_test_phase3a_*` local database and drops that exact database afterward.

Observed Phase 3A checks:

- `npm test` from `Backend/`: 19 passed, 0 failed; the DB suite skipped when no
  explicit test DB variable was present.
- `npm run test:integration:isolated`: fresh PostgreSQL database created on
  loopback, all 16 SQL migrations applied, integration suite passed,
  migration replay and pgvector/legacy-row checks passed, exact database
  dropped.
- `npm run build` from `Frontend/`: passed (Vite transformed 119 modules).
- `node --check` on changed backend files: passed.
- `git diff --check`: passed.
- `npm audit`: 0 vulnerabilities after compatible production dependency
  updates and removal of the vulnerable development watcher in favor of Node's
  built-in `--watch` mode.

Authorization is not declared complete. Private HTTP route families and
Socket.IO handlers were inventoried; tests cover selected anonymous,
cross-workspace, insufficient-role, invalid-ID, missing-resource, persistence,
and denied mutation cases. A route-by-route role/resource matrix and broad
allowed/denied API coverage are still outstanding. Live OpenRouter/SendGrid,
all other AI tools, memory ranking and explicit forget/extraction behavior, browser-based E2E, frontend
accessibility/responsive checks, and suggestion lifecycle remain incomplete.

## Automated test suite audit — 2026-10-10

`docs/TEST_SUITE_AUDIT.md` inventories the Node built-in backend tests,
integration fixtures, manual service probes, API and component coverage, and
remaining gaps. `npm run test:unit` now selects the three isolated unit files.
The memory-scope integration cases exposed and fixed a strict PostgreSQL
`BIGINT` text-versus-number comparison when validating a task memory's
matching project/organization IDs. The isolated suite now tests successful
private, organization, and task-scoped access; unrelated-user/outsider denial;
owner-only CRUD; duplicate suppression; and task scope mismatch rejection.
It uses deterministic test-only OpenRouter chat/embedding responses; no live
provider was exercised.

## Phase 1 execution record (historical)

Commands actually executed:

- `npm run build` from `Frontend/`: passed before and after edits (Vite 6.4.3;
  119 modules transformed).
- `npm run` from `Backend/`: listed the pre-repair scripts and confirmed no
  test script was present at that time.
- Root `npm run build` and `npm test`: not usable; npm reported `ENOENT` for
  root `package.json`. These are not valid app checks.
- `npm test` from `Backend/`: passed, 15 tests, 0 failures.
- `node --check` on the modified backend server, room authorization service,
  task controller, and regression test: passed.
- `git diff --check`: passed.
- `$env:PORT='5101'; npm start` from `Backend/`, followed by
  `GET http://localhost:5101/api/health`: server started and returned
  `{"success":true,"message":"DevFlow API is running."}`. The default port 5001
  was already in use, so the new process was tested on the alternate port.

At the time of this Phase 1 check, no database migrations or database-backed
endpoints had been run; see the Phase 2 verification above for later isolated
database evidence.

## Phase 6 realtime security execution record

- Comment visibility was confirmed from the API and shared task-access guard:
  organization owners, project admins, and assigned project members are
  authorized. Ordinary organization members, unassigned project members, and
  creator status alone do not grant access. No comment-edit route exists.
- Actual Socket.IO clients verified authorized `comment_added` and
  `comment_deleted` delivery, denied room joins and API operations, absence of
  protected events for unauthorized users, and session-revocation behavior.
- The deletion audience race was reproduced in a disposable database by
  holding a project-role downgrade open while deletion ran. Deletion now locks
  the task/project/organization and relevant membership rows while capturing
  the recipient set and deleting in one transaction; the test observed the
  lock wait and verified the downgraded member received no deletion event.
- The default Socket.IO adapter and current delivery code are process-local.
  `SOCKET_IO_INSTANCE_COUNT` rejects a declared count above one; no distributed
  adapter or multi-node test was added.
- `npm test`: 21 passed, 0 failed, 1 opt-in PostgreSQL test skipped.
- `npm run test:integration:isolated`: 5 reported tests passed on disposable
  `devflow_test_phase3a_995ced9f`, then dropped.
- `npm run build`: passed with 119 modules transformed.
- No development database was changed.

## Startup configuration repair

Added secret-free `Backend/.env.example` and `Frontend/.env.example` files,
covering the variables read by the backend and frontend. Updated the root,
backend, and frontend READMEs so their copy/configuration instructions match
the files that now exist. Confirmed both example files are not excluded by the
repository's ignore rules and contain placeholders/local endpoints rather than
provider credentials. No dependency or runtime code changed in this repair.

## Login schema repair — 2026-10-10

`authController.js` selects `users.auth_version` during login/signup and
organization-member login; `authMiddleware.js` compares it to the JWT
`authVersion`; password reset increments it to invalidate existing sessions.
The checked-in base schema does not define this column, while migration 015
does. The configured local database `cms/public` lacked the column and had a
legacy `pgmigrations` entry for `initial-schema` only, consistent with the SQL
migrations not having been applied there. The live API process was correlated
to that same PostgreSQL database using its active socket's client port.

Added forward-only idempotent migration
`Backend/src/db/migrations/016_repair_auth_version.sql`. It adds
`public.users.auth_version INTEGER NOT NULL DEFAULT 0` and the nonnegative
check constraint without replacing user rows. The authoritative SQL runner
now accepts one validated migration filename, allowing the reviewed repair
without replaying unrelated migrations:
`npm run db:migrate -- 016_repair_auth_version.sql`.

On disposable PostgreSQL, migration 016 was run twice after simulating an old
schema with an existing account. The account/password remained intact, its
version defaulted to 0, API login succeeded, and incrementing its version
invalidated the issued session. All 16 migrations passed on the fresh isolated
database. After the user confirmed `cms/public` as the intended development
target and confirmed a current backup, the guarded runner applied only
`016_repair_auth_version.sql` to PostgreSQL `::1:5432`, database `cms`, schema
`public`. Verification showed the column as `INTEGER NOT NULL DEFAULT 0` and
the existing user count unchanged at 31. Live API signup/login/GET `/me`
succeeded; incrementing the test user's version invalidated that session. The
exact temporary account was deleted afterward.
