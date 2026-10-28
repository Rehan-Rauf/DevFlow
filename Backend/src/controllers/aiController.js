const pool = require("../config/database");
const aiService = require("../services/aiService");
const globalActionService = require("../services/globalActionService");
const crypto = require("node:crypto");
const { assertTaskAccess } = require("../services/retrievalService");
const { ok, fail } = require("../utils/response");
const { extractMemoriesFromConversation, isExplicitMemoryCommand } = require("../services/memoryService");

// ============================================================
// GET OR CREATE ACTIVE TASK AI SESSION
// ============================================================

async function getOrCreateTaskSession(userId, taskId) {
  // First find an existing active session for this task.
  const existing = await pool.query(
    `
    SELECT id, title, status, created_at
    FROM ai_chat_sessions
    WHERE user_id = $1
      AND chat_type = 'TASK'
      AND task_id = $2
      AND status = 'ACTIVE'
    ORDER BY created_at DESC
    LIMIT 1
    `,
    [userId, taskId]
  );

  if (existing.rows.length > 0) {
    return existing.rows[0];
  }

  // No active session -> create a new one.
  const created = await pool.query(
    `
    INSERT INTO ai_chat_sessions
      (user_id, chat_type, task_id, status, title)
    VALUES
      ($1, 'TASK', $2, 'ACTIVE', NULL)
    RETURNING id, title, status, created_at
    `,
    [userId, taskId]
  );

  return created.rows[0];
}

// ============================================================
// GET OR CREATE ACTIVE GLOBAL AI SESSION
// ============================================================

async function getOrCreateGlobalSession(userId) {
  // Find existing active Global AI session.
  const existing = await pool.query(
    `
    SELECT id, title, status, created_at
    FROM ai_chat_sessions
    WHERE user_id = $1
      AND chat_type = 'GLOBAL'
      AND status = 'ACTIVE'
    ORDER BY created_at DESC
    LIMIT 1
    `,
    [userId]
  );

  if (existing.rows.length > 0) {
    return existing.rows[0];
  }

  // No active session -> create a new one.
  const created = await pool.query(
    `
    INSERT INTO ai_chat_sessions
      (user_id, chat_type, status, title)
    VALUES
      ($1, 'GLOBAL', 'ACTIVE', NULL)
    RETURNING id, title, status, created_at
    `,
    [userId]
  );

  return created.rows[0];
}

// ============================================================
// POST /api/ai/task/:taskId/chat
// ============================================================

async function taskChat(req, res) {
  try {
    const taskId = Number(req.params.taskId);
    const { message, context = null } = req.body;

    if (!Number.isInteger(taskId)) {
      return fail(res, 400, "Invalid task ID.");
    }

    if (!message || !String(message).trim()) {
      return fail(res, 400, "Message is required.");
    }

    // Authorization BEFORE any retrieval.
    const scope = await assertTaskAccess(req.user.id, taskId);

    // Get/create the active session for this task.
    const session = await getOrCreateTaskSession(
      req.user.id,
      taskId
    );

    // Load history ONLY from the current session.
    const historyResult = await pool.query(
      `
      SELECT role, content
      FROM ai_task_messages
      WHERE session_id = $1
        AND user_id = $2
      ORDER BY created_at DESC
      LIMIT 8
      `,
      [session.id, req.user.id]
    );

    const history = historyResult.rows.reverse();

    let result;
    if (isExplicitMemoryCommand(message)) {
      const memories = await extractMemoriesFromConversation({
        userId: req.user.id,
        message: message.trim(),
        taskId: scope.taskId,
        projectId: scope.projectId,
        organizationId: scope.organizationId,
      });
      result = {
        answer: `Saved ${memories.length} memory item${memories.length === 1 ? "" : "s"} for this task.`,
        sources: memories.map((memory) => ({
          type: "memory",
          id: memory.id,
          label: memory.content,
        })),
        intent: "MEMORY_SAVED",
        memoriesUsed: 0,
      };
    } else {
      result = await aiService.taskChat({
        userId: req.user.id,
        taskId: scope.taskId,
        projectId: scope.projectId,
        organizationId: scope.organizationId,
        message: message.trim(),
        history,
      });
    }
    const { answer, sources, intent, memoriesUsed } = result;

    // Save user's message with session_id.
    await pool.query(
      `
      INSERT INTO ai_task_messages
        (task_id, user_id, session_id, role, content)
      VALUES
        ($1, $2, $3, 'user', $4)
      `,
      [
        taskId,
        req.user.id,
        session.id,
        message.trim(),
      ]
    );

    if (!isExplicitMemoryCommand(message)) {
      void extractMemoriesFromConversation({
        userId: req.user.id,
        message: message.trim(),
        taskId: scope.taskId,
        projectId: scope.projectId,
        organizationId: scope.organizationId,
      }).catch((error) => console.error("Background task memory extraction failed:", error.message));
    }

    // Save AI response with session_id.
    await pool.query(
      `
      INSERT INTO ai_task_messages
        (task_id, user_id, session_id, role, content, sources)
      VALUES
        ($1, $2, $3, 'assistant', $4, $5::jsonb)
      `,
      [
        taskId,
        req.user.id,
        session.id,
        answer,
        JSON.stringify(sources),
      ]
    );

    // Use first user message as session title.
    if (!session.title) {
      await pool.query(
        `
        UPDATE ai_chat_sessions
        SET title = $1
        WHERE id = $2
          AND title IS NULL
        `,
        [message.trim().slice(0, 100), session.id]
      );
    }

    return ok(res, {
      answer,
      sources,
      intent,
      memoriesUsed,
      sessionId: session.id,
    });
  } catch (error) {
    console.error("TASK AI CHAT ERROR:", error);

    const status = error.status || 500;

    return fail(
      res,
      status,
      status === 500
        ? "The AI assistant is unavailable right now."
        : error.message
    );
  }
}

