export interface DeployRequest {
  siteId: number;
  commitSha: string;
  commitMessage?: string;
  trigger: "webhook" | "manual";
}

export type DeployExecutor = (req: DeployRequest) => Promise<void>;

export class DeployQueue {
  private running = new Map<number, Promise<void>>();
  private pending = new Map<number, { req: DeployRequest; executor: DeployExecutor }>();

  enqueue(siteId: number, req: DeployRequest, executor: DeployExecutor): void {
    if (this.running.has(siteId)) {
      this.pending.set(siteId, { req, executor });
      return;
    }
    this.startDeploy(siteId, req, executor);
  }

  isRunning(siteId: number): boolean {
    return this.running.has(siteId);
  }

  private startDeploy(
    siteId: number,
    req: DeployRequest,
    executor: DeployExecutor,
  ): void {
    const promise = executor(req)
      .catch(() => {})
      .finally(() => {
        this.running.delete(siteId);
        const next = this.pending.get(siteId);
        if (next) {
          this.pending.delete(siteId);
          this.startDeploy(siteId, next.req, next.executor);
        }
      });
    this.running.set(siteId, promise);
  }
}
