/**
 * Import a local directory of .md files into huml through the MCP endpoint.
 *
 *   npm run seed -- ./my-notes            # ./my-notes/areas/x.md → /areas/x.md
 *   npm run seed -- ./my-notes --prefix /imported
 *
 * Env: HUML_URL (default https://huml.ai/mcp), HUML_TOKEN.
 * Existing docs are overwritten only if their content differs, using their current version.
 */
import { readdir, readFile } from "node:fs/promises";
import { join, relative, sep } from "node:path";
import { client, requireEnv } from "./client.ts";

const args = process.argv.slice(2);
const dir = args.find((a) => !a.startsWith("--"));
const prefixIdx = args.indexOf("--prefix");
const prefix = prefixIdx >= 0 ? args[prefixIdx + 1].replace(/\/+$/, "") : "";
if (!dir) {
  console.error("usage: npm run seed -- <dir> [--prefix /some/prefix]");
  process.exit(2);
}

const mcp = client(process.env.HUML_URL ?? "https://huml.ai/mcp", requireEnv("HUML_TOKEN"));

async function* walk(d: string): AsyncGenerator<string> {
  for (const e of await readdir(d, { withFileTypes: true })) {
    if (e.name.startsWith(".") || e.name === "node_modules") continue;
    const p = join(d, e.name);
    if (e.isDirectory()) yield* walk(p);
    else if (e.isFile() && e.name.endsWith(".md")) yield p;
  }
}

const counts = { created: 0, updated: 0, unchanged: 0, failed: 0 };
for await (const file of walk(dir)) {
  const path = `${prefix}/${relative(dir, file).split(sep).join("/")}`;
  const content = await readFile(file, "utf8");
  try {
    const cur = await mcp.tool("memory_read", { path });
    if (!cur.isError && cur.data.content === content) {
      counts.unchanged++;
      continue;
    }
    const ifVersion = cur.isError ? "new" : cur.data.version;
    const r = await mcp.tool("memory_write", { path, content, if_version: ifVersion });
    if (r.isError) {
      counts.failed++;
      console.error(`✗ ${path}: ${r.data.message}`);
    } else {
      counts[ifVersion === "new" ? "created" : "updated"]++;
      console.log(`✓ ${path} (v${r.data.version})`);
    }
  } catch (e) {
    counts.failed++;
    console.error(`✗ ${path}: ${(e as Error).message}`);
  }
}
console.log(counts);
process.exit(counts.failed ? 1 : 0);
