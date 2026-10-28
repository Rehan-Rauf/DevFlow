const memoryService = require("../services/memoryService");

function handle(handler) {
  return async (req, res) => {
    try {
      return await handler(req, res);
    } catch (error) {
      console.error("MEMORY API ERROR:", error);
      return res.status(error.status || 500).json({ success: false, message: error.message || "Memory operation failed." });
    }
  };
}
const list = handle(async (req, res) => {
  const data = await memoryService.listMemories({ ...req.query, userId: req.user.id });
  return res.json({ success: true, data });
});
const create = handle(async (req, res) => {
  const data = await memoryService.createMemory({ ...req.body, userId: req.user.id });
  return res.status(201).json({ success: true, data });
});
const get = handle(async (req, res) => {
  const data = await memoryService.getMemory({ userId: req.user.id, memoryId: Number(req.params.memoryId) });
  return res.json({ success: true, data });
});
const update = handle(async (req, res) => {
  const data = await memoryService.updateMemory({ ...req.body, userId: req.user.id, memoryId: Number(req.params.memoryId) });
  return res.json({ success: true, data });
});
const remove = handle(async (req, res) => {
  const data = await memoryService.deleteMemory({ userId: req.user.id, memoryId: Number(req.params.memoryId) });
  return res.json({ success: true, data });
});
const clear = handle(async (req, res) => {
  const data = await memoryService.clearMemories({ userId: req.user.id });
  return res.json({ success: true, data });
});
const search = handle(async (req, res) => {
  const data = await memoryService.getRelevantMemories({ ...req.query, userId: req.user.id });
  return res.json({ success: true, data });
});

module.exports = { list, create, get, update, remove, clear, search };
