// Load Backend/.env regardless of the directory used to launch the process.
const path = require("path");
require("dotenv").config({
  path: path.resolve(__dirname, "../.env"),
});


// ===============================
// IMPORTS
// ===============================

const express = require("express");
const http = require("http");
const cors = require("cors");
const jwt = require("jsonwebtoken");
const { Server } = require("socket.io");
const { isTokenRevoked } = require("./middleware/authMiddleware");
const { assertTaskAccess } = require("./services/retrievalService");
const { emitTaskChanged } = require("./services/taskEventDelivery");
const { assertSingleSocketIoInstance } = require("./services/socketIoConfiguration");
const {
  emitToAuthorizedTaskRoom,
  registerTaskRoomHandlers,
} = require("./services/taskRoomAuthorization");

assertSingleSocketIoInstance();


// Routes
const knowledgeRoutes = require("./routes/knowledgeRoutes");
const authRoutes = require("./routes/authRoutes");
const organizationRoutes = require("./routes/organizationRoutes");
const invitationRoutes = require("./routes/invitationRoutes");
const projectRoutes = require("./routes/projectRoutes");
const taskRoutes = require("./routes/taskRoutes");
const commentRoutes = require("./routes/commentRoutes");
const aiRoutes = require("./routes/aiRoutes");
const memoryRoutes = require("./routes/memoryRoutes");

// ===============================
// CREATE SERVER
// ===============================

const app = express();

// Create HTTP server
// Socket.IO will use this server too.
const httpServer = http.createServer(app);


// ===============================
// SOCKET.IO
// ===============================

const io = new Server(httpServer, {
  cors: {
    origin: [
      process.env.FRONTEND_URL || "http://localhost:5173",
      "http://127.0.0.1:5173",
    ],
  }
});

async function authorizeSocketSession(socket) {
  if (!socket.authToken) {
    const error = new Error("Authentication token is missing.");
    error.status = 401;
    throw error;
  }
  let payload;
  try {
    payload = jwt.verify(socket.authToken, process.env.JWT_SECRET);
  } catch {
    const error = new Error("Authentication token is invalid or expired.");
    error.status = 401;
    throw error;
  }
  if (
    Number(payload.id) !== Number(socket.user?.id)
    || await isTokenRevoked(socket.authToken, payload)
  ) {
    const error = new Error("Authentication token has been revoked.");
    error.status = 401;
    throw error;
  }
}

async function authorizeTaskSocketAccess(userId, taskId, socket) {
  await authorizeSocketSession(socket);
  return assertTaskAccess(userId, taskId);
}

app.set("authorizeTaskSocketAccess", authorizeTaskSocketAccess);
app.set("emitTaskChanged", (taskId, options = {}) => emitTaskChanged(io, taskId, {
  ...options,
  authorizeTaskAccess: authorizeTaskSocketAccess,
  authorizeSocketSession,
}));


// ===============================
// SOCKET AUTHENTICATION
// ===============================

// This runs when a user tries to connect
// to Socket.IO.
io.use(async (socket, next) => {

  try {

    // Get JWT token from frontend
    const token = socket.handshake.auth?.token;

    // No token
    if (!token) {
      return next(new Error("Authentication required"));
    }

    // Check JWT token
    const payload = jwt.verify(
      token,
      process.env.JWT_SECRET
    );

    if (await isTokenRevoked(token, payload)) {
      return next(new Error("Authentication token has been revoked"));
    }

    // Save user information inside socket
    socket.authToken = token;
    socket.authPayload = payload;
    socket.user = {
      id: Number(payload.id),
      role: payload.role,
    };

    // Allow connection
    next();

  } catch (error) {

    // Token is invalid
    next(new Error("Invalid authentication token"));
  }
});


// ===============================
// USER CONNECTED
// ===============================

io.on("connection", (socket) => {

  console.log(
    "Socket connected:",
    socket.id
  );

  console.log(
    "User:",
    socket.user
  );


  // =============================
  // USER ROOM
  // =============================

  // Every user gets their own room.
  //
  // Example:
  // user id = 5
  //
  // Room:
  // user:5

  if (socket.user?.id) {

    socket.join(
      `user:${socket.user.id}`
    );

  }


  registerTaskRoomHandlers(socket, authorizeTaskSocketAccess);


  // =============================
  // USER DISCONNECTED
  // =============================

  socket.on("disconnect", () => {

    console.log(
      "Socket disconnected:",
      socket.id
    );

  });

});


// Make Socket.IO available
// inside controllers using:
//
// req.app.get("io")

app.set("io", io);


// ===============================
// PORT
// ===============================

const PORT = Number(
  process.env.PORT || 5001
);


// ===============================
// EXPRESS MIDDLEWARE
// ===============================

// Allow frontend → backend
app.use(
  cors({
    origin(origin, callback) {
      const configuredOrigin = process.env.FRONTEND_URL;
      const localOrigin =
        origin === "http://localhost:5173" ||
        origin === "http://127.0.0.1:5173";

      if (!origin || origin === configuredOrigin || localOrigin) {
        return callback(null, true);
      }

      return callback(new Error("Origin is not allowed by CORS."));
    },
  })
);


// Allow JSON request body
app.use(express.json());


// ===============================
// HEALTH CHECK
// ===============================

app.get("/api/health", (req, res) => {

  res.json({
    success: true,
    message: "DevFlow API is running."
  });

});


// ===============================
// ROUTES
// ===============================

app.use(
  "/api/auth",
  authRoutes
);

app.use(
  "/api/organizations",
  organizationRoutes
);
app.use("/api/invitations", invitationRoutes);

app.use(
  "/api/projects",
  projectRoutes
);

app.use(
  "/api/tasks",
  taskRoutes
);

app.use(
  "/api/comments",
  commentRoutes
);
// new add for AI analysis of task
app.use("/api/ai", aiRoutes);
app.use("/api/ai/memories", memoryRoutes);
app.use("/api/knowledge", knowledgeRoutes);
// ===============================
// 404
// ===============================

app.use((req, res) => {

  res.status(404).json({
    success: false,
    message: "Route not found."
  });

});


// ===============================
// ERROR HANDLER
// ===============================

app.use((error, req, res, next) => {

  console.error(
    "Server error:",
    error
  );

  res.status(500).json({
    success: false,
    message: "Internal server error."
  });

});



// ===============================
// START SERVER
// ===============================

httpServer.listen(PORT, () => {

  console.log(
    `DevFlow backend running on http://localhost:${PORT}`
  );

});