// ============================================================
// GET /api/ai/task/:taskId/chat/history
// ============================================================

async function getTaskChatHistory(req, res) {
  try {
    const taskId = Number(req.params.taskId);

    if (!Number.isInteger(taskId)) {
      return fail(res, 400, "Invalid task ID.");
    }

    await assertTaskAccess(req.user.id, taskId);

    // IMPORTANT:
    // Reading history must NOT create a new empty session.
    const sessionResult = await pool.query(
      `
      SELECT id, title, status, created_at, ended_at
      FROM ai_chat_sessions
      WHERE user_id = $1
        AND chat_type = 'TASK'
        AND task_id = $2
        AND status = 'ACTIVE'
      ORDER BY created_at DESC
      LIMIT 1
      `,
      [req.user.id, taskId]
    );

    if (sessionResult.rows.length === 0) {
      return ok(res, {
        sessionId: null,
        sessionStatus: null,
        messages: [],
      });
    }

    const session = sessionResult.rows[0];

    const result = await pool.query(
      `
      SELECT id, role, content, sources, created_at
      FROM ai_task_messages
      WHERE session_id = $1
        AND task_id = $2
        AND user_id = $3
      ORDER BY created_at ASC
      LIMIT 100
      `,
      [session.id, taskId, req.user.id]
    );

    return ok(res, {
      sessionId: session.id,
      sessionStatus: session.status,
      sessionTitle: session.title,
      messages: result.rows,
    });
  } catch (error) {
    console.error("TASK AI HISTORY ERROR:", error);

    const status = error.status || 500;

    return fail(
      res,
      status,
      status === 500
        ? "Unable to load chat history."
        : error.message
    );
  }
}

// ============================================================
// POST /api/ai/global/chat
// ============================================================

