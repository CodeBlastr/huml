import { exports } from "cloudflare:workers";

export const ROOT = "test-root-token";
export const URL_MCP = "https://huml.ai/mcp";

let seq = 0;
/** Unique suffix so tests never collide on paths, names, or search terms. */
export const uid = () => `${Date.now().toString(36)}${(seq++).toString(36)}${Math.random().toString(36).slice(2, 6)}`;

export function fetchWorker(input: string, init?: RequestInit): Promise<Response> {
  return (exports as any).default.fetch(new Request(input, init));
}

export interface RpcOpts {
  token?: string | null;
  ip?: string;
  modern?: boolean;
  headers?: Record<string, string>;
}

/** Send one JSON-RPC request. Modern mode adds _meta and the mirrored headers. */
export async function rpc(method: string, params: Record<string, unknown> = {}, opts: RpcOpts = {}) {
  const token = opts.token === undefined ? ROOT : opts.token;
  const headers: Record<string, string> = {
    "Content-Type": "application/json",
    Accept: "application/json, text/event-stream",
    "CF-Connecting-IP": opts.ip ?? "203.0.113.1",
  };
  if (token) headers.Authorization = `Bearer ${token}`;
  let body: Record<string, unknown> = { jsonrpc: "2.0", id: ++seq, method, params };
  if (opts.modern) {
    headers["MCP-Protocol-Version"] = "2026-07-28";
    headers["Mcp-Method"] = method;
    if (typeof params.name === "string") headers["Mcp-Name"] = params.name;
    body = {
      ...body,
      params: {
        ...params,
        _meta: {
          "io.modelcontextprotocol/protocolVersion": "2026-07-28",
          "io.modelcontextprotocol/clientInfo": { name: "test", version: "0" },
          "io.modelcontextprotocol/clientCapabilities": {},
        },
      },
    };
  } else {
    headers["MCP-Protocol-Version"] = "2025-11-25";
  }
  Object.assign(headers, opts.headers);
  const res = await fetchWorker(URL_MCP, { method: "POST", headers, body: JSON.stringify(body) });
  const text = await res.text();
  return { status: res.status, headers: res.headers, json: text ? JSON.parse(text) : null };
}

/** Call a tool and return its structuredContent plus the isError flag. */
export async function tool(name: string, args: Record<string, unknown>, opts: RpcOpts = {}) {
  const r = await rpc("tools/call", { name, arguments: args }, opts);
  if (r.status !== 200 || r.json.error) throw new Error(`tools/call ${name} failed: ${r.status} ${JSON.stringify(r.json)}`);
  return { isError: !!r.json.result.isError, data: r.json.result.structuredContent as any };
}

export function doc(name: string, body: string, extra = ""): string {
  return `---\nname: ${name}\ndescription: test doc ${name}\n${extra}---\n\n${body}\n`;
}
