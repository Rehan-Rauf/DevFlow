const crypto = require("crypto");
const pool = require("../config/database");

function securityDigest(value) {
  return crypto
    .createHmac("sha256", process.env.JWT_SECRET)
    .update(String(value || ""))
    .digest("hex");
}

async function consumeResetRateLimit(bucket, value, { limit, windowMinutes }) {
  await pool.query(
    `DELETE FROM password_reset_rate_limits
     WHERE window_started_at < NOW() - INTERVAL '2 hours'`,
  );
  const result = await pool.query(
    `INSERT INTO password_reset_rate_limits
       (bucket, key_hash, window_started_at, request_count)
     VALUES ($1, $2, NOW(), 1)
     ON CONFLICT (bucket, key_hash) DO UPDATE
       SET window_started_at = CASE
             WHEN password_reset_rate_limits.window_started_at
               <= NOW() - ($3 * INTERVAL '1 minute')
             THEN NOW()
             ELSE password_reset_rate_limits.window_started_at
           END,
           request_count = CASE
             WHEN password_reset_rate_limits.window_started_at
               <= NOW() - ($3 * INTERVAL '1 minute')
             THEN 1
             ELSE password_reset_rate_limits.request_count + 1
           END
     RETURNING request_count`,
    [bucket, securityDigest(value), windowMinutes],
  );
  return result.rows[0].request_count <= limit;
}

async function recordAuthSecurityEvent({
  eventType,
  userId = null,
  subject = "",
  source = "",
}) {
  await pool.query(
    `INSERT INTO auth_security_events (event_type, user_id, subject_hash, source_hash)
     VALUES ($1, $2, $3, $4)`,
    [
      eventType,
      userId,
      subject ? securityDigest(subject) : null,
      source ? securityDigest(source) : null,
    ],
  );
}

module.exports = {
  consumeResetRateLimit,
  recordAuthSecurityEvent,
  securityDigest,
};
