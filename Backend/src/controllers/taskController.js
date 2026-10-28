// ============================================================
// TASK CONTROLLER
// ============================================================

const pool = require("../config/database");

const {
  ok,
  created,
  fail
} = require("../utils/response");

const knowledgeBaseService = require("../services/knowledgeBaseService");
const { deleteTask: deleteTaskWithAuthorization } = require("../services/retrievalService");
const { isPositiveIntegerId } = require("../utils/validation");

// Re-indexing must never block or break the actual request -
// it just keeps the RAG knowledge base in sync in the background.
function reindexTaskInBackground(taskId) {
  knowledgeBaseService
    .indexTask(taskId)
    .catch((error) => console.error(`Knowledge reindex failed for task ${taskId}:`, error.message));
}


// ============================================================
// TASK STATUS OPTIONS
// ============================================================

const statuses = [
  "backlog",
  "todo",
  "in_progress",
  "in_review",
  "done",
  "cancelled"
];


// ============================================================
// TASK PRIORITY OPTIONS
// ============================================================

const priorities = [
  "no_priority",
  "low",
  "medium",
  "high",
  "urgent"
];

function normalizeDueDate(value) {
  if (value == null || value === "") return { valid: true, value: null };
  if (value instanceof Date && !Number.isNaN(value.getTime())) {
    value = value.toISOString().slice(0, 10);
  }
  if (typeof value !== "string" || !/^\d{4}-\d{2}-\d{2}$/.test(value)) {
    return { valid: false, value: null };
  }
  const parsed = new Date(`${value}T00:00:00.000Z`);
  return Number.isNaN(parsed.getTime()) || parsed.toISOString().slice(0, 10) !== value
    ? { valid: false, value: null }
    : { valid: true, value };
}

// A task keeps its readable status key for compatibility with existing data,
// while the project-owned status record is the source of truth for validity,
// colour, label, and safe deletion checks.
async function getProjectStatus(projectId, key) {
  const result = await pool.query(
    `SELECT id, key, label, color FROM project_statuses WHERE project_id = $1 AND key = $2`,
    [projectId, key],
  );
  return result.rows[0] || null;
}

async function getProjectRoleTag(projectId, roleTagId) {
  if (!roleTagId) return null;
  const result = await pool.query(
    `SELECT id FROM task_role_tags WHERE project_id = $1 AND id = $2`,
    [projectId, roleTagId],
  );
  return result.rows[0] || null;
}

async function recordTaskActivity(client, taskId, userId, action, oldValue = null, newValue = null) {
  await client.query(
    `INSERT INTO task_activity (task_id, user_id, action, old_value, new_value)
     VALUES ($1, $2, $3, $4, $5)`,
    [taskId, userId, action, oldValue, newValue],
  );
}


// ============================================================
// OPENROUTER CONFIGURATION
// ============================================================
//
// Backend/.env:
//
// OPENROUTER_API_KEY=your_key
// OPENROUTER_MODEL=openrouter/free
//
// openrouter/free automatically selects an available
// free model from OpenRouter.
//

const OPENROUTER_URL =
  "https://openrouter.ai/api/v1/chat/completions";

const OPENROUTER_MODEL =
  process.env.OPENROUTER_MODEL ||
  "openrouter/free";


// ============================================================
// CHECK PROJECT ACCESS
// ============================================================