async function globalChat(req, res) {
  try {
    const { message, context = null, requestId = null } = req.body;

    if (!message || !String(message).trim()) {
      return fail(res, 400, "Message is required.");
    }

    // Get/create active Global AI session.
    const session = await getOrCreateGlobalSession(
      req.user.id
    );

    // Load history ONLY from current session.
    const historyResult = await pool.query(
      `
      SELECT role, content
      FROM ai_global_messages
      WHERE session_id = $1
        AND user_id = $2
      ORDER BY created_at DESC
      LIMIT 8
      `,
      [session.id, req.user.id]
    );

    const history = historyResult.rows.reverse();

    const requestKey = requestId || crypto.randomUUID();
    if (typeof requestKey !== "string"
      || !/^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i.test(requestKey)) {
      return fail(res, 400, "Invalid AI request ID.");
    }

    let result;
    if (isExplicitMemoryCommand(message)) {
      const memoryScope = await aiService.getPageMemoryScope(req.user.id, context);
      const memories = await extractMemoriesFromConversation({
        userId: req.user.id,
        message: message.trim(),
        ...memoryScope,
      });
      result = {
        answer: `Saved ${memories.length} memory item${memories.length === 1 ? "" : "s"}.`,
        sources: memories.map((memory) => ({
          type: "memory",
          id: memory.id,
          label: memory.content,
        })),
        memoriesUsed: 0,
        actionResults: [],
      };
    } else {
      result = await aiService.globalChat({
        userId: req.user.id,
        message: message.trim(),
        history,
        context,
        sessionId: session.id,
        requestId: requestKey,
      });
    }
    const { answer, sources, memoriesUsed, actionResults = [] } = result;
    // Save user's message.
    await pool.query(
      `
      INSERT INTO ai_global_messages
        (user_id, session_id, role, content)
      VALUES
        ($1, $2, 'user', $3)
      `,
      [
        req.user.id,
        session.id,
        message.trim(),
      ]
    );

    if (!isExplicitMemoryCommand(message)) {
      void extractMemoriesFromConversation({
        userId: req.user.id,
        message: message.trim(),
      }).catch((error) => console.error("Background global memory extraction failed:", error.message));
    }

    // Save AI response.
    await pool.query(
      `
      INSERT INTO ai_global_messages
        (user_id, session_id, role, content, sources)
      VALUES
        ($1, $2, 'assistant', $3, $4::jsonb)
      `,
      [
        req.user.id,
        session.id,
        answer,
        JSON.stringify(sources),
      ]
    );

    // Use first user message as title.
    if (!session.title) {
      await pool.query(
        `
        UPDATE ai_chat_sessions
        SET title = $1
        WHERE id = $2
          AND title IS NULL
        `,
        [message.trim().slice(0, 100), session.id]
      );
    }

    return ok(res, {
      answer,
      sources,
      memoriesUsed,
      sessionId: session.id,
      requestId: requestKey,
      actionResults,
      actionProposals: result.actionProposals || [],
    });
  } catch (error) {
    console.error("GLOBAL AI CHAT ERROR:", error);

    const status = error.status || 500;

    return fail(
      res,
      status,
      status === 500
        ? "The AI assistant is unavailable right now."
        : error.message
    );
  }
}

async function getGlobalActionProposals(req, res) {
  try {
    const sessionId = req.query.sessionId === undefined ? null : Number(req.query.sessionId);
    if (sessionId !== null && (!Number.isSafeInteger(sessionId) || sessionId < 1)) {
      return fail(res, 400, "Invalid chat session ID.");
    }
    const proposals = await globalActionService.listProposals(req.user.id, sessionId);
    return ok(res, { proposals });
  } catch (error) {
    console.error("GET GLOBAL AI ACTION PROPOSALS ERROR:", error);
    return fail(res, 500, "Unable to load pending AI actions.");
  }
}

async function approveGlobalActionProposal(req, res) {
  try {
    const { proposalId } = req.params;
    if (!/^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i.test(proposalId)) {
      return fail(res, 400, "Invalid action proposal ID.");
    }
    const outcome = await globalActionService.approveProposal(req.user.id, proposalId);
    if (outcome.proposal.status === "succeeded"
      && outcome.result?.resourceType === "task"
      && outcome.result.resource?.id) {
      await req.app.get("emitTaskChanged")(outcome.result.resource.id);
    }
    return ok(res, outcome);
  } catch (error) {
    if (error.status) return fail(res, error.status, error.message);
    console.error("APPROVE GLOBAL AI ACTION ERROR:", error);
    return fail(res, 500, "Unable to approve this AI action.");
  }
}

async function cancelGlobalActionProposal(req, res) {
  try {
    const { proposalId } = req.params;
    if (!/^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i.test(proposalId)) {
      return fail(res, 400, "Invalid action proposal ID.");
    }
    return ok(res, {
      proposal: await globalActionService.cancelProposal(req.user.id, proposalId),
    });
  } catch (error) {
    if (error.status) return fail(res, error.status, error.message);
    console.error("CANCEL GLOBAL AI ACTION ERROR:", error);
    return fail(res, 500, "Unable to cancel this AI action.");
  }
}

// ============================================================
// GET /api/ai/global/chat/history
// ============================================================

