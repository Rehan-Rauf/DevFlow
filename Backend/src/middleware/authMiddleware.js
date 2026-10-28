// Import jsonwebtoken package.
// It is used to verify JWT tokens.
const crypto = require("crypto");
const jwt = require("jsonwebtoken");
const pool = require("../config/database");

function hashToken(token) {
  return crypto.createHash("sha256").update(token).digest("hex");
}

async function isTokenRevoked(token, payload) {
  const result = await pool.query(
    `SELECT 1
     FROM revoked_auth_tokens
     WHERE token_hash = $1
       AND expires_at > NOW()
     LIMIT 1`,
    [hashToken(token)],
  );
  if (result.rowCount) return true;

  if (payload?.id === undefined) return false;
  const userResult = await pool.query(
    "SELECT status, auth_version FROM users WHERE id = $1",
    [payload.id],
  );
  return !userResult.rowCount
    || userResult.rows[0].status !== "active"
    || Number(userResult.rows[0].auth_version) !== Number(payload.authVersion ?? 0);
}


// ======================================================
// REQUIRE AUTHENTICATION
// ======================================================

// This middleware checks whether the user is logged in
// by checking the JWT token sent in the request.
async function requireAuth(req, res, next) {

  // Get the Authorization header from the request.
  //
  // Expected format:
  // Authorization: Bearer YOUR_TOKEN
  const header = req.headers.authorization;


  // Check if Authorization header is missing
  // OR it does not start with "Bearer ".
  //
  // If there is no valid header, user is not authenticated.
  if (!header || !header.startsWith("Bearer ")) {

    return res.status(401).json({

      // Tell frontend that request was not successful.
      success: false,

      // Error message.
      message: "Authentication required."

    });
  }


  // Try to verify the JWT token.
  // If anything goes wrong, catch block will run.
  try {

    // Remove "Bearer " from the beginning of the header.
    //
    // Example:
    // "Bearer abc123"
    // becomes:
    // "abc123"
    const token = header.slice(7);


    // Verify that the token is valid.
    //
    // jwt.verify() checks:
    // 1. Is the token real?
    // 2. Was it created using our JWT_SECRET?
    // 3. Has it expired?
    //
    // JWT_SECRET comes from the .env file.
    const payload = jwt.verify(
      token,
      process.env.JWT_SECRET
    );

    if (await isTokenRevoked(token, payload)) {
      return res.status(401).json({
        success: false,
        message: "Authentication token has been revoked.",
      });
    }


    // Save the user's information inside req.user.
    //
    // This allows the next middleware/controller
    // to know which user is making the request.
    req.user = {
      id: Number(payload.id),
      role: payload.role
    };
    req.authToken = token;
    req.authPayload = payload;


    // Token is valid.
    // Continue to the next middleware/controller.
    next();


  } catch (error) {
    if (error?.name === "JsonWebTokenError" || error?.name === "TokenExpiredError") {
      return res.status(401).json({
        success: false,
        message: "Invalid or expired token.",
      });
    }

    console.error("Authentication check failed:", error);
    // Token is invalid or expired.
    // Stop the request and return 401 Unauthorized.
    return res.status(500).json({

      success: false,

      message: "Unable to verify authentication."

    });
  }
}



// ======================================================
// REQUIRE SYSTEM ADMIN
// ======================================================

// This middleware checks whether the logged-in user
// has the "admin" role.
function requireSystemAdmin(req, res, next) {

  // req.user was created by requireAuth().
  //
  // Check the user's role.
  //
  // If the role is NOT "admin", access is denied.
  if (req.user?.role !== "admin") {

    return res.status(403).json({

      success: false,

      // User is logged in but does not have
      // administrator permission.
      message: "System administrator permission required."

    });
  }


  // User is an admin.
  // Allow the request to continue.
  next();
}



// Export both middleware functions
// so they can be used in route files.
module.exports = {
  requireAuth,
  requireSystemAdmin,
  isTokenRevoked,
  hashToken,
};