async function projectAccess(userId, projectId) {

  const result = await pool.query(
    `
    SELECT
      p.organization_id,

      EXISTS (
        SELECT 1
        FROM organization_members om
        WHERE om.organization_id = p.organization_id
          AND om.user_id = $1
      ) AS is_org_member,

      EXISTS (
        SELECT 1
        FROM organization_members om
        WHERE om.organization_id = p.organization_id
          AND om.user_id = $1
          AND om.role = 'owner'
      ) AS is_org_owner,

      EXISTS (
        SELECT 1
        FROM organization_members om
        WHERE om.organization_id = p.organization_id
          AND om.user_id = $1
          AND om.role IN ('owner', 'admin')
      ) AS is_org_admin,

      EXISTS (
        SELECT 1
        FROM project_members pm
        WHERE pm.project_id = p.id
          AND pm.user_id = $1
          AND EXISTS (
            SELECT 1 FROM organization_members om
            WHERE om.organization_id = p.organization_id
              AND om.user_id = pm.user_id
          )
      ) AS is_project_member,

      EXISTS (
        SELECT 1
        FROM project_members pm
        WHERE pm.project_id = p.id
          AND pm.user_id = $1
          AND pm.role = 'project_admin'
          AND EXISTS (
            SELECT 1 FROM organization_members om
            WHERE om.organization_id = p.organization_id
              AND om.user_id = pm.user_id
          )
      ) AS is_project_admin

    FROM projects p

    WHERE p.id = $2
    `,
    [
      userId,
      projectId
    ]
  );

  return result.rows[0] || null;
}


// ============================================================
// LIST TASKS
// ============================================================

async function listTasks(req, res) {

  try {

    const {
      projectId
    } = req.query;


    // ========================================================
    // PROJECT TASKS
    // ========================================================

    if (projectId) {

      if (!isPositiveIntegerId(projectId)) {
        return fail(res, 400, "Invalid project ID.");
      }

      const access =
        await projectAccess(
          req.user.id,
          projectId
        );

      if (!access) {

        return fail(
          res,
          404,
          "Project not found."
        );
      }

      if (!access.is_org_member || (!access.is_org_owner && !access.is_project_member)) {

        return fail(
          res,
          403,
          "Project access required."
        );
      }

      const isProjectAdmin = Boolean(access.is_org_owner || access.is_project_admin);
      const taskFilter = isProjectAdmin ? "t.project_id = $1" : "t.project_id = $1 AND t.assignee_id = $2";
      const taskParams = isProjectAdmin ? [projectId] : [projectId, req.user.id];

      const result =
        await pool.query(
          `
          SELECT
            t.*,

            ps.label AS status_label,
            ps.color AS status_color,
            rt.label AS role_tag_label,
            rt.description_template AS role_description_template,

            a.name AS assignee_name,
            c.name AS creator_name,

            p.name AS project_name,
            p.organization_id,

            o.name AS organization_name

          FROM tasks t

          LEFT JOIN project_statuses ps
            ON ps.id = t.status_id

          LEFT JOIN task_role_tags rt
            ON rt.id = t.role_tag_id

          LEFT JOIN users a
            ON a.id = t.assignee_id

          INNER JOIN users c
            ON c.id = t.created_by

          INNER JOIN projects p
            ON p.id = t.project_id

          INNER JOIN organizations o
            ON o.id = p.organization_id

          WHERE ${taskFilter}

          ORDER BY
            CASE t.priority
              WHEN 'urgent' THEN 0
              WHEN 'high' THEN 1
              WHEN 'medium' THEN 2
              WHEN 'low' THEN 3
              ELSE 4
            END,

            t.created_at DESC
          `,
          taskParams
        );


      return ok(
        res,
        result.rows
      );
    }


    // ========================================================
    // ALL ACCESSIBLE TASKS
    // ========================================================

    const result =
      await pool.query(
        `
        SELECT
          t.*,

          ps.label AS status_label,
          ps.color AS status_color,
          rt.label AS role_tag_label,
          rt.description_template AS role_description_template,

          a.name AS assignee_name,
          c.name AS creator_name,

          p.name AS project_name,
          p.organization_id,

          o.name AS organization_name,

          EXISTS (
            SELECT 1 FROM organization_members om
            WHERE om.organization_id = p.organization_id
              AND om.user_id = $2
              AND om.role = 'owner'
          ) AS is_org_owner,

          EXISTS (
            SELECT 1 FROM project_members pm
            WHERE pm.project_id = p.id
              AND pm.user_id = $2
              AND pm.role = 'project_admin'
          ) AS is_project_admin,

          EXISTS (
            SELECT 1 FROM project_members pm
            WHERE pm.project_id = p.id
              AND pm.user_id = $2
          ) AS is_project_member

        FROM tasks t

        LEFT JOIN project_statuses ps
          ON ps.id = t.status_id

        LEFT JOIN task_role_tags rt
          ON rt.id = t.role_tag_id

        LEFT JOIN users a
          ON a.id = t.assignee_id

        INNER JOIN users c
          ON c.id = t.created_by

        INNER JOIN projects p
          ON p.id = t.project_id

        INNER JOIN organizations o
          ON o.id = p.organization_id

        WHERE EXISTS (
          SELECT 1
          FROM organization_members active_member
          WHERE active_member.organization_id = p.organization_id
            AND active_member.user_id = $1
        )
        AND (
          EXISTS (
            SELECT 1
            FROM organization_members om
            WHERE om.organization_id = p.organization_id
              AND om.user_id = $1
              AND om.role = 'owner'
          )
          OR EXISTS (
            SELECT 1
            FROM project_members pm
            WHERE pm.project_id = p.id
              AND pm.user_id = $1
              AND pm.role = 'project_admin'
          )
          OR (
            EXISTS (
              SELECT 1
              FROM project_members pm
              WHERE pm.project_id = p.id
                AND pm.user_id = $1
            )
            AND t.assignee_id = $1
          )
        )

        ORDER BY
          CASE t.priority
            WHEN 'urgent' THEN 0
            WHEN 'high' THEN 1
            WHEN 'medium' THEN 2
            WHEN 'low' THEN 3
            ELSE 4
          END,

          t.created_at DESC
        `,
        [req.user.id, req.user.id]
      );


    return ok(
      res,
      result.rows
    );

  } catch (error) {

    console.error(
      "List tasks error:",
      error
    );

    return fail(
      res,
      500,
      "Unable to load tasks."
    );
  }
}


