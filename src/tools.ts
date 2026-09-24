import type { Env } from "./env";
import { validatePath, ValidationError } from "./frontmatter";
import { makeRetriever } from "./retrieval";
import { Store, type WriteResult } from "./store";

export interface ToolResult {
  content: { type: "text"; text: string }[];
  structuredContent: Record<string, unknown>;
  isError?: boolean;
}

const IF_VERSION = {
  description:
    'Version from your last memory_read or write of this path. Use the string "new" (memory_write only) to create a file that does not exist yet. The write is rejected if the file changed since.',
  anyOf: [{ type: "integer", minimum: 1 }, { type: "string" }],
};
const PATH = {
  type: "string",
  description: 'Absolute doc path, e.g. "/areas/razorit.md". Allowed: A-Z a-z 0-9 - _ / . ; must end in .md',
};

const FORMAT =
  'Files are markdown with required YAML frontmatter:\n---\nname: unique-name\ndescription: one line, what this covers and when to read it\naliases: [Other Name]\n---\n\n- content lines\nMax 100KB per file.';

export const TOOLS = [
  {
    name: "memory_list",
    description:
      "List memory docs (path, name, description, aliases, updated_at), without content. Optionally filter by path prefix, e.g. \"/areas/\".",
    inputSchema: {
      type: "object",
      properties: { path_prefix: { type: "string", description: 'Only paths starting with this, e.g. "/areas/"' } },
    },
    annotations: { title: "List memory", readOnlyHint: true, openWorldHint: false },
  },
  {
    name: "memory_read",
    description:
      "Read one or more memory docs. Returns full content and the version you must pass as if_version on your next write to that path.",
    inputSchema: {
      type: "object",
      properties: {
        path: {
          description: "A single path, or an array of paths (max 50)",
          anyOf: [PATH, { type: "array", items: PATH, maxItems: 50 }],
        },
      },
      required: ["path"],
    },
    annotations: { title: "Read memory", readOnlyHint: true, openWorldHint: false },
  },
  {
    name: "memory_write",
    description: `Create a doc or fully replace its content. Other sessions write concurrently: pass if_version from your last read. On a version conflict nothing is written and you get the current content and version back; merge your change into it and retry. ${FORMAT}`,
    inputSchema: {
      type: "object",
      properties: { path: PATH, content: { type: "string" }, if_version: IF_VERSION },
      required: ["path", "content", "if_version"],
    },
    annotations: { title: "Write memory", readOnlyHint: false, destructiveHint: true, idempotentHint: false, openWorldHint: false },
  },
  {
    name: "memory_append",
    description:
      "Append text to an existing doc, starting on a new line. Requires if_version; on conflict nothing is written and the current content and version are returned.",
    inputSchema: {
      type: "object",
      properties: { path: PATH, content: { type: "string" }, if_version: IF_VERSION },
      required: ["path", "content", "if_version"],
    },
    annotations: { title: "Append to memory", readOnlyHint: false, destructiveHint: false, idempotentHint: false, openWorldHint: false },
  },
  {
    name: "memory_str_replace",
    description:
      "Replace exactly one occurrence of old_str with new_str in a doc. Rejected (nothing changed) if old_str matches zero or multiple times. Requires if_version.",
    inputSchema: {
      type: "object",
      properties: {
        path: PATH,
        old_str: { type: "string", description: "Exact text to find; must occur exactly once" },
        new_str: { type: "string" },
        if_version: IF_VERSION,
      },
      required: ["path", "old_str", "new_str", "if_version"],
    },
    annotations: { title: "Edit memory", readOnlyHint: false, destructiveHint: true, idempotentHint: false, openWorldHint: false },
  },
  {
    name: "memory_delete",
    description: "Delete a doc. Requires if_version; rejected if the doc changed since you read it.",
    inputSchema: {
      type: "object",
      properties: { path: PATH, if_version: IF_VERSION },
      required: ["path", "if_version"],
    },
    annotations: { title: "Delete memory", readOnlyHint: false, destructiveHint: true, idempotentHint: false, openWorldHint: false },
  },
  {
    name: "memory_search",
    description:
      "Search memory docs by keywords across name, description and body. Returns path, name and a snippet; use memory_read for full content.",
    inputSchema: {
      type: "object",
      properties: {
        query: { type: "string" },
        limit: { type: "integer", minimum: 1, maximum: 50, description: "Default 10" },
      },
      required: ["query"],
    },
    annotations: { title: "Search memory", readOnlyHint: true, openWorldHint: false },
  },
] as const;

export async function callTool(env: Env, name: string, args: Record<string, unknown>): Promise<ToolResult> {
  const store = new Store(env.DB);
  try {
    switch (name) {
      case "memory_list": {
        const prefix = args.path_prefix;
        if (prefix != null && typeof prefix !== "string") throw new ValidationError("path_prefix must be a string");
        return ok({ docs: await store.list(prefix || undefined) });
      }
      case "memory_read": {
        const p = args.path;
        if (Array.isArray(p)) {
          if (p.length > 50) throw new ValidationError("at most 50 paths per memory_read");
          const docs = await Promise.all(
            p.map(async (path) => {
              validatePath(path);
              return (await store.read(path)) ?? { path, error: "not_found" };
            }),
          );
          return ok({ docs });
        }
        const doc = await store.read(validatePath(p));
        if (!doc) return err({ error: "not_found", message: `${p} does not exist` });
        return ok({ ...doc });
      }
      case "memory_write":
        return fromWrite(await store.write(str(args, "path"), str(args, "content"), args.if_version));
      case "memory_append":
        return fromWrite(await store.append(str(args, "path"), str(args, "content"), args.if_version));
      case "memory_str_replace":
        return fromWrite(
          await store.strReplace(str(args, "path"), str(args, "old_str"), str(args, "new_str"), args.if_version),
        );
      case "memory_delete":
        return fromWrite(await store.delete(str(args, "path"), args.if_version));
      case "memory_search": {
        const query = str(args, "query");
        const raw = args.limit ?? 10;
        const limit = typeof raw === "number" && Number.isInteger(raw) ? Math.min(Math.max(raw, 1), 50) : 10;
        const hits = await makeRetriever(env).search(query, limit);
        return ok({ results: hits.map(({ path, name, snippet }) => ({ path, name, snippet })) });
      }
      default:
        return err({ error: "unknown_tool", message: `unknown tool ${name}` });
    }
  } catch (e) {
    if (e instanceof ValidationError) return err({ error: "invalid", message: e.message });
    throw e;
  }
}

function str(args: Record<string, unknown>, key: string): string {
  const v = args[key];
  if (typeof v !== "string") throw new ValidationError(`${key} must be a string`);
  return v;
}

function fromWrite(r: WriteResult): ToolResult {
  if (r.ok) return ok(r.deleted ? { path: r.path, deleted: true } : { path: r.path, version: r.version });
  const { ok: _, ...rest } = r;
  return err(rest);
}

function ok(data: Record<string, unknown>): ToolResult {
  return { content: [{ type: "text", text: JSON.stringify(data, null, 2) }], structuredContent: data };
}

function err(data: Record<string, unknown>): ToolResult {
  return { content: [{ type: "text", text: JSON.stringify(data, null, 2) }], structuredContent: data, isError: true };
}
