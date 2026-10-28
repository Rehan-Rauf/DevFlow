// Import Express.
const express = require("express");

// Import task controller functions.
const controller = require("../controllers/taskController");

// Import authentication middleware.
const {
  requireAuth
} = require("../middleware/authMiddleware");
const { fail } = require("../utils/response");
const { isPositiveIntegerId } = require("../utils/validation");

// Create router.
const router = express.Router();

// ======================================================
// AUTHENTICATION
// ======================================================

// Every task route requires login.
router.use(requireAuth);

router.param("id", (req, res, next, id) => {
  if (!isPositiveIntegerId(id)) return fail(res, 400, "Invalid task ID.");
  return next();
});

// ======================================================
// AI TASK VALIDATION
// ======================================================

// POST /api/tasks/analyze
//
// This does NOT create a task.
//
// It only checks:
//
// 1. Is the prompt meaningful?
// 2. Is it related to the selected organization?
// 3. Is it related to the selected project?
//
// If valid:
//      AI prepares task information.
//
// If invalid:
//      AI returns valid: false.
//
// IMPORTANT:
// Keep this route BEFORE /:id.
router.post(
  "/analyze",
  controller.analyzeTask
);

// ======================================================
// LIST TASKS
// ======================================================

// GET /api/tasks
router.get(
  "/",
  controller.listTasks
);

// ======================================================
// CREATE TASK
// ======================================================

// POST /api/tasks
//
// This creates the task AFTER AI validation.
router.post(
  "/",
  controller.createTask
);

// ======================================================
// GET ONE TASK
// ======================================================

// GET /api/tasks/:id
router.get(
  "/:id",
  controller.getTask
);

// ======================================================
// UPDATE TASK
// ======================================================

// PUT /api/tasks/:id
router.put(
  "/:id",
  controller.updateTask
);

// ======================================================
// DELETE TASK
// ======================================================

// DELETE /api/tasks/:id
router.delete(
  "/:id",
  controller.deleteTask
);

// ======================================================
// EXPORT
// ======================================================

module.exports = router;