const express = require("express");
const { requireAuth } = require("../middleware/authMiddleware");
const controller = require("../controllers/memoryController");
const { fail } = require("../utils/response");
const { isPositiveIntegerId } = require("../utils/validation");

const router = express.Router();
router.use(requireAuth);
router.param("memoryId", (req, res, next, id) => {
  if (!isPositiveIntegerId(id)) return fail(res, 400, "Invalid memory ID.");
  return next();
});
router.get("/", controller.list);
router.get("/search", controller.search);
router.post("/", controller.create);
router.delete("/", controller.clear);
router.get("/:memoryId", controller.get);
router.patch("/:memoryId", controller.update);
router.delete("/:memoryId", controller.remove);
module.exports = router;
