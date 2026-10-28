// Import Express.
// Express is used to create the router
// and handle HTTP requests.
const express = require("express");


// Import all project-related controller functions.
//
// controller contains functions for:
// - listing projects
// - creating projects
// - getting one project
// - updating projects
// - deleting projects
// - managing project members
const controller = require("../controllers/projectController");
const workflowRoutes = require("./workflowRoutes");


// Import requireAuth middleware.
//
// This middleware checks whether the user
// has a valid JWT authentication token.
const {
  requireAuth
} = require("../middleware/authMiddleware");
const { fail } = require("../utils/response");
const { isPositiveIntegerId } = require("../utils/validation");


// Create an Express Router.
//
// This router will contain all project-related routes.
const router = express.Router();


// ======================================================
// AUTHENTICATION MIDDLEWARE
// ======================================================

// requireAuth will run before every route below.
//
// This means the user must be logged in
// to access any project route.
//
// Valid token:
//     requireAuth → next() → controller
//
// Invalid/missing token:
//     requireAuth → 401 response → STOP
router.use(requireAuth);

router.param("id", (req, res, next, id) => {
  if (!isPositiveIntegerId(id)) return fail(res, 400, "Invalid project ID.");
  return next();
});

router.param("userId", (req, res, next, userId) => {
  if (!isPositiveIntegerId(userId)) return fail(res, 400, "Invalid user ID.");
  return next();
});


// ======================================================
// PROJECT ROUTES
// ======================================================


// GET /
// Get a list of projects.
//
// Example:
// GET /projects
//
// The controller handles the actual database work.
router.get("/", controller.listProjects);


// POST /
// Create a new project.
//
// Example:
// POST /projects
//
// Project information will normally come
// from req.body.
router.post("/", controller.createProject);

// Project-owned statuses and discipline tags must be mounted before /:id so
// their nested routes do not get interpreted as a project id.
router.use("/:id", workflowRoutes);


// GET /:id
// Get one project using its ID.
//
// Example:
// GET /projects/5
//
// req.params.id = 5
router.get("/:id", controller.getProject);


// PUT /:id
// Update an existing project.
//
// Example:
// PUT /projects/5
//
// req.params.id = 5
router.put("/:id", controller.updateProject);


// DELETE /:id
// Delete a project using its ID.
//
// Example:
// DELETE /projects/5
router.delete("/:id", controller.deleteProject);


// ======================================================
// PROJECT MEMBER ROUTES
// ======================================================


// GET /:id/members
// Get all members of a specific project.
//
// Example:
// GET /projects/5/members
//
// 5 = project ID
router.get("/:id/members", controller.listMembers);


// POST /:id/members
// Add a user to a project.
//
// Example:
// POST /projects/5/members
//
// 5 = project ID
router.post("/:id/members", controller.addMember);


// DELETE /:id/members/:userId
// Remove a user from a project.
//
// Example:
// DELETE /projects/5/members/10
//
// 5  = project ID
// 10 = user ID
router.delete(
  "/:id/members/:userId",
  controller.removeMember
);


// Export the router.
//
// server.js can import this router
// and connect it with app.use().
module.exports = router;
