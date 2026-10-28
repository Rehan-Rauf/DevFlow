function assertSingleSocketIoInstance(
  instanceCount = process.env.SOCKET_IO_INSTANCE_COUNT,
) {
  if (instanceCount === undefined || instanceCount === "") return;

  if (!/^[1-9]\d*$/.test(String(instanceCount))) {
    throw new Error("SOCKET_IO_INSTANCE_COUNT must be a positive integer.");
  }

  if (Number(instanceCount) !== 1) {
    throw new Error(
      "This deployment uses the in-memory Socket.IO adapter and requires SOCKET_IO_INSTANCE_COUNT=1.",
    );
  }
}

module.exports = { assertSingleSocketIoInstance };
