const test = require("node:test");
const assert = require("node:assert/strict");

const configuredTestDatabase = process.env.DEVFLOW_TEST_DATABASE_NAME;

test(
  "PostgreSQL-backed authentication, workspace isolation, invitation, and task workflows",
  { skip: !configuredTestDatabase && "Set DEVFLOW_TEST_DATABASE_NAME to an isolated migrated test database." },
  async (t) => {
    assert.match(
      configuredTestDatabase,
      /^devflow_(?:test|phase2_test)_[a-z0-9_]+$/i,
      "Integration tests only run against a database explicitly named as a DevFlow test database.",
    );

    require("dotenv").config({ path: require("path").resolve(__dirname, "../.env") });
    process.env.DB_NAME = configuredTestDatabase;
    process.env.JWT_SECRET = "devflow-integration-tests-only-secret";
    process.env.OPENROUTER_API_KEY = "";
    process.env.SENDGRID_API_KEY = "";
    process.env.SENDGRID_FROM_EMAIL = "";

    const crypto = require("node:crypto");
    const fs = require("node:fs/promises");
    const http = require("node:http");
    const net = require("node:net");
    const os = require("node:os");
    const path = require("node:path");
    const { spawn, spawnSync } = require("node:child_process");
    const { io: createSocketClient } = require("socket.io-client");
    const pool = require("../src/config/database");
    const fixtureEmails = [];
    const migrationFixtureEmails = [];
    const organizationIds = [];
    const revokedTokens = [];
    const resetAuditSubjects = [];
    const resetRateEmailHashes = [];
    const socketClients = [];
    const emailCapturePath = path.join(
      os.tmpdir(),
      `devflow-test-email-${crypto.randomUUID()}.jsonl`,
    );
    let legacyKnowledgeId;
    let serverProcess;
    let baseUrl;

    t.after(async () => {
      await Promise.all(socketClients.map((socket) => new Promise((resolve) => {
        if (!socket.connected) {
          socket.disconnect();
          resolve();
          return;
        }
        socket.once("disconnect", resolve);
        socket.disconnect();
      })));
      if (serverProcess && serverProcess.exitCode === null) {
        serverProcess.kill();
        await new Promise((resolve) => serverProcess.once("exit", resolve));
      }
      await fs.rm(emailCapturePath, { force: true });

      try {
        const cleanupEmails = [...fixtureEmails, ...migrationFixtureEmails];
        if (cleanupEmails.length) {
          const fixtureUsers = await pool.query(
            "SELECT id FROM users WHERE email = ANY($1::text[])",
            [cleanupEmails],
          );
          const fixtureUserIds = fixtureUsers.rows.map((row) => row.id);
          if (fixtureUserIds.length) {
            await pool.query(
              "DELETE FROM task_agent_tool_events WHERE user_id = ANY($1::bigint[])",
              [fixtureUserIds],
            );
            await pool.query(
              "DELETE FROM auth_security_events WHERE user_id = ANY($1::bigint[])",
              [fixtureUserIds],
            );
          }
        }
        if (resetAuditSubjects.length) {
          const sourceHashes = await pool.query(
            `SELECT DISTINCT source_hash FROM auth_security_events
             WHERE subject_hash = ANY($1::char(64)[]) AND source_hash IS NOT NULL`,
            [resetAuditSubjects],
          );
          await pool.query(
            "DELETE FROM auth_security_events WHERE subject_hash = ANY($1::char(64)[])",
            [resetAuditSubjects],
          );
          await pool.query(
            `DELETE FROM password_reset_rate_limits
             WHERE (bucket = 'email' AND key_hash = ANY($1::char(64)[]))
                OR (bucket = 'ip' AND key_hash = ANY($2::char(64)[]))`,
            [resetRateEmailHashes, sourceHashes.rows.map((row) => row.source_hash)],
          );
        }
        if (legacyKnowledgeId) {
          await pool.query("DELETE FROM knowledge_base WHERE id = $1", [legacyKnowledgeId]);
        }
        if (organizationIds.length) {
          await pool.query(
            "DELETE FROM organizations WHERE id = ANY($1::bigint[])",
            [organizationIds],
          );
        }
        if (cleanupEmails.length) {
          await pool.query(
            "DELETE FROM users WHERE email = ANY($1::text[])",
            [cleanupEmails],
          );
        }
        if (revokedTokens.length) {
          const { hashToken } = require("../src/middleware/authMiddleware");
          await pool.query(
            "DELETE FROM revoked_auth_tokens WHERE token_hash = ANY($1::char(64)[])",
            [revokedTokens.map(hashToken)],
          );
        }
      } finally {
        await pool.end();
      }
    });

    const database = await pool.query("SELECT current_database() AS name");
    assert.equal(database.rows[0].name, configuredTestDatabase);
    assert.equal(
      (await pool.query("SELECT 1 FROM pg_extension WHERE extname = 'vector'")).rowCount,
      1,
      "The database must have pgvector installed before integration tests run.",
    );

    const legacyKnowledge = await pool.query(
      `INSERT INTO knowledge_base (entity_type, entity_id, content)
       VALUES ('integration-test', 1, 'preserve this legacy record')
       RETURNING id`,
    );
    legacyKnowledgeId = legacyKnowledge.rows[0].id;
    const migrationRun = spawnSync(
      process.execPath,
      ["src/db/migrate.js"],
      {
        cwd: path.resolve(__dirname, ".."),
        env: {
          ...process.env,
          DB_NAME: configuredTestDatabase,
          DEVFLOW_EXPECTED_DATABASE_NAME: configuredTestDatabase,
          DEVFLOW_EXPECTED_SCHEMA_NAME: "public",
        },
        encoding: "utf8",
        timeout: 120_000,
      },
    );
    assert.equal(
      migrationRun.status,
      0,
      `Repeat migration failed: ${migrationRun.stderr || migrationRun.stdout}`,
    );
    const preservedKnowledge = await pool.query(
      "SELECT content FROM knowledge_base WHERE id = $1",
      [legacyKnowledgeId],
    );
    assert.equal(preservedKnowledge.rows[0].content, "preserve this legacy record");

    const migrationFixtureEmail = `devflow-auth-migration-${crypto.randomUUID()}@example.test`;
    migrationFixtureEmails.push(migrationFixtureEmail);
    const migrationFixturePassword = "Existing-Test-Password-456!";
    const migrationFixtureHash = await require("bcryptjs").hash(migrationFixturePassword, 4);
    const migrationFixture = await pool.query(
      `INSERT INTO public.users (name, email, password)
       VALUES ('Existing migration fixture', $1, $2)
       RETURNING id`,
      [migrationFixtureEmail, migrationFixtureHash],
    );
    await pool.query(
      "ALTER TABLE public.users DROP CONSTRAINT IF EXISTS users_auth_version_nonnegative",
    );
    await pool.query("ALTER TABLE public.users DROP COLUMN IF EXISTS auth_version");
    for (let attempt = 0; attempt < 2; attempt += 1) {
      const repairRun = spawnSync(
        process.execPath,
        ["src/db/migrate.js", "016_repair_auth_version.sql"],
        {
          cwd: path.resolve(__dirname, ".."),
          env: {
            ...process.env,
            DB_NAME: configuredTestDatabase,
            DEVFLOW_EXPECTED_DATABASE_NAME: configuredTestDatabase,
            DEVFLOW_EXPECTED_SCHEMA_NAME: "public",
          },
          encoding: "utf8",
          timeout: 120_000,
        },
      );
      assert.equal(
        repairRun.status,
        0,
        `Targeted auth-version migration failed: ${repairRun.stderr || repairRun.stdout}`,
      );
    }

    const migratedFixture = await pool.query(
      `SELECT id, email, password, status, auth_version
       FROM public.users WHERE id = $1`,
      [migrationFixture.rows[0].id],
    );
    assert.equal(migratedFixture.rowCount, 1, "The migration must preserve existing users.");
    assert.equal(migratedFixture.rows[0].email, migrationFixtureEmail);
    assert.equal(migratedFixture.rows[0].password, migrationFixtureHash);
    assert.equal(migratedFixture.rows[0].status, "active");
    assert.equal(migratedFixture.rows[0].auth_version, 0);

    const authVersionMetadata = await pool.query(
      `SELECT data_type, column_default, is_nullable
       FROM information_schema.columns
       WHERE table_schema = 'public'
         AND table_name = 'users'
         AND column_name = 'auth_version'`,
    );
    assert.deepEqual(authVersionMetadata.rows[0], {
      data_type: "integer",
      column_default: "0",
      is_nullable: "NO",
    });

    const port = await new Promise((resolve, reject) => {
      const listener = net.createServer();
      listener.once("error", reject);
      listener.listen(0, "127.0.0.1", () => {
        const { port: availablePort } = listener.address();
        listener.close((error) => error ? reject(error) : resolve(availablePort));
      });
    });

    serverProcess = spawn(
      process.execPath,
      ["--require", path.resolve(__dirname, "../test-support/mockOpenRouter.js"), "src/server.js"],
      {
      cwd: path.resolve(__dirname, ".."),
      env: {
        ...process.env,
        DB_NAME: configuredTestDatabase,
        DEVFLOW_TEST_MOCK_OPENROUTER: "1",
        DEVFLOW_TEST_EMAIL_CAPTURE_PATH: emailCapturePath,
        NODE_ENV: "test",
        OPENROUTER_API_KEY: "integration-test-placeholder",
        PORT: String(port),
      },
      stdio: ["ignore", "pipe", "pipe"],
      },
    );

    let serverOutput = "";
    serverProcess.stdout.on("data", (chunk) => { serverOutput += chunk.toString(); });
    serverProcess.stderr.on("data", (chunk) => { serverOutput += chunk.toString(); });
    baseUrl = `http://127.0.0.1:${port}/api`;

    let ready = false;
    for (let attempt = 0; attempt < 80; attempt += 1) {
      if (serverProcess.exitCode !== null) break;
      try {
        const response = await fetch(`${baseUrl}/health`);
        if (response.ok) {
          ready = true;
          break;
        }
      } catch {
        await new Promise((resolve) => setTimeout(resolve, 100));
      }
    }
    assert.ok(ready, `Test API failed to start: ${serverOutput.slice(-2000)}`);

    async function api(route, { method = "GET", token, body } = {}) {
      const response = await fetch(`${baseUrl}${route}`, {
        method,
        headers: {
          ...(token ? { Authorization: `Bearer ${token}` } : {}),
          ...(body ? { "Content-Type": "application/json" } : {}),
        },
        ...(body ? { body: JSON.stringify(body) } : {}),
      });
      const payload = await response.json();
      return { status: response.status, payload };
    }

    function connectSocket(token) {
      const socket = createSocketClient(baseUrl.replace(/\/api$/, ""), {
        auth: token ? { token } : {},
        autoConnect: false,
        reconnection: false,
        timeout: 5000,
        transports: ["websocket"],
      });
      socketClients.push(socket);
      return new Promise((resolve, reject) => {
        socket.once("connect", () => resolve(socket));
        socket.once("connect_error", (error) => {
          socket.disconnect();
          reject(error);
        });
        socket.connect();
      });
    }

    function waitForCount(readCount, expected, label) {
      return new Promise((resolve, reject) => {
        const deadline = Date.now() + 5000;
        const check = () => {
          if (readCount() >= expected) return resolve();
          if (Date.now() >= deadline) return reject(new Error(`Timed out waiting for ${label}.`));
          setTimeout(check, 20);
        };
        check();
      });
    }

    async function waitForDatabaseLock(queryFragment, label) {
      const deadline = Date.now() + 5000;
      while (Date.now() < deadline) {
        const result = await pool.query(
          `SELECT 1
           FROM pg_stat_activity
           WHERE datname = current_database()
             AND wait_event_type = 'Lock'
             AND query LIKE $1
           LIMIT 1`,
          [`%${queryFragment}%`],
        );
        if (result.rowCount) return;
        await new Promise((resolve) => setTimeout(resolve, 25));
      }
      throw new Error(`Timed out waiting for ${label}.`);
    }

    const wait = (milliseconds) => new Promise((resolve) => setTimeout(resolve, milliseconds));

    async function signup(label) {
      const email = `devflow-${label}-${crypto.randomUUID()}@example.test`;
      fixtureEmails.push(email);
      const response = await api("/auth/signup", {
        method: "POST",
        body: {
          name: `Integration ${label}`,
          email,
          password: "Test-Password-123!",
        },
      });
      assert.equal(response.status, 201, JSON.stringify(response.payload));
      return { email, ...response.payload.data };
    }

    await t.test("auth-version migration preserves existing users and login/session checks", async () => {
      const invalidCredentials = await api("/auth/login", {
        method: "POST",
        body: {
          email: migrationFixtureEmail,
          password: "Wrong-Test-Password-789!",
        },
      });
      assert.equal(invalidCredentials.status, 401);
      assert.equal(invalidCredentials.payload.message, "Invalid email or password.");

      const login = await api("/auth/login", {
        method: "POST",
        body: {
          email: migrationFixtureEmail,
          password: migrationFixturePassword,
        },
      });
      assert.equal(login.status, 200, JSON.stringify(login.payload));
      const token = login.payload.data.token;
      assert.equal(require("jsonwebtoken").decode(token).authVersion, 0);
      assert.equal((await api("/auth/me", { token })).status, 200);

      await pool.query(
        "UPDATE public.users SET auth_version = auth_version + 1 WHERE id = $1",
        [migrationFixture.rows[0].id],
      );
      assert.equal(
        (await api("/auth/me", { token })).status,
        401,
        "Incrementing auth_version must invalidate previously issued sessions.",
      );
    });

    await t.test("requires authentication and creates/login users persistently", async () => {
      const protectedRoutes = [
        "/auth/me",
        "/organizations",
        "/organizations/1",
        "/projects",
        "/projects/1",
        "/projects/1/statuses",
        "/tasks",
        "/tasks/1",
        "/comments/task/1",
        "/ai/memories",
        "/ai/memories/1",
        "/ai/task/1/chat/history",
        "/ai/global/chat/history",
        "/ai/chats/recent",
        "/knowledge/search?q=private",
      ];
      for (const route of protectedRoutes) {
        assert.equal((await api(route)).status, 401, `${route} must require authentication.`);
      }
      assert.equal(
        (await api("/ai/chats/end-all", { method: "POST" })).status,
        401,
        "Closing AI chats must require authentication.",
      );

      const invalidSignup = await api("/auth/signup", {
        method: "POST",
        body: {
          name: "n".repeat(121),
          email: `devflow-invalid-${crypto.randomUUID()}@example.test`,
          password: "Test-Password-123!",
        },
      });
      assert.equal(invalidSignup.status, 400);

      const owner = await signup("owner");
      const persisted = await pool.query(
        "SELECT name, email FROM users WHERE id = $1",
        [owner.user.id],
      );
      assert.equal(persisted.rowCount, 1);
      assert.equal(persisted.rows[0].email, owner.email);

      const duplicate = await api("/auth/signup", {
        method: "POST",
        body: {
          name: "Duplicate",
          email: owner.email.toUpperCase(),
          password: "Test-Password-123!",
        },
      });
      assert.equal(duplicate.status, 409);

      const login = await api("/auth/login", {
        method: "POST",
        body: { email: owner.email.toUpperCase(), password: "Test-Password-123!" },
      });
      assert.equal(login.status, 200);
      assert.equal(login.payload.data.user.id, owner.user.id);
      owner.token = login.payload.data.token;

      const expiredToken = require("jsonwebtoken").sign(
        { id: owner.user.id, role: "user" },
        process.env.JWT_SECRET,
        { expiresIn: -1 },
      );
      assert.equal((await api("/auth/me", { token: expiredToken })).status, 401);

      const loggedOutToken = owner.token;
      const logout = await api("/auth/logout", { method: "POST", token: loggedOutToken });
      assert.equal(logout.status, 200);
      revokedTokens.push(loggedOutToken);
      assert.equal((await api("/auth/me", { token: loggedOutToken })).status, 401);

      const relogin = await api("/auth/login", {
        method: "POST",
        body: { email: owner.email, password: "Test-Password-123!" },
      });
      assert.equal(relogin.status, 200);
      owner.token = relogin.payload.data.token;
      this.owner = owner;
    });

    const ownerLogin = await api("/auth/login", {
      method: "POST",
      body: {
        email: fixtureEmails[0],
        password: "Test-Password-123!",
      },
    });
    assert.equal(ownerLogin.status, 200);
    const owner = { email: fixtureEmails[0], ...ownerLogin.payload.data };

    await t.test("isolates workspaces and persists invitation, project, task, and comment changes", async () => {
      const guest = await signup("guest");
      const outsider = await signup("outsider");
      const observer = await signup("observer");
      const organizationAdmin = await signup("organization-admin");
      const organizationMember = await signup("organization-member");
      const projectAdmin = await signup("project-admin");
      const revokedMember = await signup("revoked-member");

      const resetResponses = [];
      const { securityDigest } = require("../src/services/passwordResetSecurity");
      resetAuditSubjects.push(securityDigest(owner.email));
      resetRateEmailHashes.push(securityDigest(owner.email));
      for (let attempt = 0; attempt < 4; attempt += 1) {
        resetResponses.push(await api("/auth/forgot-password", {
          method: "POST",
          body: { email: owner.email },
        }));
      }
      assert.deepEqual(
        resetResponses.map(({ status, payload }) => [status, payload.message]),
        Array(4).fill([200, resetResponses[0].payload.message]),
      );
      assert.match(resetResponses[0].payload.message, /If an active account exists/);
      const unknownEmail = `unknown-${crypto.randomUUID()}@example.test`;
      resetAuditSubjects.push(securityDigest(unknownEmail));
      resetRateEmailHashes.push(securityDigest(unknownEmail));
      const unknownAccountReset = await api("/auth/forgot-password", {
        method: "POST",
        body: { email: unknownEmail },
      });
      assert.equal(unknownAccountReset.status, 200);
      assert.equal(unknownAccountReset.payload.message, resetResponses[0].payload.message);

      const limitedUser = await signup("reset-limit");
      resetAuditSubjects.push(securityDigest(limitedUser.email));
      resetRateEmailHashes.push(securityDigest(limitedUser.email));
      const burstResponses = await Promise.all(Array.from({ length: 5 }, () => api(
        "/auth/forgot-password",
        { method: "POST", body: { email: limitedUser.email } },
      )));
      assert.ok(burstResponses.every(
        ({ status, payload }) => status === 200 && payload.message === resetResponses[0].payload.message,
      ));

      const capturedEmails = (await fs.readFile(emailCapturePath, "utf8"))
        .trim()
        .split("\n")
        .map((line) => JSON.parse(line));
      assert.equal(capturedEmails.length, 6, "Only the first three reset messages per email should be sent.");
      const ownerResetToken = new URL(capturedEmails[2].text.match(/https?:\/\/\S+/)[0]).searchParams.get("token");
      assert.match(ownerResetToken, /^[a-f0-9]{64}$/);
      resetAuditSubjects.push(securityDigest("invalid"), securityDigest(ownerResetToken));
      assert.equal((await pool.query(
        "SELECT 1 FROM password_reset_tokens WHERE token_hash = $1",
        [require("../src/middleware/authMiddleware").hashToken(ownerResetToken)],
      )).rowCount, 1, "Only a hash of the reset token is stored.");
      assert.equal((await api("/auth/reset-password", {
        method: "POST",
        body: { token: "invalid", password: "New-Test-Password-456!" },
      })).status, 400);
      assert.equal((await api("/auth/reset-password", {
        method: "POST",
        body: { token: ownerResetToken, password: "weak" },
      })).status, 400, "Invalid passwords must not consume a reset token.");
      const completedReset = await api("/auth/reset-password", {
        method: "POST",
        body: {
          token: ownerResetToken,
          password: "New-Test-Password-456!",
          userId: outsider.user.id,
        },
      });
      assert.equal(completedReset.status, 200, JSON.stringify(completedReset.payload));
      assert.equal((await api("/auth/me", { token: owner.token })).status, 401);
      const resetOwnerLogin = await api("/auth/login", {
        method: "POST",
        body: { email: owner.email, password: "New-Test-Password-456!" },
      });
      assert.equal(resetOwnerLogin.status, 200);
      owner.token = resetOwnerLogin.payload.data.token;
      assert.equal((await api("/auth/login", {
        method: "POST",
        body: { email: outsider.email, password: "Test-Password-123!" },
      })).status, 200, "A client-supplied user ID must not redirect token ownership.");
      assert.equal((await api("/auth/reset-password", {
        method: "POST",
        body: { token: ownerResetToken, password: "Another-Test-Password-789!" },
      })).status, 400, "A reset token is single use.");

      const guestResetRequest = await api("/auth/forgot-password", {
        method: "POST",
        body: { email: guest.email },
      });
      assert.equal(guestResetRequest.status, 200);
      resetAuditSubjects.push(securityDigest(guest.email));
      resetRateEmailHashes.push(securityDigest(guest.email));
      const afterGuestReset = (await fs.readFile(emailCapturePath, "utf8"))
        .trim()
        .split("\n")
        .map((line) => JSON.parse(line));
      const guestResetToken = new URL(afterGuestReset[6].text.match(/https?:\/\/\S+/)[0]).searchParams.get("token");
      resetAuditSubjects.push(securityDigest(guestResetToken));
      await pool.query(
        `UPDATE password_reset_tokens SET expires_at = NOW() - INTERVAL '1 second'
         WHERE token_hash = $1`,
        [require("../src/middleware/authMiddleware").hashToken(guestResetToken)],
      );
      assert.equal((await api("/auth/reset-password", {
        method: "POST",
        body: { token: guestResetToken, password: "New-Test-Password-456!" },
      })).status, 400, "Expired reset tokens must not change passwords.");
      const resetEvents = await pool.query(
        `SELECT event_type, subject_hash
         FROM auth_security_events
         WHERE user_id = $1`,
        [owner.user.id],
      );
      assert.ok(resetEvents.rows.some((event) => event.event_type === "password_reset_completed"));
      assert.ok(resetEvents.rows.every((event) => event.subject_hash !== owner.email));

      const organizationResult = await api("/organizations", {
        method: "POST",
        token: owner.token,
        body: { name: `Integration ${crypto.randomUUID()}` },
      });
      assert.equal(organizationResult.status, 201, JSON.stringify(organizationResult.payload));
      const organizationId = organizationResult.payload.data.id;
      organizationIds.push(organizationId);
      assert.equal((await api("/organizations/not-an-id", { token: owner.token })).status, 400);

      const invitationToken = crypto.randomBytes(32).toString("hex");
      const invitationHash = crypto.createHash("sha256").update(invitationToken).digest("hex");
      const invitation = await pool.query(
        `INSERT INTO organization_invitations
          (organization_id, email, role, token_hash, invited_by, expires_at)
         VALUES ($1, $2, 'user', $3, $4, NOW() + INTERVAL '1 hour')
         RETURNING id`,
        [organizationId, guest.email, invitationHash, owner.user.id],
      );

      const preview = await api(`/invitations/${invitationToken}`);
      assert.equal(preview.status, 200);
      assert.equal(preview.payload.data.email, guest.email);

      const accepted = await api(`/invitations/${invitationToken}/accept`, {
        method: "POST",
        token: guest.token,
      });
      assert.equal(accepted.status, 200, JSON.stringify(accepted.payload));
      const memberRow = await pool.query(
        "SELECT role FROM organization_members WHERE organization_id = $1 AND user_id = $2",
        [organizationId, guest.user.id],
      );
      assert.equal(memberRow.rows[0].role, "user");
      assert.equal((await api(`/invitations/${invitationToken}/accept`, {
        method: "POST",
        token: guest.token,
      })).status, 410);

      await pool.query(
        `INSERT INTO organization_members (organization_id, user_id, role)
         VALUES ($1, $2, 'user'), ($1, $3, 'admin'), ($1, $4, 'user'), ($1, $5, 'user')`,
        [
          organizationId,
          observer.user.id,
          organizationAdmin.user.id,
          organizationMember.user.id,
          projectAdmin.user.id,
        ],
      );
      await pool.query(
        `INSERT INTO organization_members (organization_id, user_id, role)
         VALUES ($1, $2, 'user')`,
        [organizationId, revokedMember.user.id],
      );

      const wrongEmailInvitation = crypto.randomBytes(32).toString("hex");
      await pool.query(
        `INSERT INTO organization_invitations
          (organization_id, email, role, token_hash, invited_by, expires_at)
         VALUES ($1, $2, 'user', $3, $4, NOW() + INTERVAL '1 hour')`,
        [
          organizationId,
          outsider.email,
          crypto.createHash("sha256").update(wrongEmailInvitation).digest("hex"),
          owner.user.id,
        ],
      );

      const outsiderOrg = await api(`/organizations/${organizationId}`, { token: outsider.token });
      assert.equal(outsiderOrg.status, 404);
      assert.equal((await api(`/invitations/${wrongEmailInvitation}/accept`, {
        method: "POST",
        token: guest.token,
      })).status, 403);

      const projectResult = await api("/projects", {
        method: "POST",
        token: owner.token,
        body: { organizationId, name: "Integration project" },
      });
      assert.equal(projectResult.status, 201, JSON.stringify(projectResult.payload));
      const projectId = projectResult.payload.data.id;
      const foreignOrganization = await api("/organizations", {
        method: "POST",
        token: outsider.token,
        body: { name: `Foreign tenant ${crypto.randomUUID()}` },
      });
      assert.equal(foreignOrganization.status, 201, JSON.stringify(foreignOrganization.payload));
      const foreignOrganizationId = foreignOrganization.payload.data.id;
      organizationIds.push(foreignOrganizationId);
      const foreignProject = await api("/projects", {
        method: "POST",
        token: outsider.token,
        body: { organizationId: foreignOrganizationId, name: "Foreign tenant project" },
      });
      assert.equal(foreignProject.status, 201, JSON.stringify(foreignProject.payload));
      const foreignProjectId = foreignProject.payload.data.id;
      const foreignTask = await api("/tasks", {
        method: "POST",
        token: outsider.token,
        body: { projectId: foreignProjectId, title: "Foreign tenant private task" },
      });
      assert.equal(foreignTask.status, 201, JSON.stringify(foreignTask.payload));
      const foreignTaskId = foreignTask.payload.data.id;
      const foreignComment = await api(`/comments/task/${foreignTaskId}`, {
        method: "POST",
        token: outsider.token,
        body: { content: "Foreign tenant private comment." },
      });
      assert.equal(foreignComment.status, 201, JSON.stringify(foreignComment.payload));
      const foreignCommentId = foreignComment.payload.data.id;
      assert.equal((await api(`/projects/${foreignProjectId}`, { token: owner.token })).status, 404);
      assert.equal((await api(`/projects/${foreignProjectId}`, {
        method: "PUT",
        token: owner.token,
        body: { name: "Cross-tenant project mutation", status: "active" },
      })).status, 403);
      assert.equal((await api(`/projects/${foreignProjectId}`, {
        method: "DELETE",
        token: owner.token,
      })).status, 403);
      assert.equal((await api(`/tasks/${foreignTaskId}`, { token: owner.token })).status, 403);
      assert.equal((await api(`/tasks/${foreignTaskId}`, {
        method: "PUT",
        token: owner.token,
        body: { title: "Cross-tenant task mutation" },
      })).status, 403);
      assert.equal((await api(`/tasks/${foreignTaskId}`, {
        method: "DELETE",
        token: owner.token,
      })).status, 403);
      assert.equal((await api(`/comments/task/${foreignTaskId}`, { token: owner.token })).status, 403);
      assert.equal((await api(`/comments/task/${foreignTaskId}`, {
        method: "POST",
        token: owner.token,
        body: { content: "Cross-tenant comment attempt." },
      })).status, 403);
      assert.equal((await api(`/comments/${foreignCommentId}`, {
        method: "DELETE",
        token: owner.token,
      })).status, 403);
      assert.equal((await api(
        `/knowledge/search?q=private&organizationId=${foreignOrganizationId}`,
        { token: owner.token },
      )).status, 403);
      assert.equal((await api(`/ai/task/${foreignTaskId}/chat/history`, {
        token: owner.token,
      })).status, 403);
      assert.equal((await api(`/ai/task/${foreignTaskId}/agent`, {
        method: "POST",
        token: owner.token,
        body: { message: "Delete this task." },
      })).status, 403);
      assert.equal((await api(`/ai/memories?projectId=${foreignProjectId}`, {
        token: owner.token,
      })).status, 403);
      await pool.query(
        `INSERT INTO project_members (project_id, user_id, role)
         VALUES ($1, $2, 'project_admin'), ($1, $3, 'project_admin')`,
        [projectId, projectAdmin.user.id, revokedMember.user.id],
      );
      assert.equal((await api("/projects/not-an-id", { token: owner.token })).status, 400);
      const unsafeDatabaseId = "9007199254740992";
      assert.equal((await api(
        `/knowledge/search?q=project&organizationId=${unsafeDatabaseId}`,
        { token: owner.token },
      )).status, 400, "Unsafe organization IDs must be rejected before database access.");
      assert.equal((await api(
        `/knowledge/search?q=project&organizationId=${organizationId}&projectId=${unsafeDatabaseId}`,
        { token: owner.token },
      )).status, 400, "Unsafe project IDs must be rejected before vector search.");

      const privateSearchQuery = "devflow-integration-force-embedding-failure";
      const failedKnowledgeSearch = await api(
        `/knowledge/search?q=${encodeURIComponent(privateSearchQuery)}&organizationId=${organizationId}`,
        { token: owner.token },
      );
      assert.equal(failedKnowledgeSearch.status, 500);
      assert.equal(failedKnowledgeSearch.payload.message, "Knowledge search failed.");
      assert.equal("error" in failedKnowledgeSearch.payload, false);
      assert.equal(
        serverOutput.includes(privateSearchQuery),
        false,
        "Knowledge search text must not be written to backend logs.",
      );
      assert.equal(
        JSON.stringify(failedKnowledgeSearch.payload).includes("private embedding provider diagnostic"),
        false,
        "Provider error details must not be returned to clients.",
      );

      const projectRead = await api(`/projects/${projectId}`, { token: owner.token });
      assert.equal(projectRead.status, 200);
      assert.equal(projectRead.payload.data.name, "Integration project");
      assert.equal((await api(`/projects/${projectId}`, { token: outsider.token })).status, 404);

      const memberAdded = await api(`/projects/${projectId}/members`, {
        method: "POST",
        token: owner.token,
        body: { email: guest.email, role: "member" },
      });
      assert.equal(memberAdded.status, 201, JSON.stringify(memberAdded.payload));
      assert.equal((await api(`/projects/${projectId}/members`, {
        method: "POST",
        token: owner.token,
        body: { email: observer.email, role: "member" },
      })).status, 201);

      const privateMemory = await api("/ai/memories", {
        method: "POST",
        token: owner.token,
        body: {
          type: "preference",
          content: "Private owner memory for isolation.",
          userId: guest.user.id,
        },
      });
      assert.equal(privateMemory.status, 201, JSON.stringify(privateMemory.payload));
      const privateMemoryId = privateMemory.payload.data.id;
      assert.equal(
        String(privateMemory.payload.data.userId),
        String(owner.user.id),
        "A client-supplied userId must not redirect memory ownership.",
      );
      const repeatedPrivateMemory = await api("/ai/memories", {
        method: "POST",
        token: owner.token,
        body: { type: "preference", content: "Private owner memory for isolation." },
      });
      assert.equal(String(repeatedPrivateMemory.payload.data.id), String(privateMemoryId));
      assert.equal((await pool.query(
        "SELECT COUNT(*)::int AS count FROM ai_memories WHERE user_id = $1 AND content = $2",
        [owner.user.id, "Private owner memory for isolation."],
      )).rows[0].count, 1, "Repeated identical memories in the same scope must deduplicate.");
      const guestPrivateMemories = await api("/ai/memories", { token: guest.token });
      assert.equal(guestPrivateMemories.status, 200);
      assert.equal(
        guestPrivateMemories.payload.data.some((memory) => String(memory.id) === String(privateMemoryId)),
        false,
        "An unscoped memory must remain private to its creator.",
      );
      assert.equal((await api(`/ai/memories/${privateMemoryId}`, { token: guest.token })).status, 404);
      assert.equal((await api(`/ai/memories/${privateMemoryId}`, {
        method: "PATCH",
        token: guest.token,
        body: { content: "Unauthorized memory update.", userId: owner.user.id },
      })).status, 404);
      assert.equal((await api(`/ai/memories/${privateMemoryId}`, {
        method: "DELETE",
        token: guest.token,
      })).status, 404);
      const spoofedMemoryList = await api(`/ai/memories?userId=${owner.user.id}`, {
        token: guest.token,
      });
      assert.equal(spoofedMemoryList.status, 200);
      assert.equal(
        spoofedMemoryList.payload.data.some((memory) => String(memory.id) === String(privateMemoryId)),
        false,
        "A client-supplied userId must not expose another user's private memories.",
      );
      const spoofedMemorySearch = await api(
        `/ai/memories/search?userId=${owner.user.id}&query=Private%20owner`,
        { token: guest.token },
      );
      assert.equal(spoofedMemorySearch.status, 200);
      assert.equal(
        spoofedMemorySearch.payload.data.some((memory) => String(memory.id) === String(privateMemoryId)),
        false,
        "A client-supplied userId must not expose another user's memories through semantic search.",
      );
      const ownerMemoryUpdate = await api(`/ai/memories/${privateMemoryId}`, {
        method: "PATCH",
        token: owner.token,
        body: { content: "Updated private owner memory." },
      });
      assert.equal(ownerMemoryUpdate.status, 200, JSON.stringify(ownerMemoryUpdate.payload));
      assert.equal((await pool.query(
        "SELECT content FROM ai_memories WHERE id = $1 AND user_id = $2",
        [privateMemoryId, owner.user.id],
      )).rows[0].content, "Updated private owner memory.");
      assert.equal((await api(`/ai/memories/${privateMemoryId}`, {
        method: "DELETE",
        token: owner.token,
      })).status, 200);
      assert.equal((await pool.query(
        "SELECT 1 FROM ai_memories WHERE id = $1",
        [privateMemoryId],
      )).rowCount, 0);

      const organizationMemory = await api("/ai/memories", {
        method: "POST",
        token: owner.token,
        body: {
          type: "decision",
          content: "Shared organization memory for authorized members.",
          organizationId,
        },
      });
      assert.equal(organizationMemory.status, 201, JSON.stringify(organizationMemory.payload));
      const guestOrganizationMemories = await api(
        `/ai/memories?organizationId=${organizationId}`,
        { token: guest.token },
      );
      assert.equal(guestOrganizationMemories.status, 200);
      assert.equal(
        guestOrganizationMemories.payload.data.some(
          (memory) => String(memory.id) === String(organizationMemory.payload.data.id),
        ),
        true,
        "Organization members may retrieve memories scoped to their organization.",
      );
      const outsiderOrganizationMemories = await api(
        `/ai/memories?organizationId=${organizationId}`,
        { token: outsider.token },
      );
      assert.equal(outsiderOrganizationMemories.status, 403);
      assert.equal((await api("/ai/memories", {
        method: "POST",
        token: outsider.token,
        body: {
          type: "fact",
          content: "Unauthorized organization memory.",
          organizationId,
        },
      })).status, 403);
      assert.equal((await api(
        `/ai/memories/search?organizationId=${organizationId}&query=Shared`,
        { token: outsider.token },
      )).status, 403);
      assert.equal((await api(`/ai/memories?projectId=${projectId}`, {
        token: organizationMember.token,
      })).status, 403, "Organization membership alone must not authorize a project-scoped memory request.");
      assert.equal((await api(
        `/ai/memories/search?projectId=${projectId}&query=private`,
        { token: organizationMember.token },
      )).status, 403);
      assert.equal((await api("/ai/memories", {
        method: "POST",
        token: organizationMember.token,
        body: {
          type: "context",
          content: "Unauthorized project memory.",
          projectId,
        },
      })).status, 403);

      const unauthorizedProjectUpdate = await api(`/projects/${projectId}`, {
        method: "PUT",
        token: outsider.token,
        body: { name: "Unauthorized", status: "active" },
      });
      assert.equal(unauthorizedProjectUpdate.status, 403);
      assert.equal((await api(`/projects/${projectId}`, { token: guest.token })).status, 200);

      const invalidTask = await api("/tasks", {
        method: "POST",
        token: owner.token,
        body: { projectId, title: "Invalid status", status: "unknown" },
      });
      assert.equal(invalidTask.status, 400);
      assert.equal((await api("/tasks/not-an-id", { token: owner.token })).status, 400);
      assert.equal((await api("/tasks", {
        method: "POST",
        token: owner.token,
        body: { projectId, title: "Invalid date", dueDate: "2026-02-30" },
      })).status, 400);
      assert.equal((await api("/tasks", {
        method: "POST",
        token: owner.token,
        body: { projectId, title: 42 },
      })).status, 400);
      assert.equal((await api("/tasks", {
        method: "POST",
        token: owner.token,
        body: { projectId, title: "Invalid description", description: {} },
      })).status, 400);
      assert.equal((await api("/tasks", {
        method: "POST",
        token: owner.token,
        body: { projectId, title: "Invalid assignee", assigneeId: 0 },
      })).status, 400);
      assert.equal((await api("/tasks", {
        method: "POST",
        token: owner.token,
        body: { projectId, title: "Invalid role tag", roleTagId: "not-an-id" },
      })).status, 400);
      assert.equal((await api(`/projects/${projectId}`, {
        method: "PUT",
        token: owner.token,
        body: { name: "Invalid status", status: "not-a-project-status" },
      })).status, 400);

      const rollbackTitle = "Task transaction rollback regression";
      await pool.query("DROP TRIGGER IF EXISTS devflow_test_reject_activity ON task_activity");
      await pool.query(`
        CREATE OR REPLACE FUNCTION devflow_test_reject_activity()
        RETURNS TRIGGER AS $$
        BEGIN
          RAISE EXCEPTION 'intentional integration-test activity failure';
        END;
        $$ LANGUAGE plpgsql
      `);
      await pool.query(`
        CREATE TRIGGER devflow_test_reject_activity
        BEFORE INSERT ON task_activity
        FOR EACH ROW EXECUTE FUNCTION devflow_test_reject_activity()
      `);
      try {
        const rolledBackTask = await api("/tasks", {
          method: "POST",
          token: owner.token,
          body: { projectId, title: rollbackTitle },
        });
        assert.equal(rolledBackTask.status, 500);
        assert.equal((await pool.query(
          "SELECT 1 FROM tasks WHERE project_id = $1 AND title = $2",
          [projectId, rollbackTitle],
        )).rowCount, 0, "Task and activity writes must roll back atomically.");
      } finally {
        await pool.query("DROP TRIGGER IF EXISTS devflow_test_reject_activity ON task_activity");
        await pool.query("DROP FUNCTION IF EXISTS devflow_test_reject_activity()");
      }

      const ownerSocket = await connectSocket(owner.token);
      const guestSocket = await connectSocket(guest.token);
      const observerSocket = await connectSocket(observer.token);
      const outsiderSocket = await connectSocket(outsider.token);
      const organizationAdminSocket = await connectSocket(organizationAdmin.token);
      const organizationMemberSocket = await connectSocket(organizationMember.token);
      const projectAdminSocket = await connectSocket(projectAdmin.token);
      const revokedMemberSocket = await connectSocket(revokedMember.token);
      await assert.rejects(
        connectSocket(null),
        /Authentication required/,
        "Unauthenticated clients must not establish a Socket.IO connection.",
      );
      const socketEvents = new Map(
        [
          ["owner", ownerSocket],
          ["guest", guestSocket],
          ["observer", observerSocket],
          ["outsider", outsiderSocket],
          ["organizationAdmin", organizationAdminSocket],
          ["organizationMember", organizationMemberSocket],
          ["projectAdmin", projectAdminSocket],
          ["revokedMember", revokedMemberSocket],
        ].map(([name, socket]) => {
          const events = [];
          socket.on("task_changed", (event) => events.push(event));
          return [name, events];
        }),
      );
      const commentEvents = new Map(
        [
          ["owner", ownerSocket],
          ["guest", guestSocket],
          ["observer", observerSocket],
          ["outsider", outsiderSocket],
          ["organizationAdmin", organizationAdminSocket],
          ["organizationMember", organizationMemberSocket],
          ["projectAdmin", projectAdminSocket],
          ["revokedMember", revokedMemberSocket],
        ].map(([name, socket]) => {
          const added = [];
          const deleted = [];
          socket.on("comment_added", (event) => added.push(event));
          socket.on("comment_deleted", (event) => deleted.push(event));
          return [name, { added, deleted }];
        }),
      );

      const taskCreated = await api("/tasks", {
        method: "POST",
        token: owner.token,
        body: {
          projectId,
          title: "Persisted integration task",
          description: "Verify write, read, update, and delete against PostgreSQL.",
          assigneeId: guest.user.id,
        },
      });
      assert.equal(taskCreated.status, 201, JSON.stringify(taskCreated.payload));
      const taskId = taskCreated.payload.data.id;

      const assistantTaskResponse = await api("/tasks", {
        method: "POST",
        token: owner.token,
        body: { projectId, title: "Task Assistant integration target" },
      });
      assert.equal(assistantTaskResponse.status, 201, JSON.stringify(assistantTaskResponse.payload));
      const assistantTaskId = assistantTaskResponse.payload.data.id;

      const taskAnswer = await api(`/ai/task/${assistantTaskId}/chat`, {
        method: "POST",
        token: owner.token,
        body: { message: "Summarize this task." },
      });
      assert.equal(taskAnswer.status, 200, JSON.stringify(taskAnswer.payload));
      assert.equal(typeof taskAnswer.payload.data.answer, "string");

      const taskAction = await api(`/ai/task/${assistantTaskId}/agent`, {
        method: "POST",
        token: owner.token,
        body: { message: "Set this task's priority to high." },
      });
      assert.equal(taskAction.status, 200, JSON.stringify(taskAction.payload));
      assert.equal(
        taskAction.payload.data.changes?.[0]?.type,
        "updated",
        JSON.stringify(taskAction.payload),
      );
      assert.equal(taskAction.payload.data.changes[0].before.priority, "no_priority");
      assert.equal(taskAction.payload.data.changes[0].after.priority, "high");
      assert.equal((await pool.query(
        "SELECT priority FROM tasks WHERE id = $1",
        [assistantTaskId],
      )).rows[0].priority, "high");

      const unclearAction = await api(`/ai/task/${assistantTaskId}/agent`, {
        method: "POST",
        token: owner.token,
        body: { message: "Update this task." },
      });
      assert.equal(unclearAction.status, 200, JSON.stringify(unclearAction.payload));
      assert.match(unclearAction.payload.data.answer, /what would you like/i);
      assert.deepEqual(unclearAction.payload.data.changes, []);
      assert.equal((await pool.query(
        "SELECT priority FROM tasks WHERE id = $1",
        [assistantTaskId],
      )).rows[0].priority, "high");

      const taskCreation = await api(`/ai/task/${assistantTaskId}/agent`, {
        method: "POST",
        token: owner.token,
        body: { message: "Create a high-priority task called Fix Login API in this project." },
      });
      assert.equal(taskCreation.status, 200, JSON.stringify(taskCreation.payload));
      const createdByAssistant = taskCreation.payload.data.changes.find((change) => change.type === "created");
      assert.ok(createdByAssistant, "Task creation must be confirmed by the backend tool result.");
      assert.equal(String(createdByAssistant.task.project_id), String(projectId));
      assert.equal((await pool.query(
        "SELECT project_id FROM tasks WHERE id = $1",
        [createdByAssistant.task.id],
      )).rows[0].project_id.toString(), String(projectId));

      const agentOrganization = await api("/ai/global/chat", {
        method: "POST",
        token: owner.token,
        body: { message: "Create an organization called Agent Test.", requestId: crypto.randomUUID() },
      });
      assert.equal(agentOrganization.status, 200, JSON.stringify(agentOrganization.payload));
      const organizationProposal = agentOrganization.payload.data.actionProposals[0];
      assert.equal(organizationProposal.status, "proposed");
      assert.equal(agentOrganization.payload.data.actionResults.length, 0);
      assert.equal((await pool.query(
        "SELECT COUNT(*)::int AS count FROM organizations WHERE name = 'AI-created integration organization'",
      )).rows[0].count, 0, "A write must remain unapplied until explicit approval.");
      const repeatedOrganizationRequest = await api("/ai/global/chat", {
        method: "POST",
        token: owner.token,
        body: {
          message: "Create an organization called Agent Test.",
          requestId: agentOrganization.payload.data.requestId,
        },
      });
      assert.equal(repeatedOrganizationRequest.status, 200);
      assert.equal(
        repeatedOrganizationRequest.payload.data.actionProposals[0].id,
        organizationProposal.id,
        "Repeated tool requests with the same request ID return the original proposal.",
      );
      assert.equal((await api(`/ai/global/proposals/${organizationProposal.id}/approve`, {
        method: "POST",
        token: outsider.token,
      })).status, 404, "A user cannot approve another user's proposal.");
      const organizationApproval = await api(`/ai/global/proposals/${organizationProposal.id}/approve`, {
        method: "POST",
        token: owner.token,
      });
      assert.equal(organizationApproval.status, 200, JSON.stringify(organizationApproval.payload));
      assert.equal(organizationApproval.payload.data.proposal.status, "succeeded");
      const agentOrganizationId = organizationApproval.payload.data.result.resource.id;
      organizationIds.push(agentOrganizationId);

      const agentProject = await api("/ai/global/chat", {
        method: "POST",
        token: owner.token,
        body: {
          message: "Create a project called Agent Test Project.",
          context: { entityType: "organization", entityId: agentOrganizationId },
        },
      });
      assert.equal(agentProject.status, 200, JSON.stringify(agentProject.payload));
      const projectProposal = agentProject.payload.data.actionProposals[0];
      assert.equal(projectProposal.status, "proposed");
      assert.equal(String(projectProposal.target.organizationId), String(agentOrganizationId));
      const projectApproval = await api(`/ai/global/proposals/${projectProposal.id}/approve`, {
        method: "POST",
        token: owner.token,
      });
      assert.equal(projectApproval.payload.data.proposal.status, "succeeded");
      const agentProjectId = projectApproval.payload.data.result.resource.id;
      assert.equal(String(projectApproval.payload.data.result.resource.organization_id), String(agentOrganizationId));

      await pool.query(
        `INSERT INTO organization_members (organization_id, user_id, role)
         VALUES ($1, $2, 'user')`,
        [agentOrganizationId, projectAdmin.user.id],
      );
      await pool.query(
        `INSERT INTO project_members (project_id, user_id, role)
         VALUES ($1, $2, 'project_admin')`,
        [agentProjectId, projectAdmin.user.id],
      );
      const revokedMemberProposalResponse = await api("/ai/global/chat", {
        method: "POST",
        token: projectAdmin.token,
        body: {
          message: "Create a task before my access changes.",
          context: { entityType: "project", entityId: agentProjectId },
          requestId: crypto.randomUUID(),
        },
      });
      const revokedMemberProposal = revokedMemberProposalResponse.payload.data.actionProposals[0];
      await pool.query(
        "DELETE FROM project_members WHERE project_id = $1 AND user_id = $2",
        [agentProjectId, projectAdmin.user.id],
      );
      assert.equal((await api(`/ai/global/proposals/${revokedMemberProposal.id}/approve`, {
        method: "POST",
        token: projectAdmin.token,
      })).status, 403, "Project membership revoked before approval must block execution.");
      assert.equal((await pool.query(
        "SELECT COUNT(*)::int AS count FROM tasks WHERE project_id = $1",
        [agentProjectId],
      )).rows[0].count, 0);

      await pool.query(
        `INSERT INTO project_members (project_id, user_id, role)
         VALUES ($1, $2, 'project_admin')`,
        [agentProjectId, projectAdmin.user.id],
      );
      const executionRevocationProposalResponse = await api("/ai/global/chat", {
        method: "POST",
        token: projectAdmin.token,
        body: {
          message: "Create a task before execution-time access changes.",
          context: { entityType: "project", entityId: agentProjectId },
          requestId: crypto.randomUUID(),
        },
      });
      const executionRevocationProposal = executionRevocationProposalResponse.payload.data.actionProposals[0];
      const executionRevocationProjectId = String(agentProjectId);
      const executionRevocationUserId = String(projectAdmin.user.id);
      assert.match(executionRevocationProjectId, /^\d+$/);
      assert.match(executionRevocationUserId, /^\d+$/);
      await pool.query(`
        CREATE OR REPLACE FUNCTION test_revoke_project_member_on_ai_execution()
        RETURNS trigger LANGUAGE plpgsql AS $$
        BEGIN
          DELETE FROM project_members
          WHERE project_id = NEW.project_id AND user_id = NEW.user_id;
          RETURN NEW;
        END;
        $$;
      `);
      await pool.query(
        `CREATE TRIGGER test_revoke_project_member_on_ai_execution
         AFTER UPDATE OF status ON global_ai_action_proposals
         FOR EACH ROW
         WHEN (NEW.status = 'EXECUTING'
           AND NEW.project_id = ${executionRevocationProjectId}
           AND NEW.user_id = ${executionRevocationUserId})
         EXECUTE FUNCTION test_revoke_project_member_on_ai_execution()`,
      );
      const tasksBeforeExecutionRevocation = (await pool.query(
        "SELECT COUNT(*)::int AS count FROM tasks WHERE project_id = $1",
        [agentProjectId],
      )).rows[0].count;
      let executionRevocationApproval;
      try {
        executionRevocationApproval = await api(
          `/ai/global/proposals/${executionRevocationProposal.id}/approve`,
          { method: "POST", token: projectAdmin.token },
        );
      } finally {
        await pool.query(
          "DROP TRIGGER IF EXISTS test_revoke_project_member_on_ai_execution ON global_ai_action_proposals",
        );
        await pool.query("DROP FUNCTION IF EXISTS test_revoke_project_member_on_ai_execution()");
      }
      assert.equal(executionRevocationApproval.status, 200);
      assert.equal(executionRevocationApproval.payload.data.proposal.status, "failed");
      assert.equal(
        executionRevocationApproval.payload.data.proposal.error,
        "The current project is not available to this user.",
        "Project access revoked after approval must be rechecked before execution.",
      );
      assert.equal((await pool.query(
        "SELECT COUNT(*)::int AS count FROM tasks WHERE project_id = $1",
        [agentProjectId],
      )).rows[0].count, tasksBeforeExecutionRevocation);

      const agentTask = await api("/ai/global/chat", {
        method: "POST",
        token: owner.token,
        body: {
          message: "Create a task to prepare the agent integration test.",
          context: { entityType: "project", entityId: agentProjectId },
        },
      });
      assert.equal(agentTask.status, 200, JSON.stringify(agentTask.payload));
      const taskProposal = agentTask.payload.data.actionProposals[0];
      assert.equal(taskProposal.status, "proposed");
      assert.equal((await pool.query(
        "SELECT COUNT(*)::int AS count FROM tasks WHERE project_id = $1",
        [agentProjectId],
      )).rows[0].count, 0, "Proposed tasks must not be created before approval.");
      const concurrentApprovals = await Promise.all([
        api(`/ai/global/proposals/${taskProposal.id}/approve`, { method: "POST", token: owner.token }),
        api(`/ai/global/proposals/${taskProposal.id}/approve`, { method: "POST", token: owner.token }),
      ]);
      assert.ok(concurrentApprovals.every((result) => result.status === 200));
      assert.equal(concurrentApprovals.filter((result) => result.payload.data.proposal.status === "succeeded").length, 2);
      assert.equal((await pool.query(
        "SELECT COUNT(*)::int AS count FROM tasks WHERE project_id = $1",
        [agentProjectId],
      )).rows[0].count, 1, "Concurrent and repeated approvals must create exactly one task.");
      const approvedTask = concurrentApprovals.find((result) => !result.payload.data.replayed) || concurrentApprovals[0];
      const agentTaskId = approvedTask.payload.data.result.resource.id;
      const agentTaskRow = await pool.query(
        "SELECT project_id, title, priority FROM tasks WHERE id = $1",
        [agentTaskId],
      );
      assert.equal(String(agentTaskRow.rows[0].project_id), String(agentProjectId));
      assert.equal(agentTaskRow.rows[0].title, "AI-created integration task");

      const agentTaskUpdate = await api("/ai/global/chat", {
        method: "POST",
        token: owner.token,
        body: {
          message: "Change its priority to urgent.",
          context: { entityType: "task", entityId: agentTaskId },
        },
      });
      assert.equal(agentTaskUpdate.status, 200, JSON.stringify(agentTaskUpdate.payload));
      const updateProposal = agentTaskUpdate.payload.data.actionProposals[0];
      assert.equal(updateProposal.status, "proposed");
      assert.equal((await pool.query(
        "SELECT priority FROM tasks WHERE id = $1",
        [agentTaskId],
      )).rows[0].priority, "high", "Task updates must remain unapplied until approval.");
      const updateApproval = await api(`/ai/global/proposals/${updateProposal.id}/approve`, {
        method: "POST",
        token: owner.token,
      });
      assert.equal(updateApproval.payload.data.proposal.status, "succeeded");
      assert.equal((await pool.query(
        "SELECT priority FROM tasks WHERE id = $1",
        [agentTaskId],
      )).rows[0].priority, "urgent");
      const replayedUpdateApproval = await api(`/ai/global/proposals/${updateProposal.id}/approve`, {
        method: "POST",
        token: owner.token,
      });
      assert.equal(replayedUpdateApproval.payload.data.replayed, true);

      const readOnlyCount = (await pool.query(
        "SELECT COUNT(*)::int AS count FROM global_ai_action_proposals WHERE user_id = $1",
        [owner.user.id],
      )).rows[0].count;
      const readOnlyChat = await api("/ai/global/chat", {
        method: "POST",
        token: owner.token,
        body: { message: "What are my active tasks?", requestId: crypto.randomUUID() },
      });
      assert.equal(readOnlyChat.status, 200);
      assert.equal(readOnlyChat.payload.data.actionProposals.length, 0);
      assert.equal((await pool.query(
        "SELECT COUNT(*)::int AS count FROM global_ai_action_proposals WHERE user_id = $1",
        [owner.user.id],
      )).rows[0].count, readOnlyCount, "Read-only questions do not create approval proposals.");

      const cancelledChat = await api("/ai/global/chat", {
        method: "POST",
        token: owner.token,
        body: {
          message: "Create a task to cancel this proposal.",
          context: { entityType: "project", entityId: agentProjectId },
          requestId: crypto.randomUUID(),
        },
      });
      const cancelledProposal = cancelledChat.payload.data.actionProposals[0];
      assert.equal((await api(`/ai/global/proposals/${cancelledProposal.id}/cancel`, {
        method: "POST",
        token: owner.token,
      })).payload.data.proposal.status, "cancelled");
      assert.equal((await api(`/ai/global/proposals/${cancelledProposal.id}/approve`, {
        method: "POST",
        token: owner.token,
      })).status, 409, "Cancelled proposals cannot be executed.");

      const expiredChat = await api("/ai/global/chat", {
        method: "POST",
        token: owner.token,
        body: {
          message: "Create a task that will expire.",
          context: { entityType: "project", entityId: agentProjectId },
          requestId: crypto.randomUUID(),
        },
      });
      const expiredProposal = expiredChat.payload.data.actionProposals[0];
      await pool.query(
        "UPDATE global_ai_action_proposals SET expires_at = NOW() - INTERVAL '1 second' WHERE id = $1",
        [expiredProposal.id],
      );
      assert.equal((await api(`/ai/global/proposals/${expiredProposal.id}/approve`, {
        method: "POST",
        token: owner.token,
      })).status, 409, "Expired proposals cannot be executed.");
      assert.equal((await pool.query(
        "SELECT status FROM global_ai_action_proposals WHERE id = $1",
        [expiredProposal.id],
      )).rows[0].status, "EXPIRED");

      const failedChat = await api("/ai/global/chat", {
        method: "POST",
        token: owner.token,
        body: {
          message: "Change its priority to high.",
          context: { entityType: "task", entityId: agentTaskId },
          requestId: crypto.randomUUID(),
        },
      });
      const failedProposal = failedChat.payload.data.actionProposals[0];
      await pool.query(
        `UPDATE global_ai_action_proposals SET arguments = jsonb_set(arguments, '{status}', '"not-a-status"')
         WHERE id = $1`,
        [failedProposal.id],
      );
      const failedApproval = await api(`/ai/global/proposals/${failedProposal.id}/approve`, {
        method: "POST",
        token: owner.token,
      });
      assert.equal(failedApproval.payload.data.proposal.status, "failed");
      assert.equal(failedApproval.payload.data.result, null);
      assert.equal(
        failedApproval.payload.data.proposal.error,
        "The action could not be completed. No changes were applied.",
        "Invalid stored arguments must fail without exposing internal execution details.",
      );
      assert.equal((await pool.query(
        "SELECT priority FROM tasks WHERE id = $1",
        [agentTaskId],
      )).rows[0].priority, "urgent", "A failed proposal must not change the existing task.");

      const uncertainChat = await api("/ai/global/chat", {
        method: "POST",
        token: owner.token,
        body: {
          message: "Create a task to test retry after a lost response.",
          context: { entityType: "project", entityId: agentProjectId },
          requestId: crypto.randomUUID(),
        },
      });
      const uncertainProposal = uncertainChat.payload.data.actionProposals[0];
      const tasksBeforeUncertainApproval = (await pool.query(
        "SELECT COUNT(*)::int AS count FROM tasks WHERE project_id = $1",
        [agentProjectId],
      )).rows[0].count;
      const backendAddress = new URL(baseUrl);
      const responseDropProxy = http.createServer((incoming, downstream) => {
        const upstream = http.request({
          hostname: backendAddress.hostname,
          port: backendAddress.port,
          path: incoming.url,
          method: incoming.method,
          headers: { ...incoming.headers, host: backendAddress.host },
        }, (upstreamResponse) => {
          upstreamResponse.resume();
          downstream.destroy();
        });
        upstream.on("error", (error) => downstream.destroy(error));
        incoming.pipe(upstream);
      });
      await new Promise((resolve, reject) => {
        responseDropProxy.once("error", reject);
        responseDropProxy.listen(0, "127.0.0.1", resolve);
      });
      const proxyAddress = responseDropProxy.address();
      let droppedResponseError;
      try {
        await fetch(
          `http://127.0.0.1:${proxyAddress.port}/api/ai/global/proposals/${uncertainProposal.id}/approve`,
          {
            method: "POST",
            headers: { Authorization: `Bearer ${owner.token}` },
            signal: AbortSignal.timeout(15_000),
          },
        );
      } catch (error) {
        droppedResponseError = error;
      } finally {
        await new Promise((resolve) => responseDropProxy.close(resolve));
      }
      assert.ok(droppedResponseError, "The test proxy must drop the successful approval response.");
      const persistedUncertainOutcome = await pool.query(
        "SELECT status, result FROM global_ai_action_proposals WHERE id = $1",
        [uncertainProposal.id],
      );
      assert.equal(persistedUncertainOutcome.rows[0].status, "SUCCEEDED");
      const taskCountAfterUncertainApproval = (await pool.query(
        "SELECT COUNT(*)::int AS count FROM tasks WHERE project_id = $1",
        [agentProjectId],
      )).rows[0].count;
      assert.equal(taskCountAfterUncertainApproval, tasksBeforeUncertainApproval + 1);
      const retriedUncertainApproval = await api(
        `/ai/global/proposals/${uncertainProposal.id}/approve`,
        { method: "POST", token: owner.token },
      );
      assert.equal(retriedUncertainApproval.status, 200);
      assert.equal(retriedUncertainApproval.payload.data.replayed, true);
      assert.equal(retriedUncertainApproval.payload.data.proposal.status, "succeeded");
      assert.equal((await pool.query(
        "SELECT COUNT(*)::int AS count FROM tasks WHERE project_id = $1",
        [agentProjectId],
      )).rows[0].count, taskCountAfterUncertainApproval);

      const pendingChat = await api("/ai/global/chat", {
        method: "POST",
        token: owner.token,
        body: {
          message: "Create a task that remains pending while I close the chat.",
          context: { entityType: "project", entityId: agentProjectId },
          requestId: crypto.randomUUID(),
        },
      });
      const pendingProposal = pendingChat.payload.data.actionProposals[0];

      const unauthorizedAgentAction = await api("/ai/global/chat", {
        method: "POST",
        token: outsider.token,
        body: {
          message: "Create a task in this project.",
          context: { entityType: "project", entityId: agentProjectId },
        },
      });
      assert.equal(unauthorizedAgentAction.status, 403);
      assert.equal((await pool.query(
        "SELECT COUNT(*)::int AS count FROM tasks WHERE project_id = $1",
        [agentProjectId],
      )).rows[0].count, 2, "Unauthorized page context must not produce a task write.");

      const memoriesBeforeCloseAll = (await pool.query(
        "SELECT COUNT(*)::int AS count FROM ai_memories WHERE user_id = $1",
        [owner.user.id],
      )).rows[0].count;
      const closeAll = await api("/ai/chats/end-all", {
        method: "POST",
        token: owner.token,
      });
      assert.equal(closeAll.status, 200, JSON.stringify(closeAll.payload));
      assert.equal(closeAll.payload.data.historyPreserved, true);
      assert.equal(closeAll.payload.data.memoriesPreserved, true);
      const pendingAfterClose = await api("/ai/global/proposals", { token: owner.token });
      assert.ok(pendingAfterClose.payload.data.proposals.some(
        (proposal) => proposal.id === pendingProposal.id && proposal.status === "proposed",
      ), "Closing chats must not implicitly approve or delete pending proposals.");
      assert.equal((await pool.query(
        "SELECT COUNT(*)::int AS count FROM ai_global_messages WHERE user_id = $1",
        [owner.user.id],
      )).rows[0].count > 0, true);
      assert.equal((await pool.query(
        "SELECT COUNT(*)::int AS count FROM ai_memories WHERE user_id = $1",
        [owner.user.id],
      )).rows[0].count, memoriesBeforeCloseAll);
      assert.equal((await pool.query(
        "SELECT status FROM global_ai_action_proposals WHERE id = $1",
        [pendingProposal.id],
      )).rows[0].status, "PROPOSED", "Deleting a conversation must not change its pending proposal state.");
      assert.equal((await pool.query(
        "SELECT COUNT(*)::int AS count FROM ai_chat_sessions WHERE user_id = $1 AND status = 'ACTIVE'",
        [owner.user.id],
      )).rows[0].count, 0);
      const globalSession = closeAll.payload.data.sessions.find((session) => session.chat_type === "GLOBAL");
      assert.ok(globalSession, "Close all should end the Global AI conversation session.");
      const savedMessages = await pool.query(
        "SELECT COUNT(*)::int AS count FROM ai_global_messages WHERE session_id = $1",
        [globalSession.id],
      );
      assert.ok(savedMessages.rows[0].count > 0, "Closing sessions must preserve chat history.");
      const recentChats = await api("/ai/chats/recent", { token: owner.token });
      assert.equal(recentChats.status, 200, JSON.stringify(recentChats.payload));
      assert.ok(recentChats.payload.data.chats.some(
        (session) => String(session.id) === String(globalSession.id),
      ));
      const savedHistory = await api(`/ai/chats/${globalSession.id}/history`, {
        token: owner.token,
      });
      assert.equal(savedHistory.status, 200, JSON.stringify(savedHistory.payload));
      assert.ok(savedHistory.payload.data.messages.length > 0);
      assert.equal((await api(`/ai/chats/${globalSession.id}/history`, {
        token: outsider.token,
      })).status, 404, "A user cannot retrieve another user's conversation.");
      assert.equal((await api(`/ai/chats/${globalSession.id}`, {
        method: "DELETE",
        token: outsider.token,
      })).status, 404, "A user cannot delete another user's conversation.");
      const deletedConversation = await api(`/ai/chats/${globalSession.id}`, {
        method: "DELETE",
        token: owner.token,
      });
      assert.equal(deletedConversation.status, 200, JSON.stringify(deletedConversation.payload));
      assert.equal(deletedConversation.payload.data.memoriesDeleted, false);
      assert.equal((await pool.query(
        "SELECT COUNT(*)::int AS count FROM ai_global_messages WHERE session_id = $1",
        [globalSession.id],
      )).rows[0].count, 0, "Deleting a conversation must remove only its messages.");
      assert.equal((await pool.query(
        "SELECT COUNT(*)::int AS count FROM ai_memories WHERE user_id = $1",
        [owner.user.id],
      )).rows[0].count, memoriesBeforeCloseAll);

      await pool.query("UPDATE tasks SET created_by = $1 WHERE id = $2", [observer.user.id, taskId]);
      const unassignedTask = await api("/tasks", {
        method: "POST",
        token: owner.token,
        body: { projectId, title: "Project-private task for AI retrieval" },
      });
      assert.equal(unassignedTask.status, 201, JSON.stringify(unassignedTask.payload));
      const { getProjectTasks } = require("../src/services/retrievalService");
      const guestProjectTasks = await getProjectTasks(projectId, guest.user.id);
      assert.deepEqual(
        guestProjectTasks.map((task) => String(task.id)),
        [String(taskId)],
        "The task-agent get_tasks retrieval must not expose unassigned tasks to an assignee.",
      );
      const ownerProjectTasks = await getProjectTasks(projectId, owner.user.id);
      assert.ok(ownerProjectTasks.some((task) => String(task.id) === String(unassignedTask.payload.data.id)));
      const sentinelKnowledge = "TENANT_A_PRIVATE_TASK_VECTOR_SENTINEL";
      const fixedVector = `[${Array.from({ length: 1536 }, (_, index) => index === 0 ? 0.1 : 0).join(",")}]`;
      await pool.query(
        `INSERT INTO knowledge_embeddings
           (organization_id, project_id, task_id, source_type, source_id, chunk_index,
            content, content_hash, embedding, metadata)
         VALUES ($1, $2, $3, 'task', $3, 0, $4, $5, $6::vector, '{}'::jsonb)
         ON CONFLICT (source_type, source_id, chunk_index)
         DO UPDATE SET organization_id = EXCLUDED.organization_id,
           project_id = EXCLUDED.project_id, task_id = EXCLUDED.task_id,
           content = EXCLUDED.content, content_hash = EXCLUDED.content_hash,
           embedding = EXCLUDED.embedding`,
        [
          organizationId,
          projectId,
          taskId,
          sentinelKnowledge,
          crypto.createHash("sha256").update(sentinelKnowledge).digest("hex"),
          fixedVector,
        ],
      );
      const authorizedKnowledge = await api(
        `/knowledge/search?q=tenant&organizationId=${organizationId}`,
        { token: owner.token },
      );
      assert.equal(authorizedKnowledge.status, 200, JSON.stringify(authorizedKnowledge.payload));
      assert.ok(authorizedKnowledge.payload.results.some((result) => result.content === sentinelKnowledge));
      const projectUnauthorizedKnowledge = await api(
        `/knowledge/search?q=tenant&organizationId=${organizationId}`,
        { token: organizationMember.token },
      );
      assert.equal(projectUnauthorizedKnowledge.status, 200);
      assert.equal(
        projectUnauthorizedKnowledge.payload.results.some((result) => result.content === sentinelKnowledge),
        false,
        "Organization members without project/task access must not retrieve private task embeddings.",
      );
      assert.equal((await api(`/ai/task/${taskId}/agent`, {
        method: "POST",
        token: outsider.token,
        body: { message: "List all tasks in this project." },
      })).status, 403, "AI tool execution must reject an outsider before tool invocation.");
      assert.equal((await api(`/tasks/${taskId}`, {
        method: "PUT",
        token: outsider.token,
        body: { title: "Cross-tenant modification" },
      })).status, 403);
      assert.equal((await api(`/tasks/${taskId}`, {
        method: "DELETE",
        token: outsider.token,
      })).status, 403);
      assert.equal((await api(`/comments/task/${taskId}`, {
        method: "POST",
        token: outsider.token,
        body: { content: "Cross-tenant comment attempt." },
      })).status, 403);
      assert.equal((await api(
        `/knowledge/search?q=tenant&organizationId=${organizationId}`,
        { token: outsider.token },
      )).status, 403);
      const targetTaskEvents = (name) => socketEvents.get(name)
        .filter((event) => Number(event.id) === Number(taskId));
      await Promise.all([
        waitForCount(() => targetTaskEvents("owner").length, 1, "owner task-create event"),
        waitForCount(() => targetTaskEvents("guest").length, 1, "assignee task-create event"),
        waitForCount(() => targetTaskEvents("projectAdmin").length, 1, "project-admin task-create event"),
      ]);
      await wait(150);
      assert.deepEqual(targetTaskEvents("owner"), [{ id: Number(taskId) }]);
      assert.deepEqual(targetTaskEvents("guest"), [{ id: Number(taskId) }]);
      assert.deepEqual(targetTaskEvents("observer"), []);
      assert.deepEqual(targetTaskEvents("outsider"), []);
      assert.deepEqual(targetTaskEvents("organizationAdmin"), []);
      assert.deepEqual(targetTaskEvents("organizationMember"), []);
      assert.deepEqual(targetTaskEvents("projectAdmin"), [{ id: Number(taskId) }]);
      assert.equal((await api(`/comments/task/${taskId}`, { token: observer.token })).status, 403);
      assert.equal((await api(`/comments/task/${taskId}`, { token: organizationAdmin.token })).status, 403);
      assert.equal((await api(`/comments/task/${taskId}`, { token: organizationMember.token })).status, 403);
      assert.equal((await api(`/comments/task/${taskId}`, { token: projectAdmin.token })).status, 200);
      assert.equal((await api(`/comments/task/${taskId}`)).status, 401);

      for (const socket of [observerSocket, outsiderSocket, organizationAdminSocket, organizationMemberSocket]) {
        const roomError = new Promise((resolve, reject) => {
          const timeout = setTimeout(() => reject(new Error("Unauthorized guessed room join was not rejected.")), 3000);
          socket.once("task_room_error", (payload) => {
            clearTimeout(timeout);
            resolve(payload);
          });
        });
        socket.emit("join_task", taskId);
        assert.deepEqual(await roomError, { message: "Task access required." });
      }
      ownerSocket.emit("join_task", taskId);
      guestSocket.emit("join_task", taskId);
      projectAdminSocket.emit("join_task", taskId);
      outsiderSocket.emit("join_project", projectId);
      outsiderSocket.emit("join_organization", organizationId);

      const rejectedMutation = await api(`/tasks/${taskId}`, {
        method: "PUT",
        token: outsider.token,
        body: { title: "Unauthorized task change" },
      });
      assert.equal(rejectedMutation.status, 403);
      await wait(150);
      assert.equal(targetTaskEvents("owner").length, 1);
      assert.equal(targetTaskEvents("guest").length, 1);
      assert.equal(targetTaskEvents("observer").length, 0);
      assert.equal(targetTaskEvents("outsider").length, 0);
      assert.equal(targetTaskEvents("organizationAdmin").length, 0);
      assert.equal(targetTaskEvents("organizationMember").length, 0);

      const taskMemory = await api("/ai/memories", {
        method: "POST",
        token: owner.token,
        body: {
          type: "requirement",
          content: "Task-scoped memory is visible only within authorized task access.",
          taskId,
          projectId,
          organizationId,
        },
      });
      assert.equal(taskMemory.status, 201, JSON.stringify(taskMemory.payload));
      assert.equal((await pool.query(
        "SELECT embedding IS NOT NULL AS embedded FROM ai_memories WHERE id = $1",
        [taskMemory.payload.data.id],
      )).rows[0].embedded, true, "The test embedding adapter must exercise vector persistence.");
      for (const mismatchedScope of [
        { projectId: Number(projectId) + 1 },
        { organizationId: Number(organizationId) + 1 },
      ]) {
        const rejectedTaskMemory = await api("/ai/memories", {
          method: "POST",
          token: owner.token,
          body: {
            type: "requirement",
            content: `Reject mismatched task scope ${JSON.stringify(mismatchedScope)}.`,
            taskId,
            ...mismatchedScope,
          },
        });
        assert.equal(rejectedTaskMemory.status, 403);
      }
      const guestTaskMemories = await api(`/ai/memories?taskId=${taskId}`, {
        token: guest.token,
      });
      assert.equal(guestTaskMemories.status, 200);
      assert.equal(
        guestTaskMemories.payload.data.some(
          (memory) => String(memory.id) === String(taskMemory.payload.data.id),
        ),
        true,
        "A user authorized for the task can retrieve its scoped memory.",
      );
      assert.equal((await api(`/ai/memories?taskId=${taskId}`, {
        token: outsider.token,
      })).status, 403);

      const taskPersisted = await pool.query(
        "SELECT title, assignee_id FROM tasks WHERE id = $1",
        [taskId],
      );
      assert.equal(taskPersisted.rows[0].title, "Persisted integration task");
      assert.equal(String(taskPersisted.rows[0].assignee_id), String(guest.user.id));
      assert.equal((await pool.query(
        "SELECT 1 FROM notifications WHERE user_id = $1 AND type = 'task_assigned' AND message LIKE $2",
        [guest.user.id, "%Persisted integration task%"],
      )).rowCount, 1);
      const createActivity = await pool.query(
        "SELECT action, new_value FROM task_activity WHERE task_id = $1 ORDER BY id",
        [taskId],
      );
      assert.deepEqual(createActivity.rows, [{ action: "created", new_value: "Persisted integration task" }]);
      assert.equal((await api(`/tasks/${taskId}`, { token: guest.token })).status, 200);
      assert.equal((await api(`/tasks/${taskId}`, { token: outsider.token })).status, 403);
      assert.equal((await api(`/comments/task/${taskId}`, { token: outsider.token })).status, 403);
      assert.equal((await api("/tasks/9223372036854775000", { token: owner.token })).status, 400);

      const updatedTask = await api(`/tasks/${taskId}`, {
        method: "PUT",
        token: owner.token,
        body: {
          title: "Updated integration task",
          description: "Changed in PostgreSQL.",
          status: "done",
          priority: "high",
          assigneeId: guest.user.id,
        },
      });
      assert.equal(updatedTask.status, 200, JSON.stringify(updatedTask.payload));
      await Promise.all([
        waitForCount(() => targetTaskEvents("owner").length, 2, "owner task-update event"),
        waitForCount(() => targetTaskEvents("guest").length, 2, "assignee task-update event"),
        waitForCount(() => targetTaskEvents("projectAdmin").length, 2, "project-admin task-update event"),
      ]);
      assert.deepEqual(targetTaskEvents("owner")[1], { id: Number(taskId) });
      assert.deepEqual(targetTaskEvents("guest")[1], { id: Number(taskId) });
      assert.equal(targetTaskEvents("observer").length, 0);
      assert.equal(targetTaskEvents("outsider").length, 0);
      const updatedPersisted = await pool.query(
        `SELECT t.title, t.status, t.priority, ps.key AS status_key
         FROM tasks t LEFT JOIN project_statuses ps ON ps.id = t.status_id
         WHERE t.id = $1`,
        [taskId],
      );
      assert.deepEqual(updatedPersisted.rows[0], {
        title: "Updated integration task",
        status: "done",
        priority: "high",
        status_key: "done",
      });
      const taskActivity = await pool.query(
        "SELECT action FROM task_activity WHERE task_id = $1 ORDER BY id",
        [taskId],
      );
      assert.deepEqual(taskActivity.rows.map((entry) => entry.action), [
        "created",
        "title_changed",
        "status_changed",
        "priority_changed",
      ]);

      const assignedToObserver = await api(`/tasks/${taskId}`, {
        method: "PUT",
        token: owner.token,
        body: { assigneeId: observer.user.id },
      });
      assert.equal(assignedToObserver.status, 200);
      await Promise.all([
        waitForCount(() => targetTaskEvents("owner").length, 3, "owner after task reassignment"),
        waitForCount(() => targetTaskEvents("projectAdmin").length, 3, "project admin after task reassignment"),
        waitForCount(() => targetTaskEvents("observer").length, 1, "new assignee task event"),
      ]);
      assert.equal(targetTaskEvents("guest").length, 2, "The former assignee must stop receiving task events.");

      const reassignedToGuest = await api(`/tasks/${taskId}`, {
        method: "PUT",
        token: owner.token,
        body: { assigneeId: guest.user.id },
      });
      assert.equal(reassignedToGuest.status, 200);
      await Promise.all([
        waitForCount(() => targetTaskEvents("owner").length, 4, "owner after task reassignment back"),
        waitForCount(() => targetTaskEvents("projectAdmin").length, 4, "project admin after task reassignment back"),
        waitForCount(() => targetTaskEvents("guest").length, 3, "restored assignee task event"),
      ]);
      assert.equal(targetTaskEvents("observer").length, 1, "A former assignee must stop receiving task events.");

      const agentDeletionTask = await api("/tasks", {
        method: "POST",
        token: owner.token,
        body: { projectId, title: "Agent deletion confirmation task" },
      });
      assert.equal(agentDeletionTask.status, 201, JSON.stringify(agentDeletionTask.payload));
      const agentDeletionTaskId = agentDeletionTask.payload.data.id;
      assert.equal((await api("/ai/task/not-an-id/agent", {
        method: "POST",
        token: owner.token,
        body: { message: "Delete this task" },
      })).status, 400);
      const firstDeleteAttempt = await api(`/ai/task/${agentDeletionTaskId}/agent`, {
        method: "POST",
        token: owner.token,
        body: { message: "Delete this task" },
      });
      assert.equal(firstDeleteAttempt.status, 200, JSON.stringify(firstDeleteAttempt.payload));
      assert.equal(firstDeleteAttempt.payload.data.requiresConfirmation, true);
      assert.ok(firstDeleteAttempt.payload.data.confirmationToken);
      assert.equal((await pool.query(
        "SELECT 1 FROM tasks WHERE id = $1",
        [agentDeletionTaskId],
      )).rowCount, 1, "The first tool call must not delete without explicit confirmation.");

      const invalidConfirmation = await api(`/ai/task/${agentDeletionTaskId}/agent`, {
        method: "POST",
        token: owner.token,
        body: { message: "Delete this task", confirmationToken: "invalid-token" },
      });
      assert.equal(invalidConfirmation.status, 403);
      assert.equal((await pool.query(
        "SELECT 1 FROM tasks WHERE id = $1",
        [agentDeletionTaskId],
      )).rowCount, 1);
      const wrongUserConfirmation = await api(`/ai/task/${agentDeletionTaskId}/agent`, {
        method: "POST",
        token: guest.token,
        body: {
          message: "Delete this task",
          confirmationToken: firstDeleteAttempt.payload.data.confirmationToken,
          confirmationAction: "delete_task",
        },
      });
      assert.equal(wrongUserConfirmation.status, 403);

      const wrongTaskConfirmation = await api(`/ai/task/${taskId}/agent`, {
        method: "POST",
        token: owner.token,
        body: {
          message: "Delete this task",
          confirmationToken: firstDeleteAttempt.payload.data.confirmationToken,
          confirmationAction: "delete_task",
        },
      });
      assert.equal(wrongTaskConfirmation.status, 403);

      const wrongActionConfirmation = await api(`/ai/task/${agentDeletionTaskId}/agent`, {
        method: "POST",
        token: owner.token,
        body: {
          message: "Delete this task",
          confirmationToken: firstDeleteAttempt.payload.data.confirmationToken,
          confirmationAction: "update_task",
        },
      });
      assert.equal(wrongActionConfirmation.status, 403);

      const confirmedDelete = await api(`/ai/task/${agentDeletionTaskId}/agent`, {
        method: "POST",
        token: owner.token,
        body: {
          message: "Delete this task",
          confirmationToken: firstDeleteAttempt.payload.data.confirmationToken,
          confirmationAction: "delete_task",
        },
      });
      assert.equal(confirmedDelete.status, 200, JSON.stringify(confirmedDelete.payload));
      assert.equal(confirmedDelete.payload.data.deleted, true);
      assert.equal((await pool.query(
        "SELECT 1 FROM tasks WHERE id = $1",
        [agentDeletionTaskId],
      )).rowCount, 0);
      const confirmationJti = require("jsonwebtoken")
        .decode(firstDeleteAttempt.payload.data.confirmationToken).jti;
      assert.equal((await pool.query(
        "SELECT 1 FROM task_agent_confirmations WHERE jti = $1",
        [confirmationJti],
      )).rowCount, 1, "Consumed confirmations remain recorded after task deletion.");

      const concurrentAgentTask = await api("/tasks", {
        method: "POST",
        token: owner.token,
        body: { projectId, title: "Concurrent agent confirmation task" },
      });
      assert.equal(concurrentAgentTask.status, 201);
      const concurrentTaskId = concurrentAgentTask.payload.data.id;
      const concurrentDeleteRequest = await api(`/ai/task/${concurrentTaskId}/agent`, {
        method: "POST",
        token: owner.token,
        body: { message: "Delete this task" },
      });
      const concurrentConfirmationToken = concurrentDeleteRequest.payload.data.confirmationToken;
      const confirmedInParallel = await Promise.all([1, 2].map(() => api(
        `/ai/task/${concurrentTaskId}/agent`,
        {
          method: "POST",
          token: owner.token,
          body: {
            message: "Confirm deletion",
            confirmationToken: concurrentConfirmationToken,
            confirmationAction: "delete_task",
          },
        },
      )));
      assert.equal(confirmedInParallel.filter((entry) => entry.status === 200).length, 1);
      assert.ok(confirmedInParallel.every((entry) => [200, 404, 409].includes(entry.status)));
      assert.equal((await pool.query(
        `SELECT COUNT(*)::int AS count
         FROM task_agent_confirmations WHERE jti = $1`,
        [require("jsonwebtoken").decode(concurrentConfirmationToken).jti],
      )).rows[0].count, 1);
      const successfulDeleteAudits = await pool.query(
        `SELECT COUNT(*)::int AS count
         FROM task_agent_tool_events
         WHERE user_id = $1 AND tool_name = 'delete_task'
           AND outcome = 'succeeded'`,
        [owner.user.id],
      );
      assert.ok(successfulDeleteAudits.rows[0].count >= 2);

      const replayedConfirmation = await api(`/ai/task/${agentDeletionTaskId}/agent`, {
        method: "POST",
        token: owner.token,
        body: {
          message: "Delete this task",
          confirmationToken: firstDeleteAttempt.payload.data.confirmationToken,
          confirmationAction: "delete_task",
        },
      });
      assert.equal(replayedConfirmation.status, 404, "A deleted target cannot be replayed.");

      const memberComment = await api(`/comments/task/${taskId}`, {
        method: "POST",
        token: guest.token,
        body: { content: "Comment persisted by an authorized task assignee." },
      });
      assert.equal(memberComment.status, 201, JSON.stringify(memberComment.payload));
      const commentId = memberComment.payload.data.id;
      const commentPersisted = await pool.query(
        "SELECT content, user_id FROM task_comments WHERE id = $1",
        [commentId],
      );
      assert.equal(commentPersisted.rows[0].content, "Comment persisted by an authorized task assignee.");
      assert.equal(String(commentPersisted.rows[0].user_id), String(guest.user.id));
      assert.equal((await pool.query(
        "SELECT 1 FROM task_activity WHERE task_id = $1 AND action = 'commented' AND user_id = $2",
        [taskId, guest.user.id],
      )).rowCount, 1);
      assert.equal((await api(`/comments/task/${taskId}`, { token: outsider.token })).status, 403);
      assert.equal((await api(`/comments/task/${taskId}`, { token: observer.token })).status, 403);
      assert.equal((await api(`/comments/task/${taskId}`, { token: organizationAdmin.token })).status, 403);
      assert.equal((await api(`/comments/task/${taskId}`, { token: organizationMember.token })).status, 403);
      assert.equal((await api(`/comments/${commentId}`, {
        method: "DELETE",
        token: guest.token,
      })).status, 403);
      for (const token of [
        outsider.token,
        observer.token,
        organizationAdmin.token,
        organizationMember.token,
      ]) {
        assert.equal((await api(`/comments/task/${taskId}`, {
          method: "POST",
          token,
          body: { content: "Unauthorized private comment." },
        })).status, 403);
      }
      await wait(100);
      await Promise.all([
        waitForCount(() => commentEvents.get("owner").added.length, 1, "owner private comment event"),
        waitForCount(() => commentEvents.get("guest").added.length, 1, "assignee private comment event"),
        waitForCount(() => commentEvents.get("projectAdmin").added.length, 1, "project-admin private comment event"),
      ]);
      assert.equal(commentEvents.get("owner").added.length, 1);
      assert.equal(commentEvents.get("guest").added.length, 1);
      assert.equal(commentEvents.get("projectAdmin").added.length, 1);
      assert.equal(commentEvents.get("owner").added[0].content, "Comment persisted by an authorized task assignee.");
      assert.deepEqual(commentEvents.get("observer").added, []);
      assert.deepEqual(commentEvents.get("outsider").added, []);
      assert.deepEqual(commentEvents.get("organizationAdmin").added, []);
      assert.deepEqual(commentEvents.get("organizationMember").added, []);

      const listedComments = await api(`/comments/task/${taskId}`, { token: owner.token });
      assert.equal(listedComments.status, 200);
      assert.equal(listedComments.payload.data.some((comment) => comment.id === commentId), true);
      assert.equal((await api(`/comments/task/${taskId}`, { token: projectAdmin.token })).status, 200);

      const deletedComment = await api(`/comments/${commentId}`, {
        method: "DELETE",
        token: projectAdmin.token,
      });
      assert.equal(deletedComment.status, 200);
      await Promise.all([
        waitForCount(() => commentEvents.get("owner").deleted.length, 1, "owner comment-deleted event"),
        waitForCount(() => commentEvents.get("guest").deleted.length, 1, "assignee comment-deleted event"),
        waitForCount(() => commentEvents.get("projectAdmin").deleted.length, 1, "project-admin comment-deleted event"),
      ]);
      assert.equal(Number(commentEvents.get("owner").deleted[0]), Number(commentId));
      for (const name of ["observer", "outsider", "organizationAdmin", "organizationMember"]) {
        assert.deepEqual(commentEvents.get(name).added, []);
        assert.deepEqual(commentEvents.get(name).deleted, []);
      }
      assert.equal((await pool.query("SELECT 1 FROM task_comments WHERE id = $1", [commentId])).rowCount, 0);
      assert.equal((await pool.query(
        "SELECT 1 FROM task_activity WHERE task_id = $1 AND action = 'comment_deleted'",
        [taskId],
      )).rowCount, 1);

      const revokedComment = await api(`/comments/task/${taskId}`, {
        method: "POST",
        token: guest.token,
        body: { content: "Comment after a project-admin socket session is revoked." },
      });
      assert.equal(revokedComment.status, 201);
      await waitForCount(
        () => commentEvents.get("projectAdmin").added.length,
        2,
        "project-admin comment event before session revocation",
      );
      const projectAdminEventsBeforeRevocation = commentEvents.get("projectAdmin").added.length;
      const projectAdminDisconnected = new Promise((resolve) => {
        projectAdminSocket.once("disconnect", resolve);
      });
      await pool.query(
        "UPDATE users SET auth_version = auth_version + 1 WHERE id = $1",
        [projectAdmin.user.id],
      );
      assert.equal((await api(`/comments/task/${taskId}`, {
        token: projectAdmin.token,
      })).status, 401);
      const commentAfterRevocation = await api(`/comments/task/${taskId}`, {
        method: "POST",
        token: guest.token,
        body: { content: "This event must not reach the revoked session." },
      });
      assert.equal(commentAfterRevocation.status, 201);
      await projectAdminDisconnected;
      assert.equal(commentEvents.get("projectAdmin").added.length, projectAdminEventsBeforeRevocation);
      await waitForCount(() => commentEvents.get("owner").added.length, 3, "owner comment after revocation");
      await waitForCount(() => commentEvents.get("guest").added.length, 3, "assignee comment after revocation");

      const archivedProject = await api(`/projects/${projectId}`, {
        method: "PUT",
        token: owner.token,
        body: { name: "Archived integration project", status: "archived" },
      });
      assert.equal(archivedProject.status, 200);
      assert.equal((await pool.query(
        "SELECT status FROM projects WHERE id = $1",
        [projectId],
      )).rows[0].status, "archived");

      const deletedTask = await api(`/tasks/${taskId}`, {
        method: "DELETE",
        token: owner.token,
      });
      assert.equal(deletedTask.status, 200);
      await Promise.all([
        waitForCount(() => targetTaskEvents("owner").length, 5, "owner task-delete event"),
        waitForCount(() => targetTaskEvents("guest").length, 4, "assignee task-delete event"),
      ]);
      assert.deepEqual(targetTaskEvents("owner")[4], { id: Number(taskId), deleted: true });
      assert.deepEqual(targetTaskEvents("guest")[3], { id: Number(taskId), deleted: true });
      assert.equal(targetTaskEvents("observer").length, 1);
      assert.equal(targetTaskEvents("outsider").length, 0);
      assert.equal(targetTaskEvents("organizationAdmin").length, 0);
      assert.equal(targetTaskEvents("organizationMember").length, 0);
      assert.equal(targetTaskEvents("projectAdmin").length, 4);
      assert.equal((await pool.query("SELECT 1 FROM tasks WHERE id = $1", [taskId])).rowCount, 0);
      assert.equal((await api(`/tasks/${taskId}`, { token: owner.token })).status, 404);

      await pool.query(
        "UPDATE project_members SET role = 'project_admin' WHERE project_id = $1 AND user_id = $2",
        [projectId, observer.user.id],
      );
      const raceTask = await api("/tasks", {
        method: "POST",
        token: owner.token,
        body: { projectId, title: "Permission change during task deletion", assigneeId: guest.user.id },
      });
      assert.equal(raceTask.status, 201, JSON.stringify(raceTask.payload));
      const raceTaskId = raceTask.payload.data.id;
      const targetRaceEvents = (name) => socketEvents.get(name)
        .filter((event) => Number(event.id) === Number(raceTaskId));
      await waitForCount(() => targetRaceEvents("observer").length, 1, "new project-admin race task event");

      const membershipClient = await pool.connect();
      let raceDeleteSettled = false;
      let raceDeletePromise;
      let membershipTransactionStarted = false;
      try {
        await membershipClient.query("BEGIN");
        membershipTransactionStarted = true;
        await membershipClient.query(
          "UPDATE project_members SET role = 'member' WHERE project_id = $1 AND user_id = $2",
          [projectId, observer.user.id],
        );
        raceDeletePromise = api(`/tasks/${raceTaskId}`, {
          method: "DELETE",
          token: owner.token,
        }).then((result) => {
          raceDeleteSettled = true;
          return result;
        });
        await waitForDatabaseLock("project_members", "task deletion to block on membership change");
        assert.equal(
          raceDeleteSettled,
          false,
          "Task deletion must wait for in-flight membership changes before capturing its audience.",
        );
      } finally {
        if (membershipTransactionStarted) await membershipClient.query("COMMIT");
        membershipClient.release();
      }
      const raceDelete = await raceDeletePromise;
      assert.equal(raceDelete.status, 200, JSON.stringify(raceDelete.payload));
      await Promise.all([
        waitForCount(() => targetRaceEvents("owner").length, 2, "owner race-task deletion event"),
        waitForCount(() => targetRaceEvents("guest").length, 2, "assignee race-task deletion event"),
      ]);
      assert.equal(targetRaceEvents("observer").length, 1);
      assert.deepEqual(targetRaceEvents("observer")[0], { id: Number(raceTaskId) });

      const revokedSocketTask = await api("/tasks", {
        method: "POST",
        token: owner.token,
        body: {
          projectId,
          title: "Revoked socket session task",
          assigneeId: guest.user.id,
        },
      });
      assert.equal(revokedSocketTask.status, 201);
      const revokedSocketTaskId = revokedSocketTask.payload.data.id;
      assert.equal((await api(`/comments/task/${revokedSocketTaskId}`, {
        token: observer.token,
      })).status, 403, "A downgraded project member must lose task access.");
      const downgradedJoinError = new Promise((resolve, reject) => {
        const timeout = setTimeout(() => reject(new Error("Downgraded member joined a task room.")), 3000);
        observerSocket.once("task_room_error", (payload) => {
          clearTimeout(timeout);
          resolve(payload);
        });
      });
      observerSocket.emit("join_task", revokedSocketTaskId);
      assert.deepEqual(await downgradedJoinError, { message: "Task access required." });
      const revokedTaskEvents = () => socketEvents.get("guest")
        .filter((event) => Number(event.id) === Number(revokedSocketTaskId));
      await waitForCount(() => revokedTaskEvents().length, 1, "assignee task-create event before revocation");
      const guestEventCountBeforeRevocation = revokedTaskEvents().length;
      const guestDisconnected = new Promise((resolve) => guestSocket.once("disconnect", resolve));
      await pool.query(
        "UPDATE users SET auth_version = auth_version + 1 WHERE id = $1",
        [guest.user.id],
      );
      const changeWithRevokedSocket = await api(`/tasks/${revokedSocketTaskId}`, {
        method: "PUT",
        token: owner.token,
        body: { title: "Change after assignee session revocation" },
      });
      assert.equal(changeWithRevokedSocket.status, 200);
      await guestDisconnected;
      assert.equal(
        revokedTaskEvents().length,
        guestEventCountBeforeRevocation,
        "A revoked Socket.IO session must not receive subsequent task events.",
      );

      const membershipRevocationTask = await api("/tasks", {
        method: "POST",
        token: owner.token,
        body: { projectId, title: "Organization membership revocation boundary", assigneeId: guest.user.id },
      });
      assert.equal(membershipRevocationTask.status, 201, JSON.stringify(membershipRevocationTask.payload));
      const membershipRevocationTaskId = membershipRevocationTask.payload.data.id;
      const revokedMemberTaskEvents = () => socketEvents.get("revokedMember")
        .filter((event) => Number(event.id) === Number(membershipRevocationTaskId));
      await waitForCount(
        () => revokedMemberTaskEvents().length,
        1,
        "project admin receives task event before organization membership removal",
      );

      const revokedMemberProjectRead = await api(`/projects/${projectId}`, {
        token: revokedMember.token,
      });
      assert.equal(revokedMemberProjectRead.status, 200);
      const removedMembership = await api(
        `/organizations/${organizationId}/members/${revokedMember.user.id}`,
        { method: "DELETE", token: owner.token },
      );
      assert.equal(removedMembership.status, 200, JSON.stringify(removedMembership.payload));
      assert.equal((await pool.query(
        `SELECT 1 FROM project_members WHERE project_id = $1 AND user_id = $2`,
        [projectId, revokedMember.user.id],
      )).rowCount, 0, "Organization removal must also remove stale project access.");
      assert.equal((await api(`/projects/${projectId}`, {
        token: revokedMember.token,
      })).status, 404);
      assert.equal((await api(`/projects/${projectId}/statuses`, {
        token: revokedMember.token,
      })).status, 403);
      assert.equal((await api(`/tasks/${membershipRevocationTaskId}`, {
        token: revokedMember.token,
      })).status, 403);
      assert.equal((await api(`/tasks/${membershipRevocationTaskId}`, {
        method: "PUT",
        token: revokedMember.token,
        body: { title: "Cross-tenant after membership revocation" },
      })).status, 403);
      assert.equal((await api(`/tasks/${membershipRevocationTaskId}`, {
        method: "DELETE",
        token: revokedMember.token,
      })).status, 403);
      assert.equal((await api(`/comments/task/${membershipRevocationTaskId}`, {
        token: revokedMember.token,
      })).status, 403);
      assert.equal((await api(`/ai/task/${membershipRevocationTaskId}/chat/history`, {
        token: revokedMember.token,
      })).status, 403);
      assert.equal((await api(`/ai/task/${membershipRevocationTaskId}/agent`, {
        method: "POST",
        token: revokedMember.token,
        body: { message: "List all tasks." },
      })).status, 403);
      assert.equal((await api(`/ai/memories?projectId=${projectId}`, {
        token: revokedMember.token,
      })).status, 403);
      assert.equal((await api(
        `/knowledge/search?q=tenant&organizationId=${organizationId}`,
        { token: revokedMember.token },
      )).status, 403);

      const taskComment = await api(`/comments/task/${membershipRevocationTaskId}`, {
        method: "POST",
        token: owner.token,
        body: { content: "Comment to protect after membership revocation." },
      });
      assert.equal(taskComment.status, 201, JSON.stringify(taskComment.payload));
      assert.equal((await api(`/comments/${taskComment.payload.data.id}`, {
        method: "DELETE",
        token: revokedMember.token,
      })).status, 403, "Guessing a comment ID must not bypass revoked task access.");

      const changeAfterMembershipRevocation = await api(`/tasks/${membershipRevocationTaskId}`, {
        method: "PUT",
        token: owner.token,
        body: { title: "Changed after organization member removal" },
      });
      assert.equal(changeAfterMembershipRevocation.status, 200);
      await wait(100);
      assert.equal(
        revokedMemberTaskEvents().length,
        1,
        "A connected socket removed from the organization must not receive subsequent task events.",
      );
    });

    await t.test("database constraints reject duplicate and cross-organization memberships", async () => {
      const orgId = organizationIds[0];
      await pool.query(
        "DELETE FROM organization_members WHERE organization_id = $1 AND role = 'admin'",
        [orgId],
      );
      const ownerUser = await pool.query(
        "SELECT id FROM users WHERE email = $1",
        [fixtureEmails.find((email) => email.includes("-owner-"))],
      );
      const outsiderUser = await pool.query(
        "SELECT id FROM users WHERE email = $1",
        [fixtureEmails.find((email) => email.includes("-outsider-"))],
      );
      assert.equal(ownerUser.rowCount, 1);
      assert.equal(outsiderUser.rowCount, 1);

      const duplicateMembership = await pool.query(
        `SELECT COUNT(*)::int AS count FROM organization_members
         WHERE organization_id = $1 AND user_id = $2`,
        [orgId, ownerUser.rows[0].id],
      );
      assert.equal(duplicateMembership.rows[0].count, 1);
      await assert.rejects(
        pool.query(
          "INSERT INTO organization_members (organization_id, user_id, role) VALUES ($1, $2, 'user')",
          [orgId, ownerUser.rows[0].id],
        ),
        (error) => error.code === "23505",
      );

      const foreignProject = await pool.query(
        `INSERT INTO projects (organization_id, name, created_by)
         VALUES ($1, 'invalid cross-organization fixture', $2)
         RETURNING id`,
        [orgId, ownerUser.rows[0].id],
      );
      try {
        await assert.rejects(
          pool.query(
            "INSERT INTO project_members (project_id, user_id) VALUES ($1, $2)",
            [foreignProject.rows[0].id, outsiderUser.rows[0].id],
          ),
          (error) => error.code === "23514" || error.code === "P0001",
        );
      } finally {
        await pool.query("DELETE FROM projects WHERE id = $1", [foreignProject.rows[0].id]);
      }

      const adminUsers = [];
      for (let index = 0; index < 4; index += 1) {
        const email = `devflow-admin-limit-${crypto.randomUUID()}@example.test`;
        fixtureEmails.push(email);
        const inserted = await pool.query(
          `INSERT INTO users (name, email, password)
           VALUES ($1, $2, 'integration-only-password-hash')
           RETURNING id`,
          [`Admin candidate ${index}`, email],
        );
        adminUsers.push(inserted.rows[0].id);
      }

      const adminResults = await Promise.allSettled(adminUsers.map((userId) =>
        pool.query(
          "INSERT INTO organization_members (organization_id, user_id, role) VALUES ($1, $2, 'admin')",
          [orgId, userId],
        ),
      ));
      assert.equal(adminResults.filter((result) => result.status === "fulfilled").length, 3);
      assert.equal(adminResults.filter((result) => result.status === "rejected").length, 1);
      const adminCount = await pool.query(
        "SELECT COUNT(*)::int AS count FROM organization_members WHERE organization_id = $1 AND role = 'admin'",
        [orgId],
      );
      assert.equal(adminCount.rows[0].count, 3);
    });
  },
);
