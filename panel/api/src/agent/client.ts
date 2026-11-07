import http from "node:http";

export interface AgentResponse<T = unknown> {
  ok: boolean;
  result?: T;
  error?: { code: string; message: string };
}

export class AgentClient {
  constructor(private socketPath: string) {}

  async callAction<T = unknown>(
    name: string,
    params?: Record<string, unknown>,
  ): Promise<AgentResponse<T>> {
    const body = params ? JSON.stringify(params) : "{}";

    return new Promise((resolve, reject) => {
      const req = http.request(
        {
          socketPath: this.socketPath,
          path: `/v1/actions/${encodeURIComponent(name)}`,
          method: "POST",
          headers: {
            "Content-Type": "application/json",
            "Content-Length": Buffer.byteLength(body),
          },
        },
        (res) => {
          let data = "";
          res.on("data", (chunk: Buffer) => {
            data += chunk.toString();
          });
          res.on("end", () => {
            try {
              resolve(JSON.parse(data) as AgentResponse<T>);
            } catch {
              reject(new Error(`Invalid JSON from agent: ${data}`));
            }
          });
        },
      );

      req.on("error", reject);
      req.write(body);
      req.end();
    });
  }
}