async function getGlobalChatHistory(req, res) {
  try {
    // Reading history must NOT create an empty session.
    const sessionResult = await pool.query(
      `
      SELECT id, title, status, created_at, ended_at
      FROM ai_chat_sessions
      WHERE user_id = $1
        AND chat_type = 'GLOBAL'
        AND status = 'ACTIVE'
      ORDER BY created_at DESC
      LIMIT 1
      `,
      [req.user.id]
    );

    if (sessionResult.rows.length === 0) {
      return ok(res, {
        sessionId: null,
        sessionStatus: null,
        messages: [],
      });
    }

    const session = sessionResult.rows[0];

    const result = await pool.query(
      `
      SELECT id, role, content, sources, created_at
      FROM ai_global_messages
      WHERE session_id = $1
        AND user_id = $2
      ORDER BY created_at ASC
      LIMIT 100
      `,
      [session.id, req.user.id]
    );

    return ok(res, {
      sessionId: session.id,
      sessionStatus: session.status,
      sessionTitle: session.title,
      messages: result.rows,
    });
  } catch (error) {
    console.error("GLOBAL AI HISTORY ERROR:", error);

    return fail(
      res,
      500,
      "Unable to load chat history."
    );
  }
}

// ============================================================
// END TASK AI CHAT SESSION
// ============================================================

async function endTaskChat(req, res) {
  try {
    const taskId = Number(req.params.taskId);

    if (!Number.isInteger(taskId)) {
      return fail(res, 400, "Invalid task ID.");
    }

    // Make sure user has access to this task.
    await assertTaskAccess(req.user.id, taskId);

    const result = await pool.query(
      `
      UPDATE ai_chat_sessions
      SET
        status = 'ENDED',
        ended_at = NOW()
      WHERE user_id = $1
        AND chat_type = 'TASK'
        AND task_id = $2
        AND status = 'ACTIVE'
      RETURNING id, status, ended_at
      `,
      [req.user.id, taskId]
    );

    if (result.rows.length === 0) {
      return ok(res, {
        message: "No active Task AI session found.",
        ended: false,
      });
    }

    return ok(res, {
      message: "Task AI chat session ended.",
      ended: true,
      sessionId: result.rows[0].id,
      status: result.rows[0].status,
      endedAt: result.rows[0].ended_at,
    });
  } catch (error) {
    console.error("END TASK AI SESSION ERROR:", error);

    const status = error.status || 500;

    return fail(
      res,
      status,
      status === 500
        ? "Unable to end Task AI session."
        : error.message
    );
  }
}


// ============================================================
// END GLOBAL AI CHAT SESSION
// ============================================================

async function endGlobalChat(req, res) {
  try {
    const result = await pool.query(
      `
      UPDATE ai_chat_sessions
      SET
        status = 'ENDED',
        ended_at = NOW()
      WHERE user_id = $1
        AND chat_type = 'GLOBAL'
        AND status = 'ACTIVE'
      RETURNING id, status, ended_at
      `,
      [req.user.id]
    );

    if (result.rows.length === 0) {
      return ok(res, {
        message: "No active Global AI session found.",
        ended: false,
      });
    }

    return ok(res, {
      message: "Global AI chat session ended.",
      ended: true,
      sessionId: result.rows[0].id,
      status: result.rows[0].status,
      endedAt: result.rows[0].ended_at,
    });
  } catch (error) {
    console.error("END GLOBAL AI SESSION ERROR:", error);

    return fail(
      res,
      500,
      "Unable to end Global AI session."
    );
  }
}

async function endAllChats(req, res) {
  const client = await pool.connect();
  try {
    await client.query("BEGIN");
    const result = await client.query(
      `UPDATE ai_chat_sessions
       SET status = 'ENDED', ended_at = NOW()
       WHERE user_id = $1 AND status = 'ACTIVE'
       RETURNING id, chat_type`,
      [req.user.id],
    );
    await client.query("COMMIT");
    return ok(res, {
      ended: result.rowCount,
      sessions: result.rows,
      historyPreserved: true,
      memoriesPreserved: true,
    });
  } catch (error) {
    await client.query("ROLLBACK").catch(() => {});
    console.error("END ALL AI CHATS ERROR:", error);
    return fail(res, 500, "Unable to close all AI chats.");
  } finally {
    client.release();
  }
}

// ======================================================
// GET RECENT AI CHAT SESSIONS
// ======================================================

