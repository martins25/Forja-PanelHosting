import { Navigate, Outlet } from "react-router-dom";
import { useAuth } from "../context/useAuth";
import { Layout } from "./Layout";
import { ClientLayout } from "./ClientLayout";
import { Dashboard } from "../pages/Dashboard";
import { ClientDashboard } from "../pages/ClientDashboard";

/** Renders the admin or the client shell depending on the user's role. */
export function RoleLayout() {
  const { user } = useAuth();
  if (!user) return null;
  return user.role === "admin" ? <Layout /> : <ClientLayout />;
}

/** Home page: the admin dashboard or the client's account-scoped one. */
export function RoleHome() {
  const { user } = useAuth();
  if (!user) return null;
  return user.role === "admin" ? <Dashboard /> : <ClientDashboard />;
}

/** Guards admin-only routes: clients are sent back to their home. */
export function RequireAdmin() {
  const { user } = useAuth();
  if (!user) return null;
  if (user.role !== "admin") return <Navigate to="/" replace />;
  return <Outlet />;
}
