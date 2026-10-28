function registerTaskRoomHandlers(socket, authorizeTaskAccess, logger = console) {
  socket.on("join_task", async (taskId) => {
    const parsedTaskId = parseTaskId(taskId);

    if (parsedTaskId === null) {
      socket.emit("task_room_error", { message: "Invalid task ID." });
      return;
    }

    try {
      await authorizeTaskAccess(socket.user.id, parsedTaskId, socket);
      await socket.join(`task:${parsedTaskId}`);
    } catch (error) {
      if (error.status !== 403 && error.status !== 404) {
        logger.error(`Unable to authorize task room ${parsedTaskId}:`, error);
      }

      socket.emit("task_room_error", {
        message: error.status === 403 || error.status === 404
          ? "Task access required."
          : "Unable to join task room.",
      });
    }
  });

  socket.on("leave_task", (taskId) => {
    const parsedTaskId = parseTaskId(taskId);
    if (parsedTaskId !== null) socket.leave(`task:${parsedTaskId}`);
  });
}

async function emitToAuthorizedTaskRoom(
  io,
  taskId,
  eventName,
  payload,
  authorizeTaskAccess,
  logger = console,
) {
  const roomName = `task:${taskId}`;
  const memberIds = [...(io.sockets.adapter.rooms.get(roomName) || [])];
  let delivered = 0;

  for (const socketId of memberIds) {
    const socket = io.sockets.sockets.get(socketId);
    if (!socket) continue;

    try {
      await authorizeTaskAccess(socket.user?.id, taskId, socket);
      socket.emit(eventName, payload);
      delivered += 1;
    } catch (error) {
      await socket.leave(roomName);
      if (error.status === 401) {
        socket.disconnect(true);
      } else if (error.status !== 403 && error.status !== 404) {
        logger.error(`Unable to reauthorize task room ${taskId}:`, error);
      }
    }
  }

  return delivered;
}

function parseTaskId(value) {
  if (typeof value !== "number" && typeof value !== "string") return null;
  if (typeof value === "string" && !/^\d+$/.test(value)) return null;

  const taskId = Number(value);
  return Number.isSafeInteger(taskId) && taskId > 0 ? taskId : null;
}

module.exports = { emitToAuthorizedTaskRoom, registerTaskRoomHandlers };
