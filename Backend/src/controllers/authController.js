// bcryptjs password ko securely hash aur compare karne ke liye use hota hai
const bcrypt = require("bcryptjs");
const crypto = require("crypto");

// jsonwebtoken JWT token create karne ke liye use hota hai
const jwt = require("jsonwebtoken");

// PostgreSQL database ke saath connection ke liye pool import kar rahe hain
const pool = require("../config/database");

// Response ko standard format mein bhejne ke liye helper functions
const { ok, created, fail } = require("../utils/response");
const { hashToken } = require("../middleware/authMiddleware");
const { sendPasswordResetEmail } = require("../services/emailService");
const {
  consumeResetRateLimit,
  recordAuthSecurityEvent,
  securityDigest,
} = require("../services/passwordResetSecurity");

const emailRegex =
  /^(?!.*\.\.)[A-Za-z0-9!#$%&'*+/=?^_`{|}~-]+(?:\.[A-Za-z0-9!#$%&'*+/=?^_`{|}~-]+)*@(?:[A-Za-z0-9](?:[A-Za-z0-9-]{0,61}[A-Za-z0-9])?\.)+[A-Za-z]{2,63}$/;

// Ye rules signup aur API dono jagah password ko mazboot rakhte hain.
const passwordRequirements = [
  { test: (value) => value.length >= 8, message: "at least 8 characters" },
  { test: (value) => /[A-Z]/.test(value), message: "one uppercase letter" },
  { test: (value) => /[a-z]/.test(value), message: "one lowercase letter" },
  { test: (value) => /[0-9]/.test(value), message: "one number" },
  { test: (value) => /[!@#$%^&*(),.?\":{}|<>_\-\\[\]~`+/;'=]/.test(value), message: "one special character" },
];

// Jo password rules poore na hon unki saaf list return karte hain.
function getPasswordErrors(password) {
  return passwordRequirements
    .filter((requirement) => !requirement.test(password))
    .map((requirement) => requirement.message);
}

function getResetToken() {
  return crypto.randomBytes(32).toString("hex");
}

function disconnectUserSockets(req, userId, token = null) {
  const sockets = req.app.get("io")?.sockets?.sockets;
  if (!sockets) return;

  for (const socket of sockets.values()) {
    if (
      Number(socket.user?.id) === Number(userId)
      && (!token || socket.authToken === token)
    ) {
      socket.disconnect(true);
    }
  }
}

// ======================================================
// MAKE JWT TOKEN
// ======================================================

// Ye function user ke liye JWT token banata hai
function makeToken(user) {
  return jwt.sign(
    // Token ke andar ye information store hogi
    {
      id: user.id,
      role: user.role,
      authVersion: user.auth_version ?? 0,
    },

    // JWT secret .env file se aa raha hai
    process.env.JWT_SECRET,

    // Token 7 days baad expire ho jayega
    {
      expiresIn: "7d",
    },
  );
}

// ======================================================
// SIGNUP / REGISTER
// ======================================================

async function signup(req, res) {
  try {
    // Frontend se name, email aur password receive kar rahe hain
    const { name, email, password } = req.body;

    // ==================================================
    // REQUIRED FIELDS VALIDATION
    // ==================================================

    if (
      typeof name !== "string" ||
      typeof email !== "string" ||
      typeof password !== "string" ||
      !name.trim() ||
      name.trim().length > 120 ||
      !email.trim() ||
      !password
    ) {
      return fail(
        res,
        400,
        "Name, email and password are required.",
      );
    }

    // ==================================================
    // NORMALIZE EMAIL
    // ==================================================

    // Email ko trim aur lowercase kar rahe hain
    const normalizedEmail = email.trim().toLowerCase();

    // ==================================================
    // STRICT EMAIL VALIDATION
    // ==================================================

    // This validation checks:
    //
    // - Exactly one @
    // - No spaces
    // - No consecutive dots
    // - Email cannot start with a dot
    // - Email cannot end with a dot before @
    // - Domain must contain a dot
    // - Domain cannot start/end with a hyphen
    // - Valid domain extension is required
    //
    // Examples rejected:
    //
    // john..doe@gmail.com
    // john.doe.@gmail.com
    // john doe@gmail.com
    // john@@gmail.com
    // john@gmail..com

    if (!emailRegex.test(normalizedEmail)) {
      return fail(
        res,
        400,
        "Please enter a valid email address.",
      );
    }

    // ==================================================
    // PASSWORD VALIDATION
    // ==================================================

    // Password security requirements
    //
    // - At least 8 characters
    // - One uppercase letter
    // - One lowercase letter
    // - One number
    // - One special character

    const passwordErrors = getPasswordErrors(password);

    if (passwordErrors.length > 0) {
      return fail(
        res,
        400,
        `Password must include ${passwordErrors.join(", ")}.`,
      );
    }

    // ==================================================
    // EXISTING EMAIL CHECK
    // ==================================================

    const existing = await pool.query(
      "SELECT id FROM users WHERE email = $1",
      [normalizedEmail],
    );

    // Agar email already exist karti hai
    if (existing.rowCount) {
      return fail(
        res,
        409,
        "Email is already registered.",
      );
    }

    // ==================================================
    // PASSWORD HASH
    // ==================================================

    // Password ko database mein plain text mein save nahi karna
    const hashedPassword = await bcrypt.hash(password, 12);

    // ==================================================
    // CREATE USER
    // ==================================================

    const result = await pool.query(
      `INSERT INTO users (name, email, password)
       VALUES ($1, $2, $3)
       RETURNING id, name, email, role, status, auth_version, created_at`,

      [
        name.trim(),
        normalizedEmail,
        hashedPassword,
      ],
    );

    const user = result.rows[0];

    // ==================================================
    // SUCCESS RESPONSE
    // ==================================================

    return created(
      res,
      {
        user,
        token: makeToken(user),
      },
      "Account created successfully.",
    );

  } catch (error) {
    // Unexpected error ko console mein show karenge
    console.error("Signup error:", error);

    return fail(
      res,
      500,
      "Unable to create account.",
    );
  }
}

// ======================================================
// LOGIN
// ======================================================

async function login(req, res) {
  try {
    // Frontend se email aur password receive kar rahe hain
    const { email, password } = req.body;

    // Check kar rahe hain ke email/password provided hain
    if (!email?.trim() || !password) {
      return fail(
        res,
        400,
        "Email and password are required.",
      );
    }

    // Database mein email ke according user search kar rahe hain
    const result = await pool.query(
      `SELECT id, name, email, password, role, status, auth_version
       FROM users
       WHERE email = $1`,

      [email.trim().toLowerCase()],
    );

    // Agar user nahi mila
    if (!result.rowCount) {
      return fail(
        res,
        401,
        "Invalid email or password.",
      );
    }

    // Database se user data nikal rahe hain
    const user = result.rows[0];

    // Check kar rahe hain ke account active hai ya nahi
    if (user.status !== "active") {
      return fail(
        res,
        403,
        "This account is not active.",
      );
    }

    // User ke entered password ko database ke hashed password
    // ke saath compare kar rahe hain
    const matches = await bcrypt.compare(
      password,
      user.password,
    );

    // Agar password wrong hai
    if (!matches) {
      return fail(
        res,
        401,
        "Invalid email or password.",
      );
    }

    // Response bhejne se pehle password remove kar rahe hain
    delete user.password;

    // Login successful response
    return ok(
      res,
      {
        user,

        // Login ke baad JWT token create kar rahe hain
        token: makeToken(user),
      },

      "Login successful.",
    );

  } catch (error) {
    // Unexpected error ko console mein show karenge
    console.error("Login error:", error);

    return fail(
      res,
      500,
      "Unable to login.",
    );
  }
}

async function requestPasswordReset(req, res) {
  const emailInput = typeof req.body?.email === "string"
    ? req.body.email.trim().toLowerCase()
    : "";
  const email = emailInput.slice(0, 254);

  try {
    const ipAllowed = await consumeResetRateLimit("ip", req.ip, {
      limit: 20,
      windowMinutes: 60,
    });
    if (!ipAllowed) {
      await recordAuthSecurityEvent({
        eventType: "password_reset_rate_limited",
        subject: email,
        source: req.ip,
      });
      return ok(
        res,
        null,
        "If an active account exists for that email, a password reset link has been sent.",
      );
    }

    if (emailInput.length > 254 || !emailRegex.test(email)) {
      await recordAuthSecurityEvent({
        eventType: "password_reset_rejected",
        subject: email,
        source: req.ip,
      });
      return fail(res, 400, "Please enter a valid email address.");
    }

    const emailAllowed = await consumeResetRateLimit("email", email, {
      limit: 3,
      windowMinutes: 60,
    });

    if (!emailAllowed) {
      await recordAuthSecurityEvent({
        eventType: "password_reset_rate_limited",
        subject: email,
        source: req.ip,
      });
      return ok(
        res,
        null,
        "If an active account exists for that email, a password reset link has been sent.",
      );
    }

    const client = await pool.connect();
    let user;
    let token;
    try {
      await client.query("BEGIN");
      const result = await client.query(
        `SELECT id, email FROM users
         WHERE email = $1 AND status = 'active'
         FOR UPDATE`,
        [email],
      );
      user = result.rows[0] || null;

      if (user) {
        token = getResetToken();
        await client.query(
          "UPDATE password_reset_tokens SET used_at = NOW() WHERE user_id = $1 AND used_at IS NULL",
          [user.id],
        );
        await client.query(
          `INSERT INTO password_reset_tokens (token_hash, user_id, expires_at)
           VALUES ($1, $2, NOW() + INTERVAL '1 hour')`,
          [hashToken(token), user.id],
        );
      }

      await client.query(
        `INSERT INTO auth_security_events
           (event_type, user_id, subject_hash, source_hash)
         VALUES ('password_reset_requested', $1, $2, $3)`,
        [
          user?.id || null,
          securityDigest(email),
          securityDigest(req.ip),
        ],
      );
      await client.query("COMMIT");
    } catch (error) {
      await client.query("ROLLBACK");
      throw error;
    } finally {
      client.release();
    }

    if (user) {
      const emailResult = await sendPasswordResetEmail({
        email: user.email,
        token,
      });
      if (!emailResult.sent) {
        console.error(
          `Password reset email was not sent (status ${emailResult.statusCode || "unavailable"}).`,
        );
      }
    }

    return ok(
      res,
      null,
      "If an active account exists for that email, a password reset link has been sent.",
    );
  } catch (error) {
    console.error("Password reset request error:", error);
    return fail(res, 500, "Unable to process the password reset request.");
  }
}

async function resetPassword(req, res) {
  const token = typeof req.body?.token === "string" ? req.body.token.trim() : "";
  const password = typeof req.body?.password === "string" ? req.body.password : "";

  if (!/^[a-f0-9]{64}$/i.test(token)) {
    await recordAuthSecurityEvent({
      eventType: "password_reset_rejected",
      subject: token,
      source: req.ip,
    });
    return fail(res, 400, "This password reset link is invalid or has expired.");
  }

  const passwordErrors = getPasswordErrors(password);
  if (passwordErrors.length) {
    return fail(res, 400, `Password must include ${passwordErrors.join(", ")}.`);
  }

  let client;
  try {
    client = await pool.connect();
    await client.query("BEGIN");
    const result = await client.query(
      `SELECT user_id
       FROM password_reset_tokens prt
       JOIN users u ON u.id = prt.user_id
       WHERE prt.token_hash = $1
         AND prt.used_at IS NULL
         AND prt.expires_at > NOW()
         AND u.status = 'active'
       FOR UPDATE OF prt, u`,
      [hashToken(token)],
    );

    if (!result.rowCount) {
      await client.query("ROLLBACK");
      await recordAuthSecurityEvent({
        eventType: "password_reset_rejected",
        subject: token,
        source: req.ip,
      });
      return fail(res, 400, "This password reset link is invalid, expired, or has already been used.");
    }

    const hashedPassword = await bcrypt.hash(password, 12);
    await client.query(
      `UPDATE users
       SET password = $1, auth_version = auth_version + 1, updated_at = NOW()
       WHERE id = $2`,
      [hashedPassword, result.rows[0].user_id],
    );
    await client.query(
      `UPDATE password_reset_tokens SET used_at = NOW()
       WHERE user_id = $1 AND used_at IS NULL`,
      [result.rows[0].user_id],
    );
    await client.query(
      `INSERT INTO auth_security_events (event_type, user_id, subject_hash, source_hash)
       VALUES ('password_reset_completed', $1, $2, $3)`,
      [
        result.rows[0].user_id,
        securityDigest(result.rows[0].user_id),
        securityDigest(req.ip),
      ],
    );
    await client.query("COMMIT");

    disconnectUserSockets(req, result.rows[0].user_id);
    return ok(res, null, "Password changed successfully. You can now sign in.");
  } catch (error) {
    if (client) {
      await client.query("ROLLBACK").catch(() => {});
    }
    if (error?.code === "23503" || error?.code === "P0002") {
      await recordAuthSecurityEvent({
        eventType: "password_reset_rejected",
        subject: token,
        source: req.ip,
      });
      return fail(res, 400, "This password reset link is invalid, expired, or has already been used.");
    }
    console.error("Password reset error:", error);
    return fail(res, 500, "Unable to reset your password.");
  } finally {
    client?.release();
  }
}

// ======================================================
// CURRENT USER / ME
// ======================================================

async function me(req, res) {
  try {
    // Database se current logged-in user ko find kar rahe hain
    // req.user.id authentication middleware se aata hai
    const result = await pool.query(
      `SELECT id, name, email, role, status, created_at
       FROM users
       WHERE id = $1`,

      [req.user.id],
    );

    // Agar user database mein nahi mila
    if (!result.rowCount) {
      return fail(
        res,
        404,
        "User not found.",
      );
    }

    // Current user ka data return kar rahe hain
    return ok(
      res,
      result.rows[0],
    );

  } catch (error) {
    // Error console mein show karenge
    console.error("Current user error:", error);

    return fail(
      res,
      500,
      "Unable to load current user.",
    );
  }
}

// ======================================================
// UPDATE CURRENT USER
// ======================================================
// The authenticated identity always comes from the JWT; callers can only edit
// their own display name and cannot alter another account or their system role.
async function updateMe(req, res) {
  try {
    const name = String(req.body?.name || "").trim();

    if (!name || name.length > 120) {
      return fail(res, 400, "Name is required and must be 120 characters or fewer.");
    }

    const result = await pool.query(
      `UPDATE users SET name = $1, updated_at = NOW()
       WHERE id = $2
       RETURNING id, name, email, role, status, created_at, updated_at`,
      [name, req.user.id],
    );

    if (!result.rowCount) return fail(res, 404, "User not found.");
    return ok(res, result.rows[0], "Profile updated.");
  } catch (error) {
    console.error("Update profile error:", error);
    return fail(res, 500, "Unable to update profile.");
  }
}

// Revoke the presented JWT so it cannot be used again after logout.
async function logout(req, res) {
  try {
    const token = req.authToken;
    const expiresAt = req.authPayload?.exp
      ? new Date(req.authPayload.exp * 1000)
      : null;

    if (!token || !expiresAt || Number.isNaN(expiresAt.getTime())) {
      return fail(res, 401, "Authentication required.");
    }

    await pool.query(
      `INSERT INTO revoked_auth_tokens (token_hash, expires_at)
       VALUES ($1, $2)
       ON CONFLICT (token_hash) DO NOTHING`,
      [hashToken(token), expiresAt],
    );
    disconnectUserSockets(req, req.user.id, token);

    return ok(res, null, "Logged out successfully.");
  } catch (error) {
    console.error("Logout error:", error);
    return fail(res, 500, "Unable to log out.");
  }
}

// ======================================================
// EXPORT FUNCTIONS
// ======================================================

// In functions ko doosri files mein use karne ke liye export kar rahe hain
module.exports = {
  signup,
  login,
  me,
  updateMe,
  logout,
  requestPasswordReset,
  resetPassword,
  makeToken,
};