// ============================================================
// AI TASK ANALYSIS
// ============================================================
//
// POST /api/tasks/analyze
//
// IMPORTANT:
//
// This function ONLY analyzes the task.
//
// It DOES NOT create a database task.
//
// Flow:
//
// User enters task
//       ↓
// Backend checks project
//       ↓
// OpenRouter AI
//       ↓
// valid / invalid
//       ↓
// Frontend shows preview
//       ↓
// User clicks Create Task
//       ↓
// POST /api/tasks
//

async function analyzeTask(req, res) {

  try {

    const {
      message,
      organizationId,
      projectId
    } = req.body;


    // ========================================================
    // BASIC VALIDATION
    // ========================================================

    if (!isPositiveIntegerId(organizationId)) {

      return fail(
        res,
        400,
        "Organization is required."
      );
    }


    if (!isPositiveIntegerId(projectId)) {

      return fail(
        res,
        400,
        "A valid project ID is required."
      );
    }

    if (
      !message ||
      !String(message).trim()
    ) {

      return fail(
        res,
        400,
        "Please describe the task."
      );
    }


    const prompt =
      String(message).trim();


    // ========================================================
    // CHECK PROJECT ACCESS
    // ========================================================

    const access =
      await projectAccess(
        req.user.id,
        projectId
      );


    if (!access) {

      return fail(
        res,
        404,
        "Project not found."
      );
    }


    if (!access.is_org_owner && !access.is_project_member) {

      return fail(
        res,
        403,
        "Project access required."
      );
    }


    // ========================================================
    // CHECK ORGANIZATION / PROJECT MATCH
    // ========================================================

    if (
      Number(access.organization_id) !==
      Number(organizationId)
    ) {

      return fail(
        res,
        400,
        "The selected project does not belong to the selected organization."
      );
    }


    // ========================================================
    // GET PROJECT CONTEXT
    // ========================================================

    const contextResult =
      await pool.query(
        `
        SELECT
          o.id AS organization_id,
          o.name AS organization_name,

          p.id AS project_id,
          p.name AS project_name,
          p.description AS project_description

        FROM projects p

        INNER JOIN organizations o
          ON o.id = p.organization_id

        WHERE p.id = $1
          AND o.id = $2
        `,
        [
          projectId,
          organizationId
        ]
      );


    if (!contextResult.rowCount) {

      return fail(
        res,
        404,
        "Organization or project not found."
      );
    }


    const context =
      contextResult.rows[0];

    const projectStatusesResult = await pool.query(
      `SELECT key FROM project_statuses WHERE project_id = $1 ORDER BY position`,
      [projectId],
    );
    const allowedStatusKeys = projectStatusesResult.rows.map((row) => row.key);


    // ========================================================
    // BASIC PROMPT VALIDATION
    // ========================================================

    if (prompt.length < 10) {

      return ok(
        res,
        {
          valid: false,

          reason:
            "Please enter a meaningful task related to the selected project."
        }
      );
    }


    const words =
      prompt
        .split(/\s+/)
        .filter(Boolean);


    if (words.length < 3) {

      return ok(
        res,
        {
          valid: false,

          reason:
            "Please describe what you want to do in more detail."
        }
      );
    }


    // ========================================================
    // OPENROUTER API KEY
    // ========================================================

    if (
      !process.env.OPENROUTER_API_KEY ||
      !process.env.OPENROUTER_API_KEY.trim()
    ) {

      console.error(
        "OPENROUTER_API_KEY is missing."
      );

      return fail(
        res,
        500,
        "OpenRouter API key is not configured."
      );
    }


    // ========================================================
    // AI SYSTEM PROMPT
    // ========================================================

    const systemPrompt = `
You are an AI task validator for a project management system.

Your job is to decide whether a user's request is a meaningful
task related to the selected project.

Do NOT blindly accept every message.

Reject:

- greetings
- nonsense
- keyboard smashing
- random text
- jokes
- unrelated requests
- requests clearly belonging to another project

Accept meaningful project/work requests.

The request does not need to repeat the exact project name.

Judge the meaning of the request.

Return ONLY valid JSON.

For a valid request:

{
  "valid": true,
  "reason": "",
  "title": "short task title",
  "description": "clear task description",
  "priority": "medium",
  "status": "todo"
}

For an invalid request:

{
  "valid": false,
  "reason": "clear explanation"
}

Allowed priority values:

no_priority
low
medium
high
urgent

Allowed status values for this project:

${allowedStatusKeys.join("\n")}
`;


    // ========================================================
    // AI USER CONTEXT
    // ========================================================

    const userPrompt = `
SELECTED ORGANIZATION:
${context.organization_name}

SELECTED PROJECT:
${context.project_name}

PROJECT DESCRIPTION:
${context.project_description || "No project description provided."}

USER REQUEST:
${prompt}

Determine whether the request is a genuine meaningful task
related to the selected project.
`;


    // ========================================================
    // CALL OPENROUTER
    // ========================================================

    console.log(
      `OpenRouter model: ${OPENROUTER_MODEL}`
    );


    const aiResponse =
      await fetch(
        OPENROUTER_URL,
        {
          method: "POST",

          headers: {
            "Content-Type":
              "application/json",

            Authorization:
              `Bearer ${process.env.OPENROUTER_API_KEY}`,

            "HTTP-Referer":
              "http://localhost:5173",

            "X-Title":
              "DevFlow AI Task Manager"
          },

          body: JSON.stringify({

            model:
              OPENROUTER_MODEL,

            messages: [

              {
                role: "system",

                content:
                  systemPrompt
              },

              {
                role: "user",

                content:
                  userPrompt
              }

            ],

            temperature: 0.1,

            max_tokens: 700
          })
        }
      );


    // ========================================================
    // READ OPENROUTER RESPONSE
    // ========================================================

    const responseText =
      await aiResponse.text();


    // ========================================================
    // OPENROUTER ERROR
    // ========================================================

    if (!aiResponse.ok) {

      console.error(
        "========================================"
      );

      console.error(
        "OPENROUTER ERROR"
      );

      console.error(
        "HTTP STATUS:",
        aiResponse.status
      );

      console.error(
        "MODEL:",
        OPENROUTER_MODEL
      );

      console.error(
        "RESPONSE:",
        responseText
      );

      console.error(
        "========================================"
      );


      return fail(
        res,
        502,
        `OpenRouter error (${aiResponse.status}). Check backend terminal.`
      );
    }


    // ========================================================
    // PARSE OPENROUTER JSON
    // ========================================================

    let aiData;

    try {

      aiData =
        JSON.parse(responseText);

    } catch (error) {

      console.error(
        "OpenRouter returned invalid JSON:",
        responseText
      );

      return fail(
        res,
        502,
        "OpenRouter returned an invalid response."
      );
    }


    // ========================================================
    // GET AI MESSAGE
    // ========================================================

    const aiText =
      aiData?.choices?.[0]?.message?.content;


    if (!aiText) {

      console.error(
        "OpenRouter response has no AI content:",
        aiData
      );

      return fail(
        res,
        502,
        "OpenRouter did not return an AI result."
      );
    }


    // ========================================================
    // CLEAN AI JSON
    // ========================================================

    let cleanText =
      String(aiText).trim();


    // Remove markdown code fences.

    cleanText =
      cleanText
        .replace(/^```json\s*/i, "")
        .replace(/^```\s*/i, "")
        .replace(/\s*```$/i, "")
        .trim();


    // ========================================================
    // PARSE AI RESULT
    // ========================================================

    let result;

    try {

      result =
        JSON.parse(cleanText);

    } catch (error) {

      console.error(
        "AI JSON parse error:",
        error
      );

      console.error(
        "AI returned:",
        cleanText
      );

      return fail(
        res,
        502,
        "AI returned an invalid task analysis."
      );
    }


    // ========================================================
    // VALIDATE AI RESULT
    // ========================================================

    if (
      typeof result.valid !==
      "boolean"
    ) {

      return fail(
        res,
        502,
        "AI task analysis result is invalid."
      );
    }


    // ========================================================
    // INVALID TASK
    // ========================================================

    if (!result.valid) {

      return ok(
        res,
        {
          valid: false,

          reason:
            result.reason ||
            "This does not appear to be a meaningful task for the selected project."
        }
      );
    }


    // ========================================================
    // VALID TASK
    // ========================================================

    const title =
      String(
        result.title ||
        prompt.substring(0, 80)
      )
        .trim()
        .substring(0, 200);


    const description =
      String(
        result.description ||
        prompt
      )
        .trim();


    const priority =
      priorities.includes(
        result.priority
      )
        ? result.priority
        : "medium";


    const status =
      allowedStatusKeys.includes(result.status)
        ? result.status
        : (allowedStatusKeys.includes("todo") ? "todo" : allowedStatusKeys[0]);


    // ========================================================
    // RETURN TASK PREVIEW
    // ========================================================

    return ok(
      res,
      {
        valid: true,

        title,

        description,

        priority,

        status,

        organizationId:
          Number(organizationId),

        projectId:
          Number(projectId)
      }
    );


  } catch (error) {

    console.error(
      "Analyze task error:",
      error
    );

    return fail(
      res,
      500,
      "Unable to analyze the task."
    );
  }
}


// ============================================================
// CREATE TASK
// ============================================================

async function createTask(req, res) {
  let client;
  try {

    const {
      projectId,
      title,
      description = "",
      status = "todo",
      priority = "no_priority",
      assigneeId = null,
      roleTagId = null,
      dueDate = null
    } = req.body;


    // ========================================================
    // PROJECT
    // ========================================================

    if (!isPositiveIntegerId(projectId)) {

      return fail(
        res,
        400,
        "A valid project ID is required."
      );
    }

    if (typeof title !== "string" || !title.trim() || title.trim().length > 240) {
      return fail(res, 400, "Task title is required and must be 240 characters or fewer.");
    }
    if (typeof description !== "string") {
      return fail(res, 400, "Task description must be text.");
    }
    if (assigneeId !== null && !isPositiveIntegerId(assigneeId)) {
      return fail(res, 400, "Invalid assignee ID.");
    }
    if (roleTagId !== null && !isPositiveIntegerId(roleTagId)) {
      return fail(res, 400, "Invalid role tag ID.");
    }


    // ========================================================
    // PROJECT ACCESS
    // ========================================================

    const access =
      await projectAccess(
        req.user.id,
        projectId
      );


    if (!access) {

      return fail(
        res,
        404,
        "Project not found."
      );
    }


    if (!access.is_org_member) {

      return fail(
        res,
        403,
        "Project access required."
      );
    }


    // ========================================================
    // PROJECT ADMIN / OWNER ONLY
    // ========================================================

    if (!access.is_org_owner && !access.is_project_admin) {

      return fail(
        res,
        403,
        "Project administrator permission required."
      );
    }


    // ========================================================
    // TITLE
    // ========================================================

    // ========================================================
    // STATUS
    // ========================================================

    const projectStatus = await getProjectStatus(projectId, status);

    if (!projectStatus) {

      return fail(
        res,
        400,
        "Invalid task status."
      );
    }


    // ========================================================
    // PRIORITY
    // ========================================================

    if (
      !priorities.includes(priority)
    ) {

      return fail(
        res,
        400,
        "Invalid task priority."
      );
    }

    if (roleTagId && !(await getProjectRoleTag(projectId, roleTagId))) {
      return fail(res, 400, "Role tag must belong to this project.");
    }


    // ========================================================
    // ASSIGNEE
    // ========================================================

    if (assigneeId) {

      const eligible =
        await pool.query(
          `
          SELECT 1

          FROM project_members pm
          JOIN projects p ON p.id = pm.project_id
          JOIN organization_members om
            ON om.organization_id = p.organization_id
           AND om.user_id = pm.user_id

          WHERE pm.project_id = $1
            AND pm.user_id = $2
          `,
          [
            projectId,
            assigneeId
          ]
        );


      if (!eligible.rowCount) {

        return fail(
          res,
          403,
          "Task assignee must be a member of this project."
        );
      }
    }


    // ========================================================
    // DUE DATE
    // ========================================================

    const normalizedDate = normalizeDueDate(dueDate);
    if (!normalizedDate.valid) {
      return fail(res, 400, "Due date must be a valid YYYY-MM-DD date.");
    }
    const normalizedDueDate = normalizedDate.value;


    // ========================================================
    // INSERT
    // ========================================================

    client = await pool.connect();
    await client.query("BEGIN");
    const result =
      await client.query(
        `
        INSERT INTO tasks
        (
          project_id,
          title,
          description,
          status,
          status_id,
          priority,
          assignee_id,
          role_tag_id,
          created_by,
          due_date
        )

        VALUES
        (
          $1,
          $2,
          $3,
          $4,
          $5,
          $6,
          $7,
          $8,
          $9,
          $10
        )

        RETURNING *
        `,
        [
          projectId,
          String(title).trim(),
          description,
          status,
          projectStatus.id,
          priority,
          assigneeId,
          roleTagId || null,
          req.user.id,
          normalizedDueDate
        ]
      );


    const createdTask =
      result.rows[0];

    await recordTaskActivity(
      client,
      createdTask.id,
      req.user.id,
      "created",
      null,
      createdTask.title,
    );
    await client.query("COMMIT");

    // ========================================================
    // SOCKET
    // ========================================================

    await req.app.get("emitTaskChanged")(createdTask.id);


    // ========================================================
    // NOTIFICATION
    // ========================================================

    if (assigneeId) {

      try {

        await pool.query(
          `
          INSERT INTO notifications
          (
            user_id,
            title,
            message,
            type
          )

          VALUES
          (
            $1,
            $2,
            $3,
            $4
          )
          `,
          [
            assigneeId,
            "Task assigned",
            `You were assigned: ${String(title).trim()}`,
            "task_assigned"
          ]
        );


        if (io) {

          io.to(`user:${assigneeId}`).emit(
            "notification",
            {
              userId: assigneeId,
              title: "Task assigned",
              message: `You were assigned: ${String(title).trim()}`,
              type: "task_assigned",
            }
          );
        }

      } catch (notificationError) {

        console.error(
          "Notification error:",
          notificationError
        );
      }
    }


    reindexTaskInBackground(createdTask.id);

    return created(
      res,
      createdTask,
      "Task created."
    );


  } catch (error) {

    if (client) {
      await client.query("ROLLBACK").catch(() => {});
    }
    console.error(
      "Create task error:",
      error
    );

    return fail(
      res,
      500,
      "Unable to create task."
    );
  } finally {
    client?.release();
  }
}


// ============================================================
// GET ONE TASK
// ============================================================

async function getTask(req, res) {

  try {

    const {
      id
    } = req.params;


    const taskResult =
      await pool.query(
        `
        SELECT
          t.*,

          ps.label AS status_label,
          ps.color AS status_color,
          rt.label AS role_tag_label,
          rt.description_template AS role_description_template,

          a.name AS assignee_name,
          c.name AS creator_name,

          p.name AS project_name,
          p.organization_id,

          o.name AS organization_name

        FROM tasks t

        LEFT JOIN project_statuses ps
          ON ps.id = t.status_id

        LEFT JOIN task_role_tags rt
          ON rt.id = t.role_tag_id

        LEFT JOIN users a
          ON a.id = t.assignee_id

        INNER JOIN users c
          ON c.id = t.created_by

        INNER JOIN projects p
          ON p.id = t.project_id

        INNER JOIN organizations o
          ON o.id = p.organization_id

        WHERE t.id = $1
        `,
        [id]
      );


    if (!taskResult.rowCount) {

      return fail(
        res,
        404,
        "Task not found."
      );
    }


    const task =
      taskResult.rows[0];


    const access =
      await projectAccess(
        req.user.id,
        task.project_id
      );


    if (
      !access ||
      (!access.is_org_member || (!access.is_org_owner && !access.is_project_member))
    ) {

      return fail(
        res,
        403,
        "Project access required."
      );
    }

    if (
      !access.is_org_owner &&
      !access.is_project_admin &&
      Number(task.assignee_id) !== Number(req.user.id)
    ) {
      return fail(
        res,
        403,
        "Task access required."
      );
    }

    return ok(
      res,
      task
    );


  } catch (error) {

    console.error(
      "Get task error:",
      error
    );

    return fail(
      res,
      500,
      "Unable to load task."
    );
  }
}


// ============================================================
// UPDATE TASK
// ============================================================

async function updateTask(req, res) {
  let client;
  try {

    const {
      id
    } = req.params;


    const existing =
      await pool.query(
        `
        SELECT *
        FROM tasks
        WHERE id = $1
        `,
        [id]
      );


    if (!existing.rowCount) {

      return fail(
        res,
        404,
        "Task not found."
      );
    }


    const task =
      existing.rows[0];


    const access =
      await projectAccess(
        req.user.id,
        task.project_id
      );


    if (
      !access ||
      !access.is_org_member ||
      (!access.is_org_owner && !access.is_project_admin)
    ) {

      return fail(
        res,
        403,
        "Project administrator permission required."
      );
    }


    const {
      title =
        task.title,

      description =
        task.description,

      status =
        task.status,

      priority =
        task.priority,

      assigneeId =
        task.assignee_id,

      roleTagId =
        task.role_tag_id,

      dueDate =
        task.due_date
    } = req.body;

    if (typeof title !== "string" || !title.trim() || title.trim().length > 240) {
      return fail(res, 400, "Task title is required and must be 240 characters or fewer.");
    }
    if (typeof description !== "string") {
      return fail(res, 400, "Task description must be text.");
    }
    if (assigneeId !== null && !isPositiveIntegerId(assigneeId)) {
      return fail(res, 400, "Invalid assignee ID.");
    }
    if (roleTagId !== null && !isPositiveIntegerId(roleTagId)) {
      return fail(res, 400, "Invalid role tag ID.");
    }

    const projectStatus = await getProjectStatus(task.project_id, status);

    if (!projectStatus) {

      return fail(
        res,
        400,
        "Invalid task status."
      );
    }


    if (
      !priorities.includes(priority)
    ) {

      return fail(
        res,
        400,
        "Invalid task priority."
      );
    }

    if (roleTagId && !(await getProjectRoleTag(task.project_id, roleTagId))) {
      return fail(res, 400, "Role tag must belong to this project.");
    }


    if (assigneeId) {

      const eligible =
        await pool.query(
          `
          SELECT 1

          FROM project_members pm
          JOIN projects p ON p.id = pm.project_id
          JOIN organization_members om
            ON om.organization_id = p.organization_id
           AND om.user_id = pm.user_id

          WHERE pm.project_id = $1
            AND pm.user_id = $2
          `,
          [
            task.project_id,
            assigneeId
          ]
        );


      if (!eligible.rowCount) {

        return fail(
          res,
          403,
          "Task assignee must be a member of this project."
        );
      }
    }


    const normalizedDate = normalizeDueDate(dueDate);
    if (!normalizedDate.valid) {
      return fail(res, 400, "Due date must be a valid YYYY-MM-DD date.");
    }
    const normalizedDueDate = normalizedDate.value;


    client = await pool.connect();
    await client.query("BEGIN");
    const result =
      await client.query(
        `
        UPDATE tasks

        SET
          title = $1,
          description = $2,
          status = $3,
          status_id = $4,
          priority = $5,
          assignee_id = $6,
          role_tag_id = $7,
          due_date = $8,
          updated_at = NOW()

        WHERE id = $9

        RETURNING *
        `,
        [
          String(title).trim(),
          description,
          status,
          projectStatus.id,
          priority,
          assigneeId,
          roleTagId || null,
          normalizedDueDate,
          id
        ]
      );


    const updatedTask =
      result.rows[0];

    const activityFields = [
      ["title", task.title, String(title).trim()],
      ["status", task.status, status],
      ["priority", task.priority, priority],
      ["assignee", task.assignee_id, assigneeId],
      ["due_date", task.due_date, normalizedDueDate],
      ["role_tag", task.role_tag_id, roleTagId || null],
    ];
    for (const [field, oldValue, newValue] of activityFields) {
      const oldText = oldValue == null ? null : String(oldValue);
      const newText = newValue == null ? null : String(newValue);
      if (oldText !== newText) {
        await recordTaskActivity(
          client,
          updatedTask.id,
          req.user.id,
          `${field}_changed`,
          oldText,
          newText,
        );
      }
    }
    await client.query("COMMIT");

    await req.app.get("emitTaskChanged")(updatedTask.id);

    reindexTaskInBackground(updatedTask.id);

    return ok(
      res,
      updatedTask,
      "Task updated."
    );


  } catch (error) {

    if (client) {
      await client.query("ROLLBACK").catch(() => {});
    }
    console.error(
      "Update task error:",
      error
    );

    return fail(
      res,
      500,
      "Unable to update task."
    );
  } finally {
    client?.release();
  }
}


// ============================================================
// DELETE TASK
// ============================================================

async function deleteTask(req, res) {

  try {

    const {
      id
    } = req.params;


    const existing =
      await pool.query(
        `
        SELECT project_id
        FROM tasks
        WHERE id = $1
        `,
        [id]
      );


    if (!existing.rowCount) {

      return fail(
        res,
        404,
        "Task not found."
      );
    }


    const access =
      await projectAccess(
        req.user.id,
        existing.rows[0].project_id
      );


    if (
      !access ||
      !access.is_org_member ||
      (!access.is_org_owner && !access.is_project_admin)
    ) {

      return fail(
        res,
        403,
        "Project administrator permission required."
      );
    }

    const deletion = await deleteTaskWithAuthorization({
      taskId: id,
      projectId: existing.rows[0].project_id,
      userId: req.user.id,
    });

    knowledgeBaseService
      .deleteSource("task", Number(id))
      .catch((error) => console.error(`Knowledge cleanup failed for task ${id}:`, error.message));

    await req.app.get("emitTaskChanged")(
      id,
      { deleted: true, audienceUserIds: deletion.audienceUserIds },
    );


    return ok(
      res,
      null,
      "Task deleted."
    );


  } catch (error) {

    console.error(
      "Delete task error:",
      error
    );

    if (error.status === 403 || error.status === 404) {
      return fail(res, error.status, error.message);
    }

    return fail(
      res,
      500,
      "Unable to delete task."
    );
  }
}


// ============================================================
// EXPORT
// ============================================================

module.exports = {

  listTasks,

  analyzeTask,

  createTask,

  getTask,

  updateTask,

  deleteTask

};
