import { NavLink, Outlet, useNavigate } from "react-router-dom";
import { useAuth } from "../context/useAuth";
import { es } from "../i18n/es";

// Sections a client can reach. No audit, users, plans or account management.
const links = [
  { to: "/", label: es.nav.sites, end: true },
  { to: "/databases", label: es.nav.databases },
  { to: "/files", label: es.nav.files },
  { to: "/backups", label: es.nav.backups },
  { to: "/cloudflare", label: es.nav.cloudflare },
  { to: "/git", label: es.nav.github },
  { to: "/alerts", label: es.nav.alerts },
];

export function ClientLayout() {
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
        <nav className="sidebar-nav" aria-label={es.client.navLabel}>
          {links.map((l) => (
            <NavLink
              key={l.to}
              to={l.to}
              end={l.end}
              className={({ isActive }) =>
                `sidebar-link${isActive ? " active" : ""}`
              }
            >
              {l.label}
            </NavLink>
          ))}
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
