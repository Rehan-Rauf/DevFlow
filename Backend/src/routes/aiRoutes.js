const express = require("express");
const jwt = require("jsonwebtoken");
const crypto = require("crypto");
const router = express.Router();
const pool = require("../config/database");

const {
  taskChat,
  getTaskChatHistory,
  globalChat,
  getGlobalChatHistory,
  getChatSessionHistory,
  deleteChatSession,
  endTaskChat,
  endGlobalChat,
  endAllChats,
  getRecentChats,
  getGlobalActionProposals,
  approveGlobalActionProposal,
  cancelGlobalActionProposal,
} = require("../controllers/aiController");

const { requireAuth } = require("../middleware/authMiddleware");

const { runTaskAgent } = require("../services/agentService");

const { assertTaskAccess, deleteTask } = require("../services/retrievalService");
const { isPositiveIntegerId } = require("../utils/validation");

// =====================================================
// TASK AI
// =====================================================

// Task Chat
router.post("/task/:taskId/chat", requireAuth, taskChat);

// Task Chat History
router.get("/task/:taskId/chat/history", requireAuth, getTaskChatHistory);

// End Task Chat
router.post("/task/:taskId/chat/end", requireAuth, endTaskChat);

// =====================================================
// TASK AI AGENT
// =====================================================

router.post(
  "/task/:taskId/agent",
  requireAuth,
  async (req, res) => {
    try {
      const taskId = Number(req.params.taskId);

      const body = req.body && typeof req.body === "object" && !Array.isArray(req.body)
        ? req.body
        : {};
      const {
        message,
        confirmationToken = null,
        confirmationAction = null,
      } = body;

      if (!isPositiveIntegerId(req.params.taskId)) {
        return res.status(400).json({
          success: false,
          message: "Invalid task ID."
        });
      }

      if (typeof message !== "string" || !message.trim()) {
        return res.status(400).json({
          success: false,
          message: "Message is required."
        });
      }

      const scope = await assertTaskAccess(
        req.user.id,
        taskId
      );

      if (confirmationToken) {
        // A client boolean is not sufficient for deletion. The short-lived token
        // is only minted after this same authorized agent asks for confirmation.
        let confirmation;
        try {
          confirmation = jwt.verify(confirmationToken, process.env.JWT_SECRET);
        } catch {
          return res.status(403).json({
            success: false,
            message: "Task deletion confirmation is invalid or expired."
          });
        }
        const isValidConfirmation = confirmation.type === "task-agent-confirmation"
          && confirmation.action === "delete_task"
          && confirmation.confirmationAction === "delete_task"
          && typeof confirmation.jti === "string"
          && Number.isInteger(confirmation.exp)
          && confirmation.exp > Math.floor(Date.now() / 1000)
          && Number(confirmation.userId) === Number(req.user.id)
          && Number(confirmation.taskId) === Number(scope.taskId)
          && Number(confirmation.authVersion ?? 0) === Number(req.authPayload.authVersion ?? 0)
          && confirmationAction === "delete_task";
        if (!isValidConfirmation) {
          return res.status(403).json({
            success: false,
            message: "Task deletion confirmation is not valid for this task."
          });
        }

        const client = await pool.connect();
        let deletion;
        try {
          await client.query("BEGIN");
          await client.query(
            `DELETE FROM task_agent_confirmations
             WHERE expires_at < NOW() - INTERVAL '1 day'`,
          );
          const consumed = await client.query(
            `INSERT INTO task_agent_confirmations
               (jti, user_id, task_id, action, expires_at)
             VALUES ($1, $2, $3, 'delete_task', to_timestamp($4))
             ON CONFLICT (jti) DO NOTHING
             RETURNING jti`,
            [confirmation.jti, req.user.id, scope.taskId, confirmation.exp],
          );
          if (!consumed.rowCount) {
            await client.query("ROLLBACK");
            return res.status(409).json({
              success: false,
              message: "Task deletion confirmation has already been used.",
            });
          }

          const audit = await client.query(
            `INSERT INTO task_agent_tool_events
               (user_id, task_id, tool_name, outcome)
             VALUES ($1, $2, 'delete_task', 'started')
             RETURNING id`,
            [req.user.id, scope.taskId],
          );
          deletion = await deleteTask({
            taskId: scope.taskId,
            projectId: scope.projectId,
            userId: req.user.id,
            client,
          });
          await client.query(
            `UPDATE task_agent_tool_events
             SET outcome = 'succeeded', completed_at = NOW()
             WHERE id = $1`,
            [audit.rows[0].id],
          );
          await client.query("COMMIT");
        } catch (error) {
          await client.query("ROLLBACK").catch(() => {});
          throw error;
        } finally {
          client.release();
        }

        await req.app.get("emitTaskChanged")(
          scope.taskId,
          { deleted: true, audienceUserIds: deletion.audienceUserIds },
        );

        return res.json({
          success: true,
          data: {
            answer: "The task was deleted.",
            deleted: true,
          },
        });
      }

      const result = await runTaskAgent({
        taskId: scope.taskId,
        projectId: scope.projectId,
        organizationId: scope.organizationId,
        userId: req.user.id,
        message: message.trim(),
        confirmed: false,
        onChange: async (change) => {
        const changedTaskId = Number(change.task?.id);
        if (Number.isInteger(changedTaskId) && changedTaskId > 0) {
          await req.app.get("emitTaskChanged")(changedTaskId);
        }
        },
      });

      if (result.requiresConfirmation && result.confirmationAction === "delete_task") {
        result.confirmationToken = jwt.sign(
          {
            type: "task-agent-confirmation",
            action: "delete_task",
            confirmationAction: "delete_task",
            jti: crypto.randomUUID(),
            userId: req.user.id,
            taskId: scope.taskId,
            authVersion: req.authPayload.authVersion ?? 0,
          },
          process.env.JWT_SECRET,
          { expiresIn: "5m" },
        );
      }

      return res.json({
        success: true,
        data: result
      });

    } catch (error) {
      console.error(
        "TASK AGENT ERROR:",
        error
      );

      return res.status(
        error.status || 500
      ).json({
        success: false,
        message:
          error.message ||
          "AI Agent failed."
      });
    }
  }
);

// =====================================================
// GLOBAL AI
// =====================================================

// Global Chat
router.post("/global/chat", requireAuth, globalChat);
router.get("/global/proposals", requireAuth, getGlobalActionProposals);
router.post("/global/proposals/:proposalId/approve", requireAuth, approveGlobalActionProposal);
router.post("/global/proposals/:proposalId/cancel", requireAuth, cancelGlobalActionProposal);

// Global Chat History
router.get("/global/chat/history", requireAuth, getGlobalChatHistory);

// End Global Chat
router.post("/global/chat/end", requireAuth, endGlobalChat);
router.post("/chats/end-all", requireAuth, endAllChats);

// =====================================================
// SAVED CHAT HISTORY
// =====================================================

router.get("/chats/:sessionId/history", requireAuth, getChatSessionHistory);
router.delete("/chats/:sessionId", requireAuth, deleteChatSession);

// =====================================================
// RECENT CHATS
// =====================================================

router.get("/chats/recent", requireAuth, getRecentChats);

module.exports = router;
