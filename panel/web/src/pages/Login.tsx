import { useState, type FormEvent } from "react";
import { useNavigate } from "react-router-dom";
import { useAuth } from "../context/useAuth";
import { es } from "../i18n/es";

export function Login() {
  const { login, loginTotp } = useAuth();
  const navigate = useNavigate();

  const [password, setPassword] = useState("");
  const [totpCode, setTotpCode] = useState("");
  const [totpToken, setTotpToken] = useState<string | null>(null);
  const [error, setError] = useState("");
  const [loading, setLoading] = useState(false);

  async function handlePasswordSubmit(e: FormEvent) {
    e.preventDefault();
    setError("");
    setLoading(true);
    try {
      const result = await login(password);
      if (result.status === "totp_required") {
        setTotpToken(result.totpToken);
      } else {
        navigate("/", { replace: true });
      }
    } catch {
      setError(es.auth.invalidCredentials);
    } finally {
      setLoading(false);
    }
  }

  async function handleTotpSubmit(e: FormEvent) {
    e.preventDefault();
    setError("");
    setLoading(true);
    try {
      await loginTotp(totpCode, totpToken!);
      navigate("/", { replace: true });
    } catch {
      setError(es.auth.invalidTotp);
    } finally {
      setLoading(false);
    }
  }

  if (totpToken) {
    return (
      <div className="login-container">
        <h1>{es.app.title}</h1>
        <h2>{es.auth.totpTitle}</h2>
        <form onSubmit={handleTotpSubmit}>
          <label>
            {es.auth.totpCode}
            <input
              type="text"
              inputMode="numeric"
              pattern="[0-9]{6}"
              maxLength={6}
              autoComplete="one-time-code"
              value={totpCode}
              onChange={(e) => setTotpCode(e.target.value)}
              autoFocus
              required
            />
          </label>
          {error && <p className="error">{error}</p>}
          <button type="submit" disabled={loading}>
            {es.auth.verify}
          </button>
        </form>
      </div>
    );
  }

  return (
    <div className="login-container">
      <h1>{es.app.title}</h1>
      <h2>{es.auth.loginTitle}</h2>
      <form onSubmit={handlePasswordSubmit}>
        <label>
          {es.auth.password}
          <input
            type="password"
            autoComplete="current-password"
            value={password}
            onChange={(e) => setPassword(e.target.value)}
            autoFocus
            required
          />
        </label>
        {error && <p className="error">{error}</p>}
        <button type="submit" disabled={loading}>
          {es.auth.login}
        </button>
      </form>
    </div>
  );
}
