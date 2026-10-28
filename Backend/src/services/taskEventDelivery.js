const pool = require("../config/database");
const { assertTaskAccess } = require("./retrievalService");

async function getTaskAudienceUserIds(taskId, logger = console) {
  try {
    const result = await pool.query(
      `SELECT DISTINCT audience.user_id
       FROM (
         SELECT om.user_id
         FROM tasks t
         JOIN organization_members om
           ON om.organization_id = (
             SELECT p.organization_id FROM projects p WHERE p.id = t.project_id
           )
         WHERE t.id = $1 AND om.role = 'owner'

         UNION

         SELECT pm.user_id
         FROM tasks t
         JOIN project_members pm ON pm.project_id = t.project_id
         WHERE t.id = $1 AND pm.role = 'project_admin'

         UNION

         SELECT t.assignee_id AS user_id
         FROM tasks t
         JOIN project_members pm
           ON pm.project_id = t.project_id
          AND pm.user_id = t.assignee_id
         WHERE t.id = $1 AND t.assignee_id IS NOT NULL
       ) audience`,
      [taskId],
    );

    const authorizedUserIds = [];
    for (const { user_id: userId } of result.rows) {
      try {
        await assertTaskAccess(userId, taskId);
        authorizedUserIds.push(Number(userId));
      } catch (error) {
        if (error.status !== 403 && error.status !== 404) {
          logger.error(`Unable to authorize task event audience for task ${taskId}:`, error);
        }
      }
    }

    return authorizedUserIds;
  } catch (error) {
    logger.error(`Unable to resolve task event audience for task ${taskId}:`, error);
    return [];
  }
}

async function emitTaskChanged(
  io,
  taskId,
  {
    deleted = false,
    audienceUserIds = null,
    authorizeTaskAccess,
    authorizeSocketSession,
  } = {},
  logger = console,
) {
  const recipients = audienceUserIds || await getTaskAudienceUserIds(taskId, logger);
  if (typeof authorizeTaskAccess !== "function" || typeof authorizeSocketSession !== "function") {
    logger.error(`Unable to deliver task event for task ${taskId}: authorization is not configured.`);
    return 0;
  }
  const payload = deleted
    ? { id: Number(taskId), deleted: true }
    : { id: Number(taskId) };
  let delivered = 0;

  for (const userId of recipients) {
    const room = `user:${userId}`;
    const socketIds = [...(io.sockets.adapter.rooms.get(room) || [])];

    for (const socketId of socketIds) {
      const socket = io.sockets.sockets.get(socketId);
      if (!socket?.connected || Number(socket.user?.id) !== Number(userId)) continue;

      try {
        await authorizeSocketSession(socket);
        if (!deleted) await authorizeTaskAccess(userId, taskId, socket);
        socket.emit("task_changed", payload);
        delivered += 1;
      } catch (error) {
        if (error.status === 401) {
          socket.disconnect(true);
        } else if (error.status === 403 || error.status === 404) {
          await socket.leave(`task:${taskId}`);
        } else {
          logger.error(`Unable to deliver task event for task ${taskId}:`, error);
        }
      }
    }
  }

  return delivered;
}

module.exports = { emitTaskChanged, getTaskAudienceUserIds };
