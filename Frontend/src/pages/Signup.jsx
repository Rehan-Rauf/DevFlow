import { useEffect, useState } from "react";
import { Link, useNavigate, useSearchParams } from "react-router-dom";
import { useAuth } from "../context/AuthContext";

const PASSWORD_REQUIREMENTS = [
  { label: "At least 8 characters", test: (value) => value.length >= 8 },
  { label: "One uppercase letter", test: (value) => /[A-Z]/.test(value) },
  { label: "One lowercase letter", test: (value) => /[a-z]/.test(value) },
  { label: "One number", test: (value) => /[0-9]/.test(value) },
  { label: "One special character", test: (value) => /[!@#$%^&*(),.?":{}|<>_\-\\[\]~`+/;'=]/.test(value) },
];

const EMAIL_REGEX =
  /^(?!.*\.\.)[A-Za-z0-9!#$%&'*+/=?^_`{|}~-]+(?:\.[A-Za-z0-9!#$%&'*+/=?^_`{|}~-]+)*@(?:[A-Za-z0-9](?:[A-Za-z0-9-]{0,61}[A-Za-z0-9])?\.)+[A-Za-z]{2,63}$/;

function getPasswordErrors(password) {
  return PASSWORD_REQUIREMENTS
    .filter((requirement) => !requirement.test(password))
    .map((requirement) => requirement.label.toLowerCase());
}

function getEmailError(email) {
  if (!email.trim()) return "Email is required.";
  return EMAIL_REGEX.test(email.trim()) ? "" : "Please enter a valid email address.";
}

function getPasswordError(password) {
  if (!password) return "Password is required.";

  const missingRequirements = getPasswordErrors(password);
  return missingRequirements.length
    ? `Password must include ${missingRequirements.join(", ")}.`
    : "";
}

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

export default function Signup() {
  const { signup, user } = useAuth();
  const navigate = useNavigate();
  const [searchParams] = useSearchParams();
  const redirect = searchParams.get("redirect") || "/organizations";

  useEffect(() => {
    if (user) {
      navigate(redirect, { replace: true });
    }
  }, [user, navigate, redirect]);

  const [form, setForm] = useState({ name: "", email: "", password: "" });
  const [fieldErrors, setFieldErrors] = useState({});
  const [error, setError] = useState("");
  const [busy, setBusy] = useState(false);
  const [passwordTouched, setPasswordTouched] = useState(false);
  const [showPassword, setShowPassword] = useState(false);

  // Har field ki value aur pehle dikhaya gaya error aik saath update hota hai.
  function updateField(field, value) {
    const nextForm = { ...form, [field]: value };
    setForm(nextForm);

    if (fieldErrors[field]) {
      const nextError = field === "email"
        ? getEmailError(value)
        : field === "password"
          ? getPasswordError(value)
          : value.trim() ? "" : "Name is required.";
      setFieldErrors((current) => ({ ...current, [field]: nextError }));
    }
  }

  function validateForm() {
    const errors = {
      name: form.name.trim() ? "" : "Name is required.",
      email: getEmailError(form.email),
      password: getPasswordError(form.password),
    };

    setFieldErrors(errors);
    return !Object.values(errors).some(Boolean);
  }

  async function submit(event) {
    event.preventDefault();
    setError("");
    setPasswordTouched(true);

    if (!validateForm()) return;

    setBusy(true);
    try {
      await signup(form);
      navigate(redirect);
    } catch (requestError) {
      setError(requestError.message || "Unable to create account.");
    } finally {
      setBusy(false);
    }
  }

  const passwordErrors = getPasswordErrors(form.password);

  return (
    <div className="auth-page">
      <form className="auth-card" onSubmit={submit} noValidate>
        <div className="brand centered">
          <div className="brand-mark">D</div>
          <div><strong>DevFlow</strong><span>Workspace</span></div>
        </div>

        <h1>Create your account</h1>
        <p className="muted">Start managing organizations, projects and tasks.</p>

        {error && <div className="error-box" role="alert">{error}</div>}

        <label>
          Name
          <input
            required
            value={form.name}
            onChange={(event) => updateField("name", event.target.value)}
            onBlur={() => setFieldErrors((current) => ({ ...current, name: form.name.trim() ? "" : "Name is required." }))}
            aria-invalid={Boolean(fieldErrors.name)}
            aria-describedby={fieldErrors.name ? "signup-name-error" : undefined}
          />
          {fieldErrors.name && <span className="field-error" id="signup-name-error">{fieldErrors.name}</span>}
        </label>

        <label>
          Email
          <input
            required
            type="email"
            inputMode="email"
            autoComplete="email"
            value={form.email}
            onChange={(event) => updateField("email", event.target.value)}
            onBlur={() => setFieldErrors((current) => ({ ...current, email: getEmailError(form.email) }))}
            aria-invalid={Boolean(fieldErrors.email)}
            aria-describedby={fieldErrors.email ? "signup-email-error" : undefined}
          />
          {fieldErrors.email && <span className="field-error" id="signup-email-error">{fieldErrors.email}</span>}
        </label>

        <label htmlFor="signup-password">Password</label>
        <span className="password-input-wrap">
          <input
            id="signup-password"
            required
            type={showPassword ? "text" : "password"}
            minLength="8"
            autoComplete="new-password"
            value={form.password}
            onChange={(event) => updateField("password", event.target.value)}
            onBlur={() => {
              setPasswordTouched(true);
              setFieldErrors((current) => ({ ...current, password: getPasswordError(form.password) }));
            }}
            aria-invalid={Boolean(fieldErrors.password)}
            aria-describedby={fieldErrors.password ? "password-requirements signup-password-error" : "password-requirements"}
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
        {fieldErrors.password && <span className="field-error" id="signup-password-error">{fieldErrors.password}</span>}

        <ul className={`password-requirements ${passwordTouched ? "is-touched" : ""}`} id="password-requirements" aria-label="Password requirements">
          {PASSWORD_REQUIREMENTS.map((requirement) => {
            const met = requirement.test(form.password);
            return <li className={met ? "is-met" : ""} key={requirement.label}>{met ? "✓" : "○"} {requirement.label}</li>;
          })}
        </ul>

        <button className="primary-button wide" disabled={busy}>
          {busy ? "Creating..." : "Create account"}
        </button>

        <p className="auth-switch">Already have an account? <Link to="/login">Sign in</Link></p>
      </form>
    </div>
  );
}
