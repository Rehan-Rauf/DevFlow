const dns = require("node:dns").promises;
const path = require("node:path");
const { spawnSync } = require("node:child_process");
const { randomBytes } = require("node:crypto");
require("dotenv").config({ path: path.resolve(__dirname, "../.env") });

const { Client } = require("pg");
const databaseName = `devflow_test_phase3a_${randomBytes(4).toString("hex")}`;
const required = ["DB_HOST", "DB_PORT", "DB_USER", "DB_PASSWORD"];

async function connectAdmin() {
  return new Client({
    host: process.env.DB_HOST,
    port: Number(process.env.DB_PORT),
    database: "postgres",
    user: process.env.DB_USER,
    password: process.env.DB_PASSWORD,
  });
}

async function createDatabase() {
  if (required.some((name) => !process.env[name])) {
    throw new Error("Local PostgreSQL configuration is incomplete.");
  }
  if (!/^devflow_test_phase3a_[a-f0-9]{8}$/.test(databaseName)) {
    throw new Error("Refusing to use an unexpected test database name.");
  }
  const addresses = await dns.lookup(process.env.DB_HOST, { all: true });
  if (!addresses.length || addresses.some(
    ({ address }) => address !== "127.0.0.1" && address !== "::1",
  )) {
    throw new Error("Refusing to create a database on a non-loopback host.");
  }

  const client = await connectAdmin();
  await client.connect();
  try {
    await client.query(`CREATE DATABASE "${databaseName}"`);
  } finally {
    await client.end();
  }
}

async function dropDatabase() {
  const client = await connectAdmin();
  await client.connect();
  try {
    await client.query(`DROP DATABASE IF EXISTS "${databaseName}" WITH (FORCE)`);
  } finally {
    await client.end();
  }
}

function run(script, env) {
  const result = spawnSync(process.execPath, [script], {
    cwd: path.resolve(__dirname, ".."),
    env,
    encoding: "utf8",
    timeout: 180_000,
  });
  process.stdout.write(result.stdout || "");
  process.stderr.write(result.stderr || "");
  if (result.status !== 0) {
    throw new Error(`${script} failed with status ${result.status}.`);
  }
}

(async () => {
  let created = false;
  try {
    await createDatabase();
    created = true;
    console.log(`Created isolated database ${databaseName}.`);
    const env = {
      ...process.env,
      DB_NAME: databaseName,
      DEVFLOW_TEST_DATABASE_NAME: databaseName,
      NODE_ENV: "test",
    };
    run("src/db/migrate.js", env);
    run("test/databaseWorkflow.integration.test.js", env);
    console.log("Fresh migrations and PostgreSQL integration tests passed.");
  } finally {
    if (created) {
      await dropDatabase();
      console.log(`Dropped exact disposable database ${databaseName}.`);
    }
  }
})().catch((error) => {
  console.error(error.message);
  process.exitCode = 1;
});
