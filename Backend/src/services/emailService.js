const sgMail = require("@sendgrid/mail");
const fs = require("fs/promises");
const path = require("path");

function maskEmail(email) {
  const [localPart, domain] = String(email).split("@");
  if (!localPart || !domain) return "[invalid-email]";
  return `${localPart.slice(0, 1)}***@${domain}`;
}

function getInvitationUrl(token) {
  const frontendUrl = process.env.FRONTEND_URL || "http://localhost:5173";
  return `${frontendUrl.replace(/\/$/, "")}/invitations/${encodeURIComponent(token)}`;
}

function getPasswordResetUrl(token) {
  const frontendUrl = process.env.FRONTEND_URL || "http://localhost:5173";
  return `${frontendUrl.replace(/\/$/, "")}/reset-password?token=${encodeURIComponent(token)}`;
}

async function sendEmail(message) {
  const capturePath = process.env.NODE_ENV === "test"
    && process.env.DEVFLOW_TEST_EMAIL_CAPTURE_PATH;
  if (capturePath && message.subject === "Reset your DevFlow password") {
    await fs.mkdir(path.dirname(capturePath), { recursive: true });
    await fs.appendFile(
      capturePath,
      `${JSON.stringify({ to: message.to, text: message.text })}\n`,
      { encoding: "utf8", mode: 0o600 },
    );
    return { sent: true, captured: true };
  }

  const apiKey = process.env.SENDGRID_API_KEY?.trim();
  const fromEmail = process.env.SENDGRID_FROM_EMAIL?.trim();
  if (!apiKey || !fromEmail) {
    console.warn("Email notification skipped: SendGrid is not configured.");
    return { sent: false, skipped: true };
  }

  const recipient = Array.isArray(message.to) ? message.to[0] : message.to;
  console.info(
    `Email sending started: ${maskEmail(recipient)} from ${maskEmail(fromEmail)}`,
  );
  sgMail.setApiKey(apiKey);
  try {
    const [response] = await sgMail.send({
      ...message,
      from: fromEmail,
    });
    console.info(
      `Email sent: ${maskEmail(recipient)} (SendGrid ${response?.statusCode || "accepted"})`,
    );
    return { sent: true, statusCode: response?.statusCode };
  } catch (error) {
    const statusCode = error?.code || error?.response?.statusCode || "unknown";
    console.error(
      `Email failed for ${maskEmail(recipient)} (SendGrid ${statusCode}).`,
    );
    return { sent: false, skipped: false, statusCode };
  }
}

async function sendOrganizationInvitation({
  email,
  organizationName,
  role,
  inviterName,
  token,
}) {
  const invitationUrl = getInvitationUrl(token);
  const result = await sendEmail({
    to: email,
    subject: `You're invited to join ${organizationName} on DevFlow`,
    text: [
      `You have been invited to join ${organizationName} on DevFlow.`,
      `Role: ${role === "admin" ? "Admin" : "User"}`,
      `Invited by: ${inviterName}`,
      `Accept the invitation: ${invitationUrl}`,
    ].join("\n"),
    html: `<p>You have been invited to join <strong>${organizationName}</strong> on DevFlow.</p>
      <p>Role: <strong>${role === "admin" ? "Admin" : "User"}</strong><br>
      Invited by: ${inviterName}</p>
      <p><a href="${invitationUrl}">Accept Invitation</a></p>`,
  });
  return result;
}

async function sendPasswordResetEmail({ email, token }) {
  const resetUrl = getPasswordResetUrl(token);
  return sendEmail({
    to: email,
    subject: "Reset your DevFlow password",
    text: [
      "We received a request to reset your DevFlow password.",
      `Reset your password: ${resetUrl}`,
      "This link expires in one hour and can only be used once.",
      "If you did not request this, you can safely ignore this email.",
    ].join("\n"),
    html: `<p>We received a request to reset your DevFlow password.</p>
      <p><a href="${resetUrl}">Reset your password</a></p>
      <p>This link expires in one hour and can only be used once.</p>
      <p>If you did not request this, you can safely ignore this email.</p>`,
  });
}

module.exports = { sendOrganizationInvitation, sendPasswordResetEmail };
