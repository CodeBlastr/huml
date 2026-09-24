/**
 * Streamable HTTP MCP endpoint, dual-era (see spec 2026-07-28, basic/versioning):
 *  - Modern (2026-07-28): stateless; every request carries
 *    `_meta["io.modelcontextprotocol/protocolVersion"]` mirrored in headers.
 *  - Legacy (2025-03-26 .. 2025-11-25): `initialize` handshake. We never mint an
 *    Mcp-Session-Id (optional in those revisions), so both eras are stateless here.
 * Responses are always a single application/json object; nothing needs streaming.
 */
import type { Env } from "./env";
import { callTool, TOOLS } from "./tools";

const MODERN = ["2026-07-28"];
const LEGACY = ["2025-11-25", "2025-06-18", "2025-03-26"];
const SUPPORTED = [...MODERN, ...LEGACY];
const META_VERSION = "io.modelcontextprotocol/protocolVersion";

const SERVER_INFO = { name: "huml", version: "0.1.0" };
// Caching hints required on server/discover and tools/list in 2026-07-28
// (server/utilities/caching). The tool list is static and holds no user data.
const CACHE_HINTS = { ttlMs: 60 * 60 * 1000, cacheScope: "public" };
const INSTRUCTIONS =
  "huml is a shared markdown memory used by many AI sessions at once. Use memory_search or memory_list to find docs, " +
  "memory_read to get content plus its version, and pass that version as if_version on every write. If a write returns " +
  "version_conflict, another session changed the doc: merge your change into the returned current content and retry.";

// JSON-RPC / MCP error codes
const PARSE_ERROR = -32700;
const INVALID_REQUEST = -32600;
const METHOD_NOT_FOUND = -32601;
const INVALID_PARAMS = -32602;
const HEADER_MISMATCH = -32020;
const UNSUPPORTED_VERSION = -32022;

type Id = string | number | null;
interface RpcRequest {
  jsonrpc: "2.0";
  id?: Id;
  method?: string;
  params?: Record<string, unknown> & { _meta?: Record<string, unknown> };
}

export async function handleMcp(request: Request, env: Env): Promise<Response> {
  let msg: RpcRequest;
  try {
    msg = await request.json();
  } catch {
    return rpcError(400, null, PARSE_ERROR, "Parse error: body must be a single JSON-RPC message");
  }
  if (!msg || typeof msg !== "object" || Array.isArray(msg) || msg.jsonrpc !== "2.0") {
    return rpcError(400, null, INVALID_REQUEST, "Invalid Request: expected a single JSON-RPC 2.0 object (batches are not supported)");
  }
  // Client-sent responses (legacy) and notifications: accept, nothing to return.
  if (typeof msg.method !== "string" || msg.id === undefined) return new Response(null, { status: 202 });

  const id = msg.id;
  const method = msg.method;
  const params = msg.params ?? {};
  const headerVersion = request.headers.get("mcp-protocol-version");
  const metaVersion = params._meta?.[META_VERSION];
  const modern = typeof metaVersion === "string";

  if (modern) {
    const mismatch = checkModernHeaders(request, metaVersion, method, params);
    if (mismatch) return rpcError(400, id, HEADER_MISMATCH, `Header mismatch: ${mismatch}`);
    if (!MODERN.includes(metaVersion)) {
      return rpcError(400, id, UNSUPPORTED_VERSION, "Unsupported protocol version", {
        supported: SUPPORTED,
        requested: metaVersion,
      });
    }
  } else if (method !== "initialize" && headerVersion && !LEGACY.includes(headerVersion)) {
    return rpcError(400, id, UNSUPPORTED_VERSION, `Unsupported protocol version ${headerVersion}`, {
      supported: SUPPORTED,
      requested: headerVersion,
    });
  }

  const result = (data: Record<string, unknown>) => rpcResult(id, modern ? { resultType: "complete", ...data } : data);
  const cacheable = (data: Record<string, unknown>) => result(modern ? { ...data, ...CACHE_HINTS } : data);

  switch (method) {
    case "initialize": {
      const requested = typeof params.protocolVersion === "string" ? params.protocolVersion : "";
      return result({
        protocolVersion: LEGACY.includes(requested) ? requested : LEGACY[0],
        capabilities: { tools: { listChanged: false } },
        serverInfo: SERVER_INFO,
        instructions: INSTRUCTIONS,
      });
    }
    case "server/discover":
      return cacheable({
        supportedVersions: SUPPORTED,
        capabilities: { tools: { listChanged: false } },
        _meta: { "io.modelcontextprotocol/serverInfo": SERVER_INFO },
        instructions: INSTRUCTIONS,
      });
    case "ping":
      return result({});
    case "tools/list":
      return cacheable({ tools: TOOLS });
    case "tools/call": {
      const name = params.name;
      const args = params.arguments ?? {};
      if (typeof name !== "string" || typeof args !== "object" || Array.isArray(args)) {
        return rpcError(200, id, INVALID_PARAMS, "tools/call needs params.name (string) and params.arguments (object)");
      }
      if (!TOOLS.some((t) => t.name === name)) return rpcError(200, id, INVALID_PARAMS, `Unknown tool: ${name}`);
      const out = await callTool(env, name, args as Record<string, unknown>);
      return result(out as unknown as Record<string, unknown>);
    }
    default:
      // Modern: unknown method is HTTP 404 + -32601. Legacy: plain JSON-RPC error.
      return rpcError(modern ? 404 : 200, id, METHOD_NOT_FOUND, `Method not found: ${method}`);
  }
}

/** Header/body agreement required by 2026-07-28 (Request Metadata → Server Validation). */
function checkModernHeaders(
  request: Request,
  metaVersion: string,
  method: string,
  params: Record<string, unknown>,
): string | null {
  const h = request.headers;
  const version = h.get("mcp-protocol-version");
  if (version === null) return "missing MCP-Protocol-Version header";
  if (version !== metaVersion) return `MCP-Protocol-Version '${version}' does not match _meta protocolVersion '${metaVersion}'`;
  const m = h.get("mcp-method");
  if (m === null) return "missing Mcp-Method header";
  if (m !== method) return `Mcp-Method '${m}' does not match body method '${method}'`;
  if (method === "tools/call" || method === "resources/read" || method === "prompts/get") {
    const raw = h.get("mcp-name");
    if (raw === null) return "missing Mcp-Name header";
    const decoded = decodeSentinel(raw);
    if (decoded === null) return "Mcp-Name header has an invalid base64 value";
    const body = method === "resources/read" ? params.uri : params.name;
    if (decoded !== body) return `Mcp-Name '${decoded}' does not match body value '${String(body)}'`;
  }
  return null;
}

function decodeSentinel(v: string): string | null {
  const m = /^=\?base64\?(.*)\?=$/.exec(v);
  if (!m) return v;
  try {
    return new TextDecoder("utf-8", { fatal: true, ignoreBOM: false }).decode(Uint8Array.from(atob(m[1]), (c) => c.charCodeAt(0)));
  } catch {
    return null;
  }
}

function rpcResult(id: Id, result: unknown): Response {
  return Response.json({ jsonrpc: "2.0", id, result });
}

function rpcError(status: number, id: Id | undefined, code: number, message: string, data?: unknown): Response {
  const error = data === undefined ? { code, message } : { code, message, data };
  return Response.json({ jsonrpc: "2.0", id: id ?? null, error }, { status });
}
