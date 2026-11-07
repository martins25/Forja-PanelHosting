import { useState, type FormEvent } from "react";
import { useNavigate } from "react-router-dom";
import { QRCodeSVG } from "qrcode.react";
import { api } from "../api/client";
import { es } from "../i18n/es";

export function TotpSetup() {
  const navigate = useNavigate();
  const [secret, setSecret] = useState("");
  const [uri, setUri] = useState("");
  const [code, setCode] = useState("");
  const [error, setError] = useState("");
  const [loading, setLoading] = useState(false);
  const [step, setStep] = useState<"init" | "scan">("init");

  async function handleGenerate() {
    setLoading(true);
    try {
      const data = await api<{ secret: string; uri: string }>(
        "/api/auth/totp/setup",
        { method: "POST" },
      );
      setSecret(data.secret);
      setUri(data.uri);
      setStep("scan");
    } catch {
      setError(es.auth.totpSetupError);
    } finally {
      setLoading(false);
    }
  }

  async function handleVerify(e: FormEvent) {
    e.preventDefault();
    setError("");
    setLoading(true);
    try {
      await api("/api/auth/totp/enable", {
        method: "POST",
        body: JSON.stringify({ code, secret }),
      });
      navigate("/", { replace: true });
    } catch {
      setError(es.auth.invalidTotp);
    } finally {
      setLoading(false);
    }
  }

  if (step === "init") {
    return (
      <div className="login-container">
        <h1>{es.app.title}</h1>
        <h2>{es.auth.totpSetupTitle}</h2>
        <p>{es.auth.totpSetupDescription}</p>
        {error && <p className="error">{error}</p>}
        <button onClick={handleGenerate} disabled={loading}>
          {es.auth.totpSetupStart}
        </button>
      </div>
    );
  }

  return (
    <div className="login-container">
      <h1>{es.app.title}</h1>
      <h2>{es.auth.totpSetupTitle}</h2>
      <p>{es.auth.totpScanQR}</p>
      <div className="qr-container">
        <QRCodeSVG value={uri} size={200} />
      </div>
      <form onSubmit={handleVerify}>
        <label>
          {es.auth.totpCode}
          <input
            type="text"
            inputMode="numeric"
            pattern="[0-9]{6}"
            maxLength={6}
            autoComplete="one-time-code"
            value={code}
            onChange={(e) => setCode(e.target.value)}
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
