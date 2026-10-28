# Backend

## Install

npm install

## Configure

Copy `.env.example` to `.env`, then set `DB_PASSWORD` and replace the example
`JWT_SECRET` with a unique random value. Keep `.env` out of version control.
OpenRouter and SendGrid variables are optional and only needed for those
provider-backed features.

## Create schema

npm run db:migrate

`npm run db:migrate` is the sole supported migration command. It applies the
ordered, replay-safe SQL files in `src/db/migrations/`. The former
`node-pg-migrate` runner and configuration have been retired; the empty
historical file under `migrations/` is retained rather than deleting or
renaming a potentially recorded migration artifact. The SQL runner has no
migration ledger and replays the ordered SQL set. Existing `pgmigrations`
metadata is historical node-pg-migrate state, not proof that SQL migrations
were applied. Do not run migrations against a production database without
first validating the target and reviewing the SQL.
The runner can also apply one exact migration filename when a reviewed,
forward-only repair is appropriate:

```powershell
$env:DEVFLOW_EXPECTED_DATABASE_NAME = "cms"
$env:DEVFLOW_EXPECTED_SCHEMA_NAME = "public"
$env:DEVFLOW_EXPECTED_DATABASE_ADDRESS = "::1"
$env:DEVFLOW_EXPECTED_DATABASE_PORT = "5432"
npm run db:migrate -- 016_repair_auth_version.sql
```

This targeted command still uses the same SQL migration runner and validates
that the filename exists in `src/db/migrations/`. When expected target
variables are set, the runner checks server address, port, database, and
schema identity before executing any migration.

## Run

npm run dev

Server: http://localhost:5001

The development script uses Node's built-in `--watch` mode and was verified
with Node 24.19.0. The repository does not declare a minimum supported Node
version.

All database access uses `pg` with parameterized PostgreSQL queries.

## Test

Run backend unit tests with:

```powershell
Set-Location Backend
npm run test:unit
npm test
```

`npm test` runs Node's built-in test discovery from `Backend/`; it includes
unit tests and reports the database integration suite as skipped unless an
explicit test database is configured. No Jest/Vitest/Mocha dependency is used.

The PostgreSQL API integration suite can run against a pre-created disposable
database whose name starts with `devflow_test_` or `devflow_phase2_test_`.
Configure local PostgreSQL in `.env`, create the test database, and apply the
schema with `npm run db:migrate` before running:

```powershell
Set-Location Backend
$env:DEVFLOW_TEST_DATABASE_NAME = "devflow_test_local"
npm run test:integration
```

For a fresh, disposable local database, use:

```powershell
Set-Location Backend
npm run test:integration:isolated
```

The helper refuses non-loopback PostgreSQL hosts, creates a uniquely named
`devflow_test_phase3a_*` database, runs the SQL migrations and integration
suite, then drops only that exact database. The normal integration suite also
checks the selected database name before connecting and overrides `DB_NAME`
for its API process. Never point it at a production or shared database. Its
task-agent deletion case uses a test-only OpenRouter stub; it does not verify
live provider behavior. Memory integration checks also use a deterministic
test-only embedding response; they verify persistence and scope boundaries,
not live embedding-provider behavior.

There is currently no browser-test framework or browser suite. Do not treat
the production build as browser workflow coverage; browser automation remains
pending until a single suitable framework is integrated.
