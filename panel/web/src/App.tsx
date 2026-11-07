import { BrowserRouter, Routes, Route, Navigate } from "react-router-dom";
import { AuthProvider } from "./context/AuthContext";
import { ProtectedRoute } from "./components/ProtectedRoute";
import { RoleLayout, RoleHome, RequireAdmin } from "./components/RoleRoute";
import { Login } from "./pages/Login";
import { TotpSetup } from "./pages/TotpSetup";
import { CreateSite } from "./pages/CreateSite";
import { SiteDetail } from "./pages/SiteDetail";
import { Audit } from "./pages/Audit";
import { CloudflareConnections } from "./pages/CloudflareConnections";
import { GitIntegrations } from "./pages/GitIntegrations";
import { Databases } from "./pages/Databases";
import { FileManager } from "./pages/FileManager";
import { Backups } from "./pages/Backups";
import { FilesIndex } from "./pages/FilesIndex";
import { RemovalRequest } from "./pages/RemovalRequest";
import { RemovalRequests } from "./pages/RemovalRequests";
import { Alerts } from "./pages/Alerts";
import { BackupRemotes } from "./pages/BackupRemotes";

export function App() {
  return (
    <BrowserRouter>
      <AuthProvider>
        <Routes>
          <Route path="/login" element={<Login />} />
          <Route
            path="/totp-setup"
            element={
              <ProtectedRoute>
                <TotpSetup />
              </ProtectedRoute>
            }
          />
          <Route
            element={
              <ProtectedRoute>
                <RoleLayout />
              </ProtectedRoute>
            }
          >
            <Route path="/" element={<RoleHome />} />
            <Route path="/sites/new" element={<CreateSite />} />
            <Route path="/sites/:id" element={<SiteDetail />} />
            <Route path="/sites/:id/removal-request" element={<RemovalRequest />} />
            <Route path="/accounts/:accountId/files" element={<FileManager />} />
            <Route path="/databases" element={<Databases />} />
            <Route path="/backups" element={<Backups />} />
            <Route path="/cloudflare" element={<CloudflareConnections />} />
            <Route path="/git" element={<GitIntegrations />} />
            <Route path="/files" element={<FilesIndex />} />
            <Route path="/alerts" element={<Alerts />} />
            {/* Admin-only: clients are redirected to their home. */}
            <Route element={<RequireAdmin />}>
              <Route path="/audit" element={<Audit />} />
              <Route path="/backup-remotes" element={<BackupRemotes />} />
              <Route path="/removal-requests" element={<RemovalRequests />} />
            </Route>
          </Route>
          <Route path="*" element={<Navigate to="/" replace />} />
        </Routes>
      </AuthProvider>
    </BrowserRouter>
  );
}
