import { useEffect, useState, useCallback, useRef, type FormEvent } from "react";
import { useParams, Link } from "react-router-dom";
import { api } from "../api/client";
import { es } from "../i18n/es";

interface FileEntry {
  name: string;
  type: "file" | "dir" | "symlink";
  size: number;
  mod_time: number;
  permissions: string;
}

interface ListResult {
  entries: FileEntry[];
  path: string;
}

interface ReadResult {
  name: string;
  content: string;
  encoding: "utf-8" | "base64";
  size: number;
}

export function FileManager() {
  const { accountId } = useParams<{ accountId: string }>();
  const [currentPath, setCurrentPath] = useState(".");
  const [entries, setEntries] = useState<FileEntry[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState("");

  const [editingFile, setEditingFile] = useState<string | null>(null);
  const [editorContent, setEditorContent] = useState("");
  const [saving, setSaving] = useState(false);

  const [showMkdir, setShowMkdir] = useState(false);
  const [newDirName, setNewDirName] = useState("");
  const [creating, setCreating] = useState(false);

  const [showUpload, setShowUpload] = useState(false);
  const [uploading, setUploading] = useState(false);
  const fileInputRef = useRef<HTMLInputElement>(null);

  const [deleteTarget, setDeleteTarget] = useState<FileEntry | null>(null);

  const loadDir = useCallback(
    (path: string) => {
      setLoading(true);
      setError("");
      setEditingFile(null);
      api<ListResult>(
        `/api/accounts/${accountId}/files?path=${encodeURIComponent(path)}`,
      )
        .then((data) => {
          setEntries(data.entries);
          setCurrentPath(path);
        })
        .catch((e) => setError(e.message))
        .finally(() => setLoading(false));
    },
    [accountId],
  );

  useEffect(() => {
    loadDir(".");
  }, [loadDir]);

  function navigate(entry: FileEntry) {
    if (entry.type === "dir") {
      const next = currentPath === "." ? entry.name : `${currentPath}/${entry.name}`;
      loadDir(next);
    } else {
      openFile(entry.name);
    }
  }

  function goUp() {
    if (currentPath === ".") return;
    const parts = currentPath.split("/");
    parts.pop();
    loadDir(parts.length === 0 ? "." : parts.join("/"));
  }

  function openFile(name: string) {
    const filePath =
      currentPath === "." ? name : `${currentPath}/${name}`;
    setError("");
    api<ReadResult>(
      `/api/accounts/${accountId}/files/content?path=${encodeURIComponent(filePath)}`,
    )
      .then((data) => {
        if (data.encoding === "base64") {
          setError(es.files.binaryNotEditable);
          return;
        }
        setEditingFile(filePath);
        setEditorContent(data.content);
      })
      .catch((e) => setError(e.message));
  }

  function handleSave() {
    if (!editingFile) return;
    setSaving(true);
    setError("");
    api(`/api/accounts/${accountId}/files/content`, {
      method: "PUT",
      body: JSON.stringify({ path: editingFile, content: editorContent }),
    })
      .then(() => {
        setEditingFile(null);
        loadDir(currentPath);
      })
      .catch((e) => setError(e.message))
      .finally(() => setSaving(false));
  }

  function handleMkdir(e: FormEvent) {
    e.preventDefault();
    if (!newDirName.trim()) return;
    setCreating(true);
    setError("");
    const dirPath =
      currentPath === "." ? newDirName : `${currentPath}/${newDirName}`;
    api(`/api/accounts/${accountId}/files/mkdir`, {
      method: "POST",
      body: JSON.stringify({ path: dirPath }),
    })
      .then(() => {
        setShowMkdir(false);
        setNewDirName("");
        loadDir(currentPath);
      })
      .catch((e) => setError(e.message))
      .finally(() => setCreating(false));
  }

  function handleUpload() {
    const file = fileInputRef.current?.files?.[0];
    if (!file) return;
    setUploading(true);
    setError("");

    const reader = new FileReader();
    reader.onload = () => {
      const base64 = (reader.result as string).split(",")[1];
      const filePath =
        currentPath === "." ? file.name : `${currentPath}/${file.name}`;
      api(`/api/accounts/${accountId}/files/upload`, {
        method: "POST",
        body: JSON.stringify({ path: filePath, content_base64: base64 }),
      })
        .then(() => {
          setShowUpload(false);
          if (fileInputRef.current) fileInputRef.current.value = "";
          loadDir(currentPath);
        })
        .catch((e) => setError(e.message))
        .finally(() => setUploading(false));
    };
    reader.readAsDataURL(file);
  }

  function handleDelete() {
    if (!deleteTarget) return;
    setError("");
    const filePath =
      currentPath === "."
        ? deleteTarget.name
        : `${currentPath}/${deleteTarget.name}`;
    const recursive = deleteTarget.type === "dir";
    api(
      `/api/accounts/${accountId}/files?path=${encodeURIComponent(filePath)}&recursive=${recursive}`,
      { method: "DELETE" },
    )
      .then(() => {
        setDeleteTarget(null);
        loadDir(currentPath);
      })
      .catch((e) => setError(e.message));
  }

  function formatSize(bytes: number): string {
    if (bytes < 1024) return `${bytes} B`;
    if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} KB`;
    return `${(bytes / (1024 * 1024)).toFixed(1)} MB`;
  }

  function formatDate(epoch: number): string {
    if (!epoch) return "—";
    return new Date(epoch * 1000).toLocaleString();
  }

  const breadcrumbs = currentPath === "."
    ? ["."]
    : ["."].concat(currentPath.split("/"));

  return (
    <div>
      <div className="mb-4">
        <Link to="/" className="text-secondary text-sm">
          {es.files.backToDashboard}
        </Link>
      </div>

      <h1>{es.files.title}</h1>

      {/* Breadcrumbs */}
      <div className="mb-4 text-sm">
        {breadcrumbs.map((seg, i) => {
          const path = i === 0 ? "." : breadcrumbs.slice(1, i + 1).join("/");
          const isLast = i === breadcrumbs.length - 1;
          return (
            <span key={i}>
              {i > 0 && " / "}
              {isLast ? (
                <strong>{seg === "." ? "~" : seg}</strong>
              ) : (
                <button
                  className="btn-link"
                  onClick={() => loadDir(path)}
                >
                  {seg === "." ? "~" : seg}
                </button>
              )}
            </span>
          );
        })}
      </div>

      {/* Actions bar */}
      <div className="flex gap-2 mb-4">
        {currentPath !== "." && (
          <button className="btn btn-ghost btn-sm" onClick={goUp}>
            ← {es.files.goUp}
          </button>
        )}
        <button
          className="btn btn-primary btn-sm"
          onClick={() => setShowMkdir(true)}
        >
          {es.files.newFolder}
        </button>
        <button
          className="btn btn-secondary btn-sm"
          onClick={() => setShowUpload(true)}
        >
          {es.files.upload}
        </button>
        <button
          className="btn btn-ghost btn-sm"
          onClick={() => loadDir(currentPath)}
        >
          {es.files.refresh}
        </button>
      </div>

      {error && <div className="error-message mb-4">{error}</div>}

      {/* Mkdir dialog */}
      {showMkdir && (
        <div className="card mb-4 p-4">
          <form onSubmit={handleMkdir} className="flex gap-2 items-center">
            <input
              className="form-input"
              placeholder={es.files.folderName}
              value={newDirName}
              onChange={(e) => setNewDirName(e.target.value)}
              autoFocus
              required
            />
            <button
              className="btn btn-primary btn-sm"
              type="submit"
              disabled={creating}
            >
              {creating ? es.common.loading : es.common.save}
            </button>
            <button
              className="btn btn-ghost btn-sm"
              type="button"
              onClick={() => {
                setShowMkdir(false);
                setNewDirName("");
              }}
            >
              {es.common.cancel}
            </button>
          </form>
        </div>
      )}

      {/* Upload dialog */}
      {showUpload && (
        <div className="card mb-4 p-4">
          <div className="flex gap-2 items-center">
            <input type="file" ref={fileInputRef} />
            <button
              className="btn btn-primary btn-sm"
              onClick={handleUpload}
              disabled={uploading}
            >
              {uploading ? es.common.loading : es.files.upload}
            </button>
            <button
              className="btn btn-ghost btn-sm"
              onClick={() => setShowUpload(false)}
            >
              {es.common.cancel}
            </button>
          </div>
        </div>
      )}

      {/* Delete confirmation */}
      {deleteTarget && (
        <div className="card mb-4 p-4">
          <p>
            {es.files.confirmDelete.replace("{name}", deleteTarget.name)}
          </p>
          <div className="flex gap-2 mt-2">
            <button className="btn btn-danger btn-sm" onClick={handleDelete}>
              {es.common.delete}
            </button>
            <button
              className="btn btn-ghost btn-sm"
              onClick={() => setDeleteTarget(null)}
            >
              {es.common.cancel}
            </button>
          </div>
        </div>
      )}

      {/* Editor */}
      {editingFile && (
        <div className="card mb-4 p-4">
          <div className="flex items-center justify-between mb-2">
            <strong className="text-mono text-sm">{editingFile}</strong>
            <div className="flex gap-2">
              <button
                className="btn btn-primary btn-sm"
                onClick={handleSave}
                disabled={saving}
              >
                {saving ? es.common.loading : es.common.save}
              </button>
              <button
                className="btn btn-ghost btn-sm"
                onClick={() => setEditingFile(null)}
              >
                {es.common.cancel}
              </button>
            </div>
          </div>
          <textarea
            className="form-input text-mono"
            style={{ width: "100%", minHeight: 400, fontFamily: "monospace" }}
            value={editorContent}
            onChange={(e) => setEditorContent(e.target.value)}
          />
        </div>
      )}

      {/* File listing */}
      {loading ? (
        <div className="loading">{es.common.loading}</div>
      ) : entries.length === 0 ? (
        <div className="empty-state">
          <p>{es.files.empty}</p>
        </div>
      ) : (
        <div className="card">
          <div className="table-container">
            <table>
              <thead>
                <tr>
                  <th>{es.files.name}</th>
                  <th>{es.files.size}</th>
                  <th>{es.files.modified}</th>
                  <th>{es.files.perms}</th>
                  <th></th>
                </tr>
              </thead>
              <tbody>
                {entries
                  .sort((a, b) => {
                    if (a.type === "dir" && b.type !== "dir") return -1;
                    if (a.type !== "dir" && b.type === "dir") return 1;
                    return a.name.localeCompare(b.name);
                  })
                  .map((entry) => (
                    <tr key={entry.name}>
                      <td>
                        <button
                          className="btn-link text-mono"
                          onClick={() => navigate(entry)}
                        >
                          {entry.type === "dir" ? "📁 " : entry.type === "symlink" ? "🔗 " : "📄 "}
                          {entry.name}
                        </button>
                      </td>
                      <td>{entry.type === "dir" ? "—" : formatSize(entry.size)}</td>
                      <td>{formatDate(entry.mod_time)}</td>
                      <td className="text-mono text-sm">{entry.permissions}</td>
                      <td>
                        <button
                          className="btn btn-ghost btn-sm"
                          onClick={() => setDeleteTarget(entry)}
                          title={es.common.delete}
                        >
                          ✕
                        </button>
                      </td>
                    </tr>
                  ))}
              </tbody>
            </table>
          </div>
        </div>
      )}
    </div>
  );
}
