const test = require("node:test");
const assert = require("node:assert/strict");
const {
  emitToAuthorizedTaskRoom,
  registerTaskRoomHandlers,
} = require("../src/services/taskRoomAuthorization");

function createSocket(userId = 7) {
  const handlers = new Map();
  const joined = [];
  const left = [];
  const emitted = [];
  const disconnected = [];

  const socket = {
    user: { id: userId },
    on(event, handler) {
      handlers.set(event, handler);
    },
    async join(room) {
      joined.push(room);
    },
    leave(room) {
      left.push(room);
    },
    emit(event, payload) {
      emitted.push({ event, payload });
    },
    disconnect(close) {
      disconnected.push(close);
    },
  };

  return { socket, handlers, joined, left, emitted, disconnected };
}

test("joins a task room only after task access is authorized", async () => {
  const fixture = createSocket();
  const authorized = [];
  registerTaskRoomHandlers(fixture.socket, async (userId, taskId) => {
    authorized.push({ userId, taskId });
  });

  await fixture.handlers.get("join_task")("42");

  assert.deepEqual(authorized, [{ userId: 7, taskId: 42 }]);
  assert.deepEqual(fixture.joined, ["task:42"]);
  assert.deepEqual(fixture.emitted, []);
});

test("does not join and reports forbidden or missing tasks uniformly", async (t) => {
  for (const status of [403, 404]) {
    await t.test(`status ${status}`, async () => {
      const fixture = createSocket();
      const errors = [];
      registerTaskRoomHandlers(
        fixture.socket,
        async () => {
          const error = new Error("private internal detail");
          error.status = status;
          throw error;
        },
        { error: (...args) => errors.push(args) },
      );

      await fixture.handlers.get("join_task")(42);

      assert.deepEqual(fixture.joined, []);
      assert.deepEqual(fixture.emitted, [{
        event: "task_room_error",
        payload: { message: "Task access required." },
      }]);
      assert.deepEqual(errors, []);
    });
  }
});

test("rejects malformed task IDs without querying authorization", async (t) => {
  for (const taskId of ["1:room", true, {}, "", "42.5", 0, -1, Number.MAX_SAFE_INTEGER + 1]) {
    await t.test(JSON.stringify(taskId), async () => {
      const fixture = createSocket();
      let authorizationCalls = 0;
      registerTaskRoomHandlers(fixture.socket, async () => {
        authorizationCalls += 1;
      });

      await fixture.handlers.get("join_task")(taskId);

      assert.equal(authorizationCalls, 0);
      assert.deepEqual(fixture.joined, []);
      assert.deepEqual(fixture.emitted[0], {
        event: "task_room_error",
        payload: { message: "Invalid task ID." },
      });
    });
  }
});

test("logs infrastructure errors and does not join the task room", async () => {
  const fixture = createSocket();
  const databaseError = new Error("database unavailable");
  const errors = [];
  registerTaskRoomHandlers(
    fixture.socket,
    async () => {
      throw databaseError;
    },
    { error: (...args) => errors.push(args) },
  );

  await fixture.handlers.get("join_task")(42);

  assert.deepEqual(fixture.joined, []);
  assert.deepEqual(errors, [[
    "Unable to authorize task room 42:",
    databaseError,
  ]]);
  assert.deepEqual(fixture.emitted[0], {
    event: "task_room_error",
    payload: { message: "Unable to join task room." },
  });
});

test("leaves valid task rooms and ignores invalid leave IDs", () => {
  const fixture = createSocket();
  registerTaskRoomHandlers(fixture.socket, async () => {});

  fixture.handlers.get("leave_task")(42);
  fixture.handlers.get("leave_task")("1:room");
  fixture.handlers.get("leave_task")(true);

  assert.deepEqual(fixture.left, ["task:42"]);
});

test("revalidates every task-room member before delivering private events", async () => {
  const authorized = createSocket(7);
  const revoked = createSocket(8);
  const room = new Set(["allowed", "revoked"]);
  const sockets = new Map([["allowed", authorized.socket], ["revoked", revoked.socket]]);
  const io = { sockets: { adapter: { rooms: new Map([["task:42", room]]) }, sockets } };

  const delivered = await emitToAuthorizedTaskRoom(
    io,
    42,
    "comment_added",
    { id: 3, content: "private" },
    async (userId) => {
      if (userId === 8) {
        const error = new Error("access revoked");
        error.status = 403;
        throw error;
      }
    },
  );

  assert.equal(delivered, 1);
  assert.deepEqual(authorized.emitted, [{
    event: "comment_added",
    payload: { id: 3, content: "private" },
  }]);
  assert.deepEqual(revoked.emitted, []);
  assert.deepEqual(revoked.left, ["task:42"]);
});

test("disconnects sockets whose authentication token was revoked", async () => {
  const fixture = createSocket();
  const io = {
    sockets: {
      adapter: { rooms: new Map([["task:42", new Set(["socket-1"])]]), },
      sockets: new Map([["socket-1", fixture.socket]]),
    },
  };
  await emitToAuthorizedTaskRoom(
    io,
    42,
    "comment_deleted",
    3,
    async () => {
      const error = new Error("revoked");
      error.status = 401;
      throw error;
    },
  );

  assert.deepEqual(fixture.emitted, []);
  assert.deepEqual(fixture.disconnected, [true]);
});
