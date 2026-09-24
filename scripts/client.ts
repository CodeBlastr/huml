/** Minimal MCP client for scripts. Speaks the 2026-07-28 per-request form. */

const VERSION = "2026-07-28";

export interface McpClient {
  url: string;
  call(method: string, params?: Record<string, unknown>): Promise<{ status: number; body: any }>;
  tool(name: string, args: Record<string, unknown>): Promise<{ isError: boolean; data: any }>;
}

export function client(url: string, token: string | null): McpClient {
  let id = 0;
  async function call(method: string, params: Record<string, unknown> = {}) {
    const headers: Record<string, string> = {
      "Content-Type": "application/json",
      Accept: "application/json, text/event-stream",
      "MCP-Protocol-Version": VERSION,
      "Mcp-Method": method,
    };
    if (token) headers.Authorization = `Bearer ${token}`;
    if (typeof params.name === "string") headers["Mcp-Name"] = params.name;
    const body = {
      jsonrpc: "2.0",
      id: ++id,
      method,
      params: {
        ...params,
        _meta: {
          "io.modelcontextprotocol/protocolVersion": VERSION,
          "io.modelcontextprotocol/clientInfo": { name: "huml-scripts", version: "0.1.0" },
          "io.modelcontextprotocol/clientCapabilities": {},
        },
      },
    };
    const res = await fetch(url, { method: "POST", headers, body: JSON.stringify(body) });
    const text = await res.text();
    let parsed: unknown = text;
    try {
      parsed = text ? JSON.parse(text) : null;
    } catch {}
    return { status: res.status, body: parsed as any };
  }
  return {
    url,
    call,
    async tool(name, args) {
      const r = await call("tools/call", { name, arguments: args });
      if (r.status !== 200 || r.body?.error) {
        throw new Error(`${name}: HTTP ${r.status} ${JSON.stringify(r.body)}`);
      }
      return { isError: !!r.body.result.isError, data: r.body.result.structuredContent };
    },
  };
}

export function requireEnv(name: string): string {
  const v = process.env[name];
  if (!v) {
    console.error(`${name} is not set. Put it in .env (gitignored) or export it.`);
    process.exit(2);
  }
  return v;
}
