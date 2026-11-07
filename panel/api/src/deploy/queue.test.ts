import { describe, it, expect, vi } from "vitest";
import { DeployQueue, type DeployRequest } from "./queue.js";

function makeReq(siteId: number, sha = "abc"): DeployRequest {
  return { siteId, commitSha: sha, trigger: "webhook" };
}

describe("DeployQueue", () => {
  it("executes immediately when no deploy running", async () => {
    const q = new DeployQueue();
    const executor = vi.fn().mockResolvedValue(undefined);
    const req = makeReq(1);

    q.enqueue(1, req, executor);
    await vi.waitFor(() => expect(executor).toHaveBeenCalledWith(req));
  });

  it("queues pending and replaces with latest", async () => {
    const q = new DeployQueue();
    let resolveFirst!: () => void;
    const firstPromise = new Promise<void>((r) => { resolveFirst = r; });
    const executor = vi.fn()
      .mockImplementationOnce(() => firstPromise)
      .mockResolvedValue(undefined);

    q.enqueue(1, makeReq(1, "first"), executor);

    q.enqueue(1, makeReq(1, "second"), executor);
    q.enqueue(1, makeReq(1, "third"), executor);

    expect(executor).toHaveBeenCalledTimes(1);

    resolveFirst();
    await vi.waitFor(() => expect(executor).toHaveBeenCalledTimes(2));
    expect(executor).toHaveBeenLastCalledWith(makeReq(1, "third"));
  });

  it("runs deploys for different sites concurrently", async () => {
    const q = new DeployQueue();
    const calls: number[] = [];
    const executor = vi.fn().mockImplementation(async (req: DeployRequest) => {
      calls.push(req.siteId);
    });

    q.enqueue(1, makeReq(1), executor);
    q.enqueue(2, makeReq(2), executor);

    await vi.waitFor(() => expect(calls).toContain(1));
    await vi.waitFor(() => expect(calls).toContain(2));
  });

  it("error in deploy does not block the queue", async () => {
    const q = new DeployQueue();
    const executor = vi.fn()
      .mockRejectedValueOnce(new Error("build failed"))
      .mockResolvedValue(undefined);

    q.enqueue(1, makeReq(1, "fail"), executor);

    await vi.waitFor(() => expect(q.isRunning(1)).toBe(false));

    q.enqueue(1, makeReq(1, "ok"), executor);
    await vi.waitFor(() => expect(executor).toHaveBeenCalledTimes(2));
    expect(executor).toHaveBeenLastCalledWith(makeReq(1, "ok"));
  });

  it("pending is started after current finishes", async () => {
    const q = new DeployQueue();
    let resolveFirst!: () => void;
    const firstPromise = new Promise<void>((r) => { resolveFirst = r; });
    const executor = vi.fn()
      .mockImplementationOnce(() => firstPromise)
      .mockResolvedValue(undefined);

    q.enqueue(1, makeReq(1, "a"), executor);
    q.enqueue(1, makeReq(1, "b"), executor);

    expect(q.isRunning(1)).toBe(true);
    resolveFirst();

    await vi.waitFor(() => expect(executor).toHaveBeenCalledTimes(2));
    await vi.waitFor(() => expect(q.isRunning(1)).toBe(false));
  });
});
