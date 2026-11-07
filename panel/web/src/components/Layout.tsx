import { NavLink, Outlet, useNavigate } from "react-router-dom";
import { useAuth } from "../context/useAuth";
import { es } from "../i18n/es";

export function Layout() {
  const { user, logout } = useAuth();
  const navigate = useNavigate();

  async function handleLogout() {
    await logout();
    navigate("/login", { replace: true });
  }

  if (!user) return null;

  return (
    <div className="app-layout">
      <aside className="sidebar">
        <div className="sidebar-logo">{es.app.title}</div>
        <nav className="sidebar-nav">
          <NavLink
            to="/"
            end
            className={({ isActive }) =>
              `sidebar-link${isActive ? " active" : ""}`
            }
          >
            {es.nav.sites}
          </NavLink>
          <NavLink
            to="/databases"
            className={({ isActive }) =>
              `sidebar-link${isActive ? " active" : ""}`
            }
          >
            {es.nav.databases}
          </NavLink>
          <NavLink
            to="/backups"
            className={({ isActive }) =>
              `sidebar-link${isActive ? " active" : ""}`
            }
          >
            {es.nav.backups}
          </NavLink>
          <NavLink
            to="/backup-remotes"
            className={({ isActive }) =>
              `sidebar-link${isActive ? " active" : ""}`
            }
          >
            {es.nav.backupRemotes}
          </NavLink>
          <NavLink
            to="/cloudflare"
            className={({ isActive }) =>
              `sidebar-link${isActive ? " active" : ""}`
            }
          >
            {es.nav.cloudflare}
          </NavLink>
          <NavLink
            to="/git"
            className={({ isActive }) =>
              `sidebar-link${isActive ? " active" : ""}`
            }
          >
            {es.nav.git}
          </NavLink>
          <NavLink
            to="/alerts"
            className={({ isActive }) =>
              `sidebar-link${isActive ? " active" : ""}`
            }
          >
            {es.nav.alerts}
          </NavLink>
          <NavLink
            to="/removal-requests"
            className={({ isActive }) =>
              `sidebar-link${isActive ? " active" : ""}`
            }
          >
            {es.nav.removalRequests}
          </NavLink>
          <NavLink
            to="/audit"
            className={({ isActive }) =>
              `sidebar-link${isActive ? " active" : ""}`
            }
          >
            {es.nav.audit}
          </NavLink>
        </nav>
        <div className="sidebar-footer">
          <div className="sidebar-footer-email">{user.email}</div>
          <button className="btn btn-ghost btn-sm" onClick={handleLogout}>
            {es.auth.logout}
          </button>
        </div>
      </aside>
      <main className="main-content">
        <Outlet />
      </main>
    </div>
  );
}
