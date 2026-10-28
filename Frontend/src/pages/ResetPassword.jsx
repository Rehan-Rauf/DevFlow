import { useState } from "react";
import { Link, useSearchParams } from "react-router-dom";
import { api } from "../services/api";

const requirements = [
  ["At least 8 characters", (value) => value.length >= 8],
  ["One uppercase letter", (value) => /[A-Z]/.test(value)],
  ["One lowercase letter", (value) => /[a-z]/.test(value)],
  ["One number", (value) => /[0-9]/.test(value)],
  ["One special character", (value) => /[!@#$%^&*(),.?":{}|<>_\-\\[\]~`+/;'=]/.test(value)],
];

function PasswordVisibilityIcon({ visible }) {
  return visible ? (
    <svg viewBox="0 0 24 24" aria-hidden="true" focusable="false">
      <path d="M3 3l18 18M10.6 10.7a2 2 0 0 0 2.7 2.7M9.9 4.3A10.7 10.7 0 0 1 12 4c5.2 0 8.7 4.4 9.8 6.2a1.5 1.5 0 0 1 0 1.6 18.5 18.5 0 0 1-3.2 3.8M6.6 6.6A18.6 18.6 0 0 0 2.2 10.2a1.5 1.5 0 0 0 0 1.6C3.3 13.6 6.8 18 12 18c1 0 1.9-.2 2.8-.5" />
    </svg>
  ) : (
    <svg viewBox="0 0 24 24" aria-hidden="true" focusable="false">
      <path d="M2.2 10.2a1.5 1.5 0 0 0 0 1.6C3.3 13.6 6.8 18 12 18s8.7-4.4 9.8-6.2a1.5 1.5 0 0 0 0-1.6C20.7 8.4 17.2 4 12 4S3.3 8.4 2.2 10.2Z" />
      <circle cx="12" cy="11" r="3" />
    </svg>
  );
}

export default function ResetPassword() {
  const [searchParams] = useSearchParams();
  const token = searchParams.get("token") || "";
  const [password, setPassword] = useState("");
  const [confirmation, setConfirmation] = useState("");
  const [message, setMessage] = useState("");
  const [error, setError] = useState("");
  const [busy, setBusy] = useState(false);
  const [showPassword, setShowPassword] = useState(false);
  const [showConfirmation, setShowConfirmation] = useState(false);

  async function submit(event) {
    event.preventDefault();
    setError("");
    setMessage("");
    if (password !== confirmation) {
      setError("Passwords do not match.");
      return;
    }
    setBusy(true);
    try {
      const response = await api.resetPassword({ token, password });
      setMessage(response.message);
      setPassword("");
      setConfirmation("");
    } catch (requestError) {
      setError(requestError.message || "Unable to reset your password.");
    } finally {
      setBusy(false);
    }
  }

  return (
    <div className="auth-page">
      <form className="auth-card" onSubmit={submit}>
        <div className="brand centered"><div className="brand-mark">D</div><div><strong>DevFlow</strong><span>Workspace</span></div></div>
        <h1>Set a new password</h1>
        <p className="muted">Choose a strong password for your account.</p>
        {error && <div className="error-box" role="alert">{error}</div>}
        {message && <div className="success-box" role="status">{message}</div>}
        <label htmlFor="reset-password">Password</label>
        <span className="password-input-wrap">
          <input
            id="reset-password"
            required
            type={showPassword ? "text" : "password"}
            autoComplete="new-password"
            value={password}
            onChange={(event) => setPassword(event.target.value)}
          />
          <button
            className="password-toggle"
            type="button"
            onClick={() => setShowPassword((visible) => !visible)}
            aria-label={showPassword ? "Hide password" : "Show password"}
            aria-pressed={showPassword}
          >
            <PasswordVisibilityIcon visible={showPassword} />
          </button>
        </span>
        <ul className="password-requirements" aria-label="Password requirements">
          {requirements.map(([label, test]) => <li className={test(password) ? "is-met" : ""} key={label}>{test(password) ? "✓" : "○"} {label}</li>)}
        </ul>
        <label>
          Confirm password
          <span className="password-input-wrap">
            <input required type={showConfirmation ? "text" : "password"} autoComplete="new-password" value={confirmation} onChange={(event) => setConfirmation(event.target.value)} />
            <button
              className="password-toggle"
              type="button"
              onClick={() => setShowConfirmation((visible) => !visible)}
              aria-label={showConfirmation ? "Hide confirmed password" : "Show confirmed password"}
              aria-pressed={showConfirmation}
            >
              <PasswordVisibilityIcon visible={showConfirmation} />
            </button>
          </span>
        </label>
        <button className="primary-button wide" disabled={busy || !token}>{busy ? "Saving..." : "Set new password"}</button>
        <p className="auth-switch"><Link to="/login">Back to sign in</Link></p>
      </form>
    </div>
  );
}
