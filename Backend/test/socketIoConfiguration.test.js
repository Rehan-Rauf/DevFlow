const test = require("node:test");
const assert = require("node:assert/strict");
const { assertSingleSocketIoInstance } = require("../src/services/socketIoConfiguration");

test("allows the default single-instance deployment", () => {
  assert.doesNotThrow(() => assertSingleSocketIoInstance(undefined));
  assert.doesNotThrow(() => assertSingleSocketIoInstance("1"));
});

test("rejects invalid or multi-instance Socket.IO deployment settings", () => {
  for (const value of ["0", "-1", "1.5", "two", "2"]) {
    assert.throws(
      () => assertSingleSocketIoInstance(value),
      /SOCKET_IO_INSTANCE_COUNT/,
      `Expected ${value} to be rejected.`,
    );
  }
});