async function getRecentChats(req, res) {
  try {
    const result = await pool.query(
      `
      SELECT
        s.id,
        s.chat_type,
        s.task_id,
        s.status,
        s.title,
        s.created_at,
        s.ended_at,

        CASE
          WHEN s.chat_type = 'TASK'
          THEN t.title
          ELSE NULL
        END AS task_title,

        CASE
          WHEN s.chat_type = 'TASK' THEN (
            SELECT MAX(m.created_at)
            FROM ai_task_messages m
            WHERE m.session_id = s.id
              AND m.user_id = s.user_id
          )
          ELSE (
            SELECT MAX(m.created_at)
            FROM ai_global_messages m
            WHERE m.session_id = s.id
              AND m.user_id = s.user_id
          )
        END AS last_message_at

      FROM ai_chat_sessions s

      LEFT JOIN tasks t
        ON t.id = s.task_id

      WHERE s.user_id = $1
        AND (
          CASE
            WHEN s.chat_type = 'TASK' THEN EXISTS (
              SELECT 1
              FROM ai_task_messages m
              WHERE m.session_id = s.id
                AND m.user_id = s.user_id
            )
            ELSE EXISTS (
              SELECT 1
              FROM ai_global_messages m
              WHERE m.session_id = s.id
                AND m.user_id = s.user_id
            )
          END
        )

      ORDER BY last_message_at DESC NULLS LAST, s.created_at DESC
      LIMIT 20
      `,
      [req.user.id]
    );

    return ok(res, {
      chats: result.rows,
    });
  } catch (error) {
    console.error("GET RECENT AI CHATS ERROR:", error);

    return fail(
      res,
      500,
      "Unable to load recent AI chats."
    );
  }
}

// ============================================================
// GET ONE SAVED AI CHAT SESSION
// ============================================================

async function deleteChatSession(req, res) {
  try {
    const sessionId = Number(req.params.sessionId);
    if (!Number.isSafeInteger(sessionId) || sessionId < 1) {
      return fail(res, 400, "Invalid chat session ID.");
    }
    const result = await pool.query(
      `DELETE FROM ai_chat_sessions
       WHERE id = $1 AND user_id = $2
       RETURNING id, chat_type`,
      [sessionId, req.user.id],
    );
    if (!result.rowCount) return fail(res, 404, "Chat session not found.");
    return ok(res, {
      id: result.rows[0].id,
      chatType: result.rows[0].chat_type,
      conversationDeleted: true,
      memoriesDeleted: false,
    });
  } catch (error) {
    console.error("DELETE AI CHAT SESSION ERROR:", error);
    return fail(res, 500, "Unable to delete the conversation.");
  }
}

async function getChatSessionHistory(req, res) {
  try {
    const sessionId = Number(req.params.sessionId);

    if (!Number.isSafeInteger(sessionId) || sessionId < 1) {
      return fail(res, 400, "Invalid chat session ID.");
    }

    const sessionResult = await pool.query(
      `
      SELECT
        id,
        user_id,
        chat_type,
        task_id,
        status,
        title,
        created_at,
        ended_at
      FROM ai_chat_sessions
      WHERE id = $1
        AND user_id = $2
      LIMIT 1
      `,
      [sessionId, req.user.id]
    );

    if (sessionResult.rows.length === 0) {
      return fail(res, 404, "Chat session not found.");
    }

    const session = sessionResult.rows[0];

    let messages = [];

    if (session.chat_type === "TASK") {
      await assertTaskAccess(req.user.id, session.task_id);

      const result = await pool.query(
        `
        SELECT id, role, content, sources, created_at
        FROM ai_task_messages
        WHERE session_id = $1
          AND user_id = $2
          AND task_id = $3
        ORDER BY created_at ASC
        LIMIT 100
        `,
        [session.id, req.user.id, session.task_id]
      );

      messages = result.rows;
    } else {
      const result = await pool.query(
        `
        SELECT id, role, content, sources, created_at
        FROM ai_global_messages
        WHERE session_id = $1
          AND user_id = $2
        ORDER BY created_at ASC
        LIMIT 100
        `,
        [session.id, req.user.id]
      );

      messages = result.rows;
    }

    return ok(res, {
      session: {
        id: session.id,
        chatType: session.chat_type,
        taskId: session.task_id,
        status: session.status,
        title: session.title,
        createdAt: session.created_at,
        endedAt: session.ended_at,
      },
      messages,
    });
  } catch (error) {
    console.error("GET AI SESSION HISTORY ERROR:", error);

    const status = error.status || 500;

    return fail(
      res,
      status,
      status === 500
        ? "Unable to load chat history."
        : error.message
    );
  }
}

// ============================================================
// EXPORTS
// ============================================================

module.exports = {
  taskChat,
  getTaskChatHistory,
  globalChat,
  getGlobalChatHistory,
  endTaskChat,
  endGlobalChat,
  endAllChats,
  getRecentChats,
  getChatSessionHistory,
  deleteChatSession,
  getGlobalActionProposals,
  approveGlobalActionProposal,
  cancelGlobalActionProposal,
};
