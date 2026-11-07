import {
  createContext,
  useState,
  useEffect,
  useCallback,
  type ReactNode,
} from "react";
import { api, setCsrfToken } from "../api/client";

interface User {
  id: number;
  email: string;
  role: "admin" | "client";
  hasTOTP?: boolean;
}

interface AuthState {
  user: User | null;
  isLoading: boolean;
  login: (password: string) => Promise<LoginResult>;
  loginTotp: (code: string, totpToken: string) => Promise<void>;
  logout: () => Promise<void>;
}

type LoginResult =
  | { status: "ok" }
  | { status: "totp_required"; totpToken: string };

export const AuthContext = createContext<AuthState | null>(null);

export function AuthProvider({ children }: { children: ReactNode }) {
  const [user, setUser] = useState<User | null>(null);
  const [isLoading, setIsLoading] = useState(true);

  useEffect(() => {
    api<{ user: User; csrfToken: string }>("/api/auth/me")
      .then((data) => {
        setUser(data.user);
        setCsrfToken(data.csrfToken);
      })
      .catch(() => {
        setUser(null);
        setCsrfToken(null);
      })
      .finally(() => setIsLoading(false));
  }, []);

  const login = useCallback(async (password: string): Promise<LoginResult> => {
    const data = await api<{
      status: string;
      user?: User;
      csrfToken?: string;
      totpToken?: string;
    }>("/api/auth/login", {
      method: "POST",
      body: JSON.stringify({ password }),
    });

    if (data.status === "totp_required") {
      return { status: "totp_required", totpToken: data.totpToken! };
    }

    setUser(data.user!);
    setCsrfToken(data.csrfToken!);
    return { status: "ok" };
  }, []);

  const loginTotp = useCallback(
    async (code: string, totpToken: string): Promise<void> => {
      const data = await api<{ user: User; csrfToken: string }>(
        "/api/auth/login/totp",
        {
          method: "POST",
          body: JSON.stringify({ code, totpToken }),
        },
      );
      setUser(data.user);
      setCsrfToken(data.csrfToken);
    },
    [],
  );

  const logout = useCallback(async (): Promise<void> => {
    await api("/api/auth/logout", { method: "POST" });
    setUser(null);
    setCsrfToken(null);
  }, []);

  return (
    <AuthContext.Provider value={{ user, isLoading, login, loginTotp, logout }}>
      {children}
    </AuthContext.Provider>
  );
}
