const pool = require("../config/database");
const { ok, created, fail } = require("../utils/response");
const knowledgeBaseService = require("../services/knowledgeBaseService");
const { emitToAuthorizedTaskRoom } = require("../services/taskRoomAuthorization");

/*
 * ============================================================
 * CHECK USER ACCESS TO A TASK
 * ============================================================
 *
 * Returns:
 *   - task information
 *   - project
 *   - organization
 *   - whether user is organization owner
 *   - whether user is project admin
 *   - whether user is project member
 */
async function taskAccess(userId, taskId) {
  const r = await pool.query(
    `
    SELECT
      t.id,
      t.project_id,
      t.assignee_id,
      p.organization_id,

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
      ) AS is_org_member,

      EXISTS (
        SELECT 1
        FROM project_members pm
        WHERE pm.project_id = t.project_id
          AND pm.user_id = $1
          AND pm.role = 'project_admin'
          AND EXISTS (
            SELECT 1 FROM organization_members om
            WHERE om.organization_id = p.organization_id
              AND om.user_id = pm.user_id
          )
      ) AS is_project_admin,

      EXISTS (
        SELECT 1
        FROM project_members pm
        WHERE pm.project_id = t.project_id
          AND pm.user_id = $1
          AND EXISTS (
            SELECT 1 FROM organization_members om
            WHERE om.organization_id = p.organization_id
              AND om.user_id = pm.user_id
          )
      ) AS is_project_member

    FROM tasks t
    JOIN projects p
      ON p.id = t.project_id

    WHERE t.id = $2
    `,
    [userId, taskId]
  );

  return r.rows[0] || null;
}


/*
 * ============================================================
 * LIST COMMENTS
 * ============================================================
 *
 * GET /api/comments/task/:taskId
 *
 * Only users authorized for the task can see comments: organization owners,
 * project admins, and the assigned project member.
 */
async function listComments(req, res) {
  try {
    const taskId = Number(req.params.taskId);

    if (!Number.isInteger(taskId)) {
      return fail(res, 400, "Invalid task ID.");
    }

    const access = await taskAccess(req.user.id, taskId);

    if (!access) {
      return fail(res, 404, "Task not found.");
    }

    if (!access.is_org_member || (!access.is_org_owner && !access.is_project_admin && !(access.is_project_member && String(access.assignee_id) === String(req.user.id)))) {
      return fail(
        res,
        403,
        "Task access required."
      );
    }

    const r = await pool.query(
      `
      SELECT
        c.id,
        c.task_id,
        c.user_id,
        c.parent_id,
        c.content,
        c.created_at,
        c.updated_at,
        u.name AS user_name,
        u.email AS user_email

      FROM task_comments c

      JOIN users u
        ON u.id = c.user_id

      WHERE c.task_id = $1

      ORDER BY c.created_at ASC
      `,
      [taskId]
    );

    return ok(res, r.rows);

  } catch (e) {
    console.error("LIST COMMENTS ERROR:", e);

    return fail(
      res,
      500,
      "Unable to load comments."
    );
  }
}


/*
 * ============================================================
 * ADD COMMENT / REPLY
 * ============================================================
 *
 * POST /api/comments/task/:taskId
 *
 * Body:
 *
 * {
 *   "content": "Please check this issue"
 * }
 *
 * OR reply:
 *
 * {
 *   "content": "I will check it",
 *   "parentId": 25
 * }
 *
 * Permission follows task access: organization owner, project admin, or
 * assigned project member.
 */
