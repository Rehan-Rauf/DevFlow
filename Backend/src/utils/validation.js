function isPositiveIntegerId(value) {
  if (typeof value === "number") {
    return Number.isSafeInteger(value) && value > 0;
  }
  if (typeof value !== "string" || !/^[1-9]\d*$/.test(value)) {
    return false;
  }
  return Number.isSafeInteger(Number(value));
}

module.exports = { isPositiveIntegerId };
