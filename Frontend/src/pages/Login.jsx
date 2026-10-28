import { useEffect, useState } from "react";
import { Link, useNavigate, useSearchParams } from "react-router-dom";
import { useAuth } from "../context/AuthContext";

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

export default function Login() {
  const { login, user } = useAuth();
  const navigate = useNavigate();
  const [searchParams] = useSearchParams();
  const redirect = searchParams.get("redirect") || "/overview";

  useEffect(() => {
    if (user) {
      navigate(redirect, { replace: true });
    }
  }, [user, navigate, redirect]);

  const [form, setForm] = useState({ email: "", password: "" });
  const [error, setError] = useState("");
  const [busy, setBusy] = useState(false);
  const [showPassword, setShowPassword] = useState(false);

  async function submit(event) {
    event.preventDefault();
    setError("");
    setBusy(true);

    try {
      await login(form);
      navigate(redirect);
    } catch (requestError) {
      setError(requestError.message || "Unable to sign in.");
    } finally {
      setBusy(false);
    }
  }

  return (
    <div className="auth-page">
      <form className="auth-card" onSubmit={submit}>
        <div className="brand centered">
          <div className="brand-mark">D</div>
          <div><strong>DevFlow</strong><span>Workspace</span></div>
        </div>

        <h1>Welcome back</h1>
        <p className="muted">Sign in to your workspace.</p>
        {error && <div className="error-box" role="alert">{error}</div>}

        <label>
          Email
          <input
            required
            type="email"
            inputMode="email"
            autoComplete="email"
            value={form.email}
            onChange={(event) => setForm({ ...form, email: event.target.value })}
          />
        </label>

        <label htmlFor="login-password">Password</label>
        <span className="password-input-wrap">
          <input
            id="login-password"
            required
            type={showPassword ? "text" : "password"}
            autoComplete="current-password"
            value={form.password}
            onChange={(event) => setForm({ ...form, password: event.target.value })}
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

        <button className="primary-button wide" disabled={busy}>
          {busy ? "Signing in..." : "Sign in"}
        </button>

        <p className="auth-switch"><Link to="/forgot-password">Forgot password?</Link></p>
        <p className="auth-switch">Don't have an account? <Link to="/signup">Create one</Link></p>
      </form>
    </div>
  );
}