async function addComment(req, res) {
  let client;
  try {
    const taskId = Number(req.params.taskId);

    if (!Number.isInteger(taskId)) {
      return fail(res, 400, "Invalid task ID.");
    }


    /*
     * --------------------------------------------------------
     * GET COMMENT DATA
     * --------------------------------------------------------
     */
    const { content, parentId = null } = req.body;


    /*
     * --------------------------------------------------------
     * CHECK CONTENT
     * --------------------------------------------------------
     */
    if (
      typeof content !== "string" ||
      !content.trim()
    ) {
      return fail(
        res,
        400,
        "Comment cannot be empty."
      );
    }


    /*
     * --------------------------------------------------------
     * CHECK TASK ACCESS
     * --------------------------------------------------------
     */
    const access = await taskAccess(
      req.user.id,
      taskId
    );

    if (!access) {
      return fail(
        res,
        404,
        "Task not found."
      );
    }


    /*
     * --------------------------------------------------------
     * ONLY PROJECT-ALLOWED USERS CAN COMMENT
     * --------------------------------------------------------
     */
    if (!access.is_org_member || (!access.is_org_owner && !access.is_project_admin && !(access.is_project_member && String(access.assignee_id) === String(req.user.id)))) {
      return fail(
        res,
        403,
        "Task access required."
      );
    }


    /*
     * --------------------------------------------------------
     * CHECK REPLY TARGET
     * --------------------------------------------------------
     *
     * If parentId exists, make sure the parent comment:
     *
     * 1. Exists
     * 2. Belongs to the same task
     *
     * This prevents:
     *
     * Task 10 comment
     *       ↓
     * replying from Task 20
     *
     * which should NOT be allowed.
     */
    let validParentId = null;

    if (parentId !== null) {
      validParentId = Number(parentId);

      if (!Number.isInteger(validParentId)) {
        return fail(
          res,
          400,
          "Invalid parent comment ID."
        );
      }

      const parent = await pool.query(
        `
        SELECT id
        FROM task_comments
        WHERE id = $1
          AND task_id = $2
        `,
        [validParentId, taskId]
      );

      if (!parent.rowCount) {
        return fail(
          res,
          400,
          "Invalid reply target."
        );
      }
    }


    /*
     * --------------------------------------------------------
     * INSERT COMMENT
     * --------------------------------------------------------
     *
     * PostgreSQL is the source of truth.
     *
     * Socket.IO should NOT be used to save the comment.
     */
    client = await pool.connect();
    await client.query("BEGIN");
    const inserted = await client.query(
      `
      INSERT INTO task_comments
        (
          task_id,
          user_id,
          parent_id,
          content
        )

      VALUES
        ($1, $2, $3, $4)

      RETURNING
        id,
        task_id,
        user_id,
        parent_id,
        content,
        created_at,
        updated_at
      `,
      [
        taskId,
        req.user.id,
        validParentId,
        content.trim()
      ]
    );
    await client.query(
      `INSERT INTO task_activity (task_id, user_id, action, new_value)
       VALUES ($1, $2, 'commented', 'Comment added')`,
      [taskId, req.user.id],
    );
    await client.query("COMMIT");


    /*
     * --------------------------------------------------------
     * GET COMPLETE COMMENT
     * --------------------------------------------------------
     *
     * We fetch the user name/email so the frontend
     * can immediately display the comment.
     */
    const commentResult = await pool.query(
      `
      SELECT
        c.id,
        c.task_id,
        c.user_id,
        c.parent_id,
        c.content,
        c.created_at,
        c.updated_at,
        u.name AS user_name,
        u.email AS user_email

      FROM task_comments c

      JOIN users u
        ON u.id = c.user_id

      WHERE c.id = $1
      `,
      [inserted.rows[0].id]
    );

    const row = commentResult.rows[0];

    knowledgeBaseService
      .indexComment(row.id)
      .catch((error) => console.error(`Knowledge reindex failed for comment ${row.id}:`, error.message));


    /*
     * ========================================================
     * SOCKET.IO - REALTIME COMMENT
     * ========================================================
     *
     * Anyone currently watching this authorized task room
     * can receive the new comment immediately.
     *
     * Example:
     *
     * task:10
     *    ├── Ali
     *    ├── Ahmed
     *    └── Rehan
     *
     * All receive:
     *
     * "comment_added"
     */
    const io = req.app.get("io");

    if (io) {
      await emitToAuthorizedTaskRoom(
        io,
        taskId,
        "comment_added",
        row,
        req.app.get("authorizeTaskSocketAccess"),
      );
    }


    /*
     * ========================================================
     * CREATE NOTIFICATIONS
     * ========================================================
     *
     * Notify:
     *
     * - Task creator
     * - Task assignee
     *
     * Do not notify the person who created the comment.
     */
    const recipients = await pool.query(
      `
      SELECT DISTINCT u.id

      FROM users u

      JOIN tasks t
        ON t.id = $1

      WHERE u.id IN
        (
          t.created_by,
          t.assignee_id
        )

        AND u.id <> $2
      `,
      [
        taskId,
        req.user.id
      ]
    );


    /*
     * --------------------------------------------------------
     * GET COMMENT AUTHOR NAME
     * --------------------------------------------------------
     *
     * req.user currently may only contain:
     *
     * {
     *   id,
     *   role
     * }
     *
     * Therefore we fetch the name from users table instead
     * of relying on req.user.name.
     */
    const userResult = await pool.query(
      `
      SELECT name
      FROM users
      WHERE id = $1
      `,
      [req.user.id]
    );

    const userName =
      userResult.rows[0]?.name ||
      "Someone";

    const notificationMessage =
      `${userName} commented on a task you follow`;


    /*
     * --------------------------------------------------------
     * SAVE + SEND NOTIFICATION
     * --------------------------------------------------------
     */
    for (const recipient of recipients.rows) {

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
          ($1, $2, $3, $4)
        `,
        [
          recipient.id,
          "New comment",
          notificationMessage,
          "comment"
        ]
      );


      /*
       * Personal Socket.IO room.
       *
       * Example:
       *
       * user:15
       *
       * Only user 15 receives this notification.
       */
      if (io) {
        io
          .to(`user:${recipient.id}`)
          .emit(
            "notification",
            {
              userId: recipient.id,
              title: "New comment",
              message: notificationMessage,
              type: "comment"
            }
          );
      }
    }


    /*
     * --------------------------------------------------------
     * HTTP RESPONSE
     * --------------------------------------------------------
     *
     * The user who created the comment also gets the
     * permanent database result through REST.
     */
    return created(
      res,
      row,
      "Comment added."
    );

  } catch (e) {
    if (client) {
      await client.query("ROLLBACK").catch(() => {});
    }
    console.error("ADD COMMENT ERROR:", e);

    return fail(
      res,
      500,
      "Unable to add comment."
    );
  } finally {
    client?.release();
  }
}


/*
 * ============================================================
 * DELETE COMMENT
 * ============================================================
 *
 * DELETE /api/comments/:id
 *
 * Permission:
 *
 * Organization owner or project admin -> YES
 * Task assignee or normal member      -> NO
 * Non-member                          -> NO
 */
async function deleteComment(req, res) {
  let client;
  try {
    const commentId = Number(req.params.id);

    if (!Number.isInteger(commentId)) {
      return fail(
        res,
        400,
        "Invalid comment ID."
      );
    }


    /*
     * --------------------------------------------------------
     * FIND COMMENT + PROJECT MANAGEMENT STATUS
     * --------------------------------------------------------
     */
    const r = await pool.query(
      `
      SELECT
        c.id,
        c.task_id,
        p.organization_id,

        EXISTS (
          SELECT 1
          FROM organization_members om
          WHERE om.organization_id = p.organization_id
            AND om.user_id = $2
            AND om.role = 'owner'
        ) AS is_org_owner,

        EXISTS (
          SELECT 1
          FROM organization_members om
          WHERE om.organization_id = p.organization_id
            AND om.user_id = $2
        ) AS is_org_member,

        EXISTS (
          SELECT 1
          FROM project_members pm
          WHERE pm.project_id = t.project_id
            AND pm.user_id = $2
            AND pm.role = 'project_admin'
            AND EXISTS (
              SELECT 1 FROM organization_members om
              WHERE om.organization_id = p.organization_id
                AND om.user_id = pm.user_id
            )
        ) AS is_project_admin

      FROM task_comments c

      JOIN tasks t
        ON t.id = c.task_id

      JOIN projects p
        ON p.id = t.project_id

      WHERE c.id = $1
      `,
      [
        commentId,
        req.user.id
      ]
    );


    /*
     * --------------------------------------------------------
     * COMMENT DOES NOT EXIST
     * --------------------------------------------------------
     */
    if (!r.rowCount) {
      return fail(
        res,
        404,
        "Comment not found."
      );
    }


    const comment = r.rows[0];


    /*
     * --------------------------------------------------------
     * ONLY ORG OWNER OR PROJECT ADMIN CAN DELETE
     * --------------------------------------------------------
     */
    if (!comment.is_org_member || (!comment.is_org_owner && !comment.is_project_admin)) {
      return fail(
        res,
        403,
        "Project administrator permission required."
      );
    }


    /*
     * --------------------------------------------------------
     * DELETE FROM DATABASE
     * --------------------------------------------------------
     *
     * If parent_id uses ON DELETE CASCADE,
     * child replies can also be deleted according
     * to your database constraint.
     */
    client = await pool.connect();
    await client.query("BEGIN");
    await client.query(
      `INSERT INTO task_activity (task_id, user_id, action, new_value)
       VALUES ($1, $2, 'comment_deleted', $3)`,
      [comment.task_id, req.user.id, `Comment ${commentId} deleted`],
    );
    await client.query(
      `
      DELETE FROM task_comments
      WHERE id = $1
      `,
      [commentId]
    );
    await client.query("COMMIT");

    knowledgeBaseService
      .deleteSource("comment", commentId)
      .catch((error) => console.error(`Knowledge cleanup failed for comment ${commentId}:`, error.message));


    /*
     * --------------------------------------------------------
     * REALTIME DELETE EVENT
     * --------------------------------------------------------
     *
     * Every authorized client watching this task
     * receives:
     *
     * comment_deleted
     */
    const io = req.app.get("io");

    if (io) {
      await emitToAuthorizedTaskRoom(
        io,
        comment.task_id,
        "comment_deleted",
        commentId,
        req.app.get("authorizeTaskSocketAccess"),
      );
    }


    return ok(
      res,
      null,
      "Comment deleted."
    );

  } catch (e) {
    if (client) {
      await client.query("ROLLBACK").catch(() => {});
    }
    console.error("DELETE COMMENT ERROR:", e);

    return fail(
      res,
      500,
      "Unable to delete comment."
    );
  } finally {
    client?.release();
  }
}


/*
 * ============================================================
 * EXPORT CONTROLLERS
 * ============================================================
 */
module.exports = {
  listComments,
  addComment,
  deleteComment
};