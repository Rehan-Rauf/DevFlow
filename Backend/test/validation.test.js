const test = require("node:test");
const assert = require("node:assert/strict");
const { isPositiveIntegerId } = require("../src/utils/validation");

test("accepts only positive safe integer IDs", () => {
  for (const value of [1, "1", Number.MAX_SAFE_INTEGER, String(Number.MAX_SAFE_INTEGER)]) {
    assert.equal(isPositiveIntegerId(value), true, `${value} should be a valid ID`);
  }

  for (const value of [
    0,
    -1,
    1.5,
    Number.MAX_SAFE_INTEGER + 1,
    "0",
    "-1",
    "01",
    "1.0",
    "1e2",
    "9007199254740992",
    "",
    null,
    {},
  ]) {
    assert.equal(isPositiveIntegerId(value), false, `${String(value)} should be invalid`);
  }
});
