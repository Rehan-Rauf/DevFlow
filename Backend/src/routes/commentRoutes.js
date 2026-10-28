const express=require("express");
const controller=require("../controllers/commentController");
const {requireAuth}=require("../middleware/authMiddleware");
const { fail } = require("../utils/response");
const { isPositiveIntegerId } = require("../utils/validation");
const router=express.Router();
router.use(requireAuth);
router.param("taskId", (req, res, next, id) => {
  if (!isPositiveIntegerId(id)) return fail(res, 400, "Invalid task ID.");
  return next();
});
router.param("id", (req, res, next, id) => {
  if (!isPositiveIntegerId(id)) return fail(res, 400, "Invalid comment ID.");
  return next();
});
router.get("/task/:taskId",controller.listComments);
router.post("/task/:taskId",controller.addComment);
router.delete("/:id",controller.deleteComment);
module.exports=router;
