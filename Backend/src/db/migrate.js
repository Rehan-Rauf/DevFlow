// Import Node.js File System module.
// It is used to read files and folders.
const fs = require("fs");

// Import Node.js Path module.
// It helps create safe file/folder paths.
const path = require("path");

// Import PostgreSQL database connection/pool.
const pool = require("../config/database");


// ============================================================
// MIGRATION FUNCTION
// ============================================================

// This function runs all SQL migration files.
async function migrate() {
  const identity = await pool.query(
    `SELECT current_database() AS database_name, current_schema() AS schema_name,
            inet_server_addr()::text AS server_address, inet_server_port() AS server_port`,
  );
  const {
    database_name: databaseName,
    schema_name: schemaName,
    server_address: serverAddress,
    server_port: serverPort,
  } = identity.rows[0];
  const expectedDatabaseName = process.env.DEVFLOW_EXPECTED_DATABASE_NAME;
  const expectedSchemaName = process.env.DEVFLOW_EXPECTED_SCHEMA_NAME;
  const expectedDatabaseAddress = process.env.DEVFLOW_EXPECTED_DATABASE_ADDRESS;
  const expectedDatabasePort = process.env.DEVFLOW_EXPECTED_DATABASE_PORT;

  if (expectedDatabaseName && databaseName !== expectedDatabaseName) {
    throw new Error(`Connected to unexpected database "${databaseName}".`);
  }
  if (expectedSchemaName && schemaName !== expectedSchemaName) {
    throw new Error(`Connected to unexpected schema "${schemaName}".`);
  }
  if (expectedDatabaseAddress && serverAddress?.split("/")[0] !== expectedDatabaseAddress) {
    throw new Error(`Connected to unexpected PostgreSQL server address "${serverAddress}".`);
  }
  if (expectedDatabasePort && Number(serverPort) !== Number(expectedDatabasePort)) {
    throw new Error(`Connected to unexpected PostgreSQL server port "${serverPort}".`);
  }
  console.log(
    `Connected to PostgreSQL ${serverAddress}:${serverPort}, database ${databaseName}, schema ${schemaName}.`,
  );

  // Create the path to the migrations folder.
  //
  // __dirname = current folder where this JS file exists.
  //
  // Example:
  // Backend/db/runMigrations.js
  //
  // Then this creates:
  // Backend/db/migrations
  const dir = path.join(__dirname, "migrations");


  // Read all files from the migrations folder.
  //
  // filter() keeps only files ending with .sql
  //
  // sort() sorts migration files by filename.
  //
  // Example:
  // 001_create_users.sql
  // 002_create_organizations.sql
  // 003_create_projects.sql
  // 004_create_tasks.sql
  //
  // They will run in this order.
  const files = fs
    .readdirSync(dir)
    .filter((file) => file.endsWith(".sql"))
    .sort();
  const requestedFile = process.argv[2];

  if (process.argv.length > 3) {
    throw new Error("Specify at most one migration filename.");
  }
  if (requestedFile && (!/^\d{3}_[a-z0-9_]+\.sql$/.test(requestedFile) || !files.includes(requestedFile))) {
    throw new Error("Requested migration must be an existing SQL filename in the migrations directory.");
  }

  const migrationsToRun = requestedFile
    ? files.filter((file) => file === requestedFile)
    : files;

  // Apply the full ordered set, or one explicitly requested migration.
  for (const file of migrationsToRun) {

    // Read the SQL file as text.
    //
    // Example:
    // "CREATE TABLE users (...)"
    const sql = fs.readFileSync(
      path.join(dir, file),
      "utf8"
    );


    // Show which migration is currently running.
    console.log(`Running ${file}...`);


    // Send the SQL code to PostgreSQL.
    //
    // PostgreSQL executes whatever SQL
    // is written inside the migration file.
    await pool.query(sql);
  }


  // All migration files have completed successfully.
  console.log("Database migration completed.");


  // Close the PostgreSQL connection pool.
  await pool.end();
}


// ============================================================
// RUN MIGRATION
// ============================================================

// Start the migrate() function.
//
// If any error happens,
// catch() will handle that error.
migrate().catch(async (error) => {

  // Show migration error in terminal.
  console.error("Migration failed:", error);


  // Close database connection.
  await pool.end();


  // Exit Node.js with error code 1.
  //
  // 0 = success
  // 1 = error
  process.exit(1);
});