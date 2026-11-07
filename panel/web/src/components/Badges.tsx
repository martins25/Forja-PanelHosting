import { es } from "../i18n/es";

export function ModeBadge({ mode }: { mode: string }) {
  const cls =
    mode === "online"
      ? "badge-success"
      : mode === "maintenance"
        ? "badge-warning"
        : "badge-danger";
  const label =
    mode === "online"
      ? es.common.online
      : mode === "maintenance"
        ? es.common.maintenance
        : es.common.disabled;
  return <span className={`badge ${cls}`}>{label}</span>;
}

export function DeployBadge({ status }: { status: string }) {
  const cls =
    status === "succeeded"
      ? "badge-success"
      : status === "failed"
        ? "badge-danger"
        : status === "running"
          ? "badge-info"
          : "badge-neutral";
  const label =
    status === "succeeded"
      ? es.common.succeeded
      : status === "failed"
        ? es.common.failed
        : status === "running"
          ? es.common.running
          : es.common.queued;
  return <span className={`badge ${cls}`}>{label}</span>;
}

export function RemovalStatusBadge({ status }: { status: string }) {
  const cls =
    status === "done"
      ? "badge-success"
      : status === "rejected"
        ? "badge-danger"
        : "badge-warning";
  const label =
    status === "done"
      ? es.removal.statusDone
      : status === "rejected"
        ? es.removal.statusRejected
        : es.removal.statusOpen;
  return <span className={`badge ${cls}`}>{label}</span>;
}

export function AlertStatusBadge({ status }: { status: string }) {
  const cls =
    status === "sent"
      ? "badge-success"
      : status === "failed"
        ? "badge-danger"
        : "badge-info";
  const label =
    status === "sent"
      ? es.alerts.statusSent
      : status === "failed"
        ? es.alerts.statusFailed
        : es.alerts.statusQueued;
  return <span className={`badge ${cls}`}>{label}</span>;
}
