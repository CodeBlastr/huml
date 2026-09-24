/**
 * End-to-end acceptance test against a running huml server.
 *
 *   npm run smoke                                  # https://huml.ai/mcp
 *   HUML_URL=http://localhost:8787/mcp npm run smoke -- --local
 *
 * Env: HUML_TOKEN (a valid token), HUML_URL.
 * Creates and deletes docs under /_smoke/. Deliberately trips the failed-auth lockout
 * at the end, then clears it for this machine's IP via `tokens.ts unlock`.
 */
import { execFileSync } from "node:child_process";
import { randomBytes } from "node:crypto";
import { client, requireEnv } from "./client.ts";

const local = process.argv.includes("--local");
const url = process.env.HUML_URL ?? "https://huml.ai/mcp";
const token = requireEnv("HUML_TOKEN");
const origin = new URL(url).origin;
const mcp = client(url, token);

let failures = 0;
function check(label: string, cond: boolean, detail?: unknown) {
  console.log(`${cond ? "✓" : "✗"} ${label}`);
  if (!cond) {
    failures++;
    if (detail !== undefined) console.log("   ", JSON.stringify(detail, null, 2).split("\n").join("\n    "));
  }
}

const run = randomBytes(4).toString("hex");
const marker = (w: string) => `zq${w}${run}`; // unique per run so stale data can't match
const doc = (body: string) => `---\nname: smoke-${run}\ndescription: smoke test ${run}\n---\n\n${body}\n`;
const path = `/_smoke/${run}.md`;

async function searchPaths(q: string): Promise<string[]> {
  const r = await mcp.tool("memory_search", { query: q });
  return r.data.results.map((h: { path: string }) => h.path);
}
const TRIGGER_HINT = "FTS triggers may be broken. Run: npm run tokens -- rebuild";

function unlock() {
  const args = ["tsx", "scripts/tokens.ts", "unlock"];
  if (local) args.push("--all", "--local");
  else args.push(myIp);
  execFileSync("npx", args, { stdio: "inherit" });
}

let myIp = "";
if (!local) {
  const trace = await (await fetch(`${origin}/cdn-cgi/trace`)).text();
  myIp = /^ip=(.+)$/m.exec(trace)?.[1] ?? "";
  if (!myIp) throw new Error("could not determine this machine's IP from /cdn-cgi/trace");
  console.log(`Client IP as seen by Cloudflare: ${myIp}`);
}
unlock(); // start from a clean counter

// --- Transport ---------------------------------------------------------------
{
  const r = await fetch(url, {
    method: "POST",
    headers: {
      Authorization: `Bearer ${token}`,
      "Content-Type": "application/json",
      Accept: "application/json, text/event-stream",
    },
    body: JSON.stringify({
      jsonrpc: "2.0",
      id: 1,
      method: "initialize",
      params: { protocolVersion: "2025-06-18", capabilities: {}, clientInfo: { name: "smoke", version: "0" } },
    }),
  });
  const body: any = await r.json();
  check("legacy initialize negotiates 2025-06-18", body?.result?.protocolVersion === "2025-06-18", body);

  const d = await mcp.call("server/discover");
  check("modern server/discover lists 2026-07-28", d.body?.result?.supportedVersions?.includes("2026-07-28"), d.body);

  const l = await mcp.call("tools/list");
  check("tools/list returns 7 tools", l.body?.result?.tools?.length === 7, l.body);

  const g = await fetch(url);
  check("GET /mcp → 405", g.status === 405, g.status);
}

// --- Unauthenticated ---------------------------------------------------------
{
  const r = await client(url, null).call("tools/list");
  check("no token → 401", r.status === 401, r);
}

// --- OAuth discovery ---------------------------------------------------------
{
  const pr = await fetch(`${origin}/.well-known/oauth-protected-resource/mcp`);
  const prj: any = await pr.json().catch(() => null);
  check("protected-resource metadata", pr.status === 200 && prj?.resource === `${origin}/mcp`, prj);
  const as = await fetch(`${origin}/.well-known/oauth-authorization-server`);
  const asj: any = await as.json().catch(() => null);
  check("authorization-server metadata", as.status === 200 && !!asj?.registration_endpoint, asj);
  const reg = await fetch(`${origin}/register`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({
      client_name: `huml smoke ${run}`,
      redirect_uris: ["https://example.com/callback"],
      token_endpoint_auth_method: "none",
    }),
  });
  const regj: any = await reg.json().catch(() => null);
  check("dynamic client registration", reg.status === 201 && !!regj?.client_id, regj);
}

// --- Round trip with FTS trigger checks --------------------------------------
{
  const [A, B, C] = [marker("a"), marker("b"), marker("c")];

  let r = await mcp.tool("memory_write", { path, content: doc(`- created with ${A}`), if_version: "new" });
  check("create → version 1", !r.isError && r.data.version === 1, r);
  check("insert trigger: body-only word is searchable right after create", (await searchPaths(A)).includes(path), TRIGGER_HINT);

  r = await mcp.tool("memory_read", { path });
  check("read returns content + version 1", r.data.version === 1 && r.data.content.includes(A), r);

  r = await mcp.tool("memory_append", { path, content: `- appended ${B}`, if_version: 1 });
  check("append → version 2", !r.isError && r.data.version === 2, r);
  check("update trigger: appended word is searchable", (await searchPaths(B)).includes(path), TRIGGER_HINT);

  r = await mcp.tool("memory_str_replace", { path, old_str: A, new_str: C, if_version: 2 });
  check("str_replace → version 3", !r.isError && r.data.version === 3, r);
  check("update trigger: replaced word is gone", !(await searchPaths(A)).includes(path), TRIGGER_HINT);
  check("update trigger: new word is searchable", (await searchPaths(C)).includes(path), TRIGGER_HINT);

  // --- Concurrency ---
  const [x, y] = await Promise.all([
    mcp.tool("memory_write", { path, content: doc(`- writer X ${C}`), if_version: 3 }),
    mcp.tool("memory_write", { path, content: doc(`- writer Y ${C}`), if_version: 3 }),
  ]);
  const loser = x.isError ? x : y;
  check("concurrent writes, same if_version: exactly one wins", x.isError !== y.isError, { x, y });
  check(
    "loser gets version_conflict with current content and version",
    loser.data?.error === "version_conflict" && loser.data?.current?.version === 4 && !!loser.data?.current?.content,
    loser,
  );
  const cur = await mcp.tool("memory_read", { path });
  check("stored doc is the winner's write", cur.data.version === 4 && cur.data.content === loser.data?.current?.content, cur);

  r = await mcp.tool("memory_delete", { path, if_version: 4 });
  check("delete", !r.isError && r.data.deleted === true, r);
  check("delete trigger: word no longer searchable", !(await searchPaths(C)).includes(path), TRIGGER_HINT);
  r = await mcp.tool("memory_read", { path });
  check("read after delete → not_found", r.isError && r.data.error === "not_found", r);
}

// --- Failed-auth lockout (last: it locks this IP out) --------------------------
{
  const bad = client(url, `wrong-${run}`);
  const statuses: number[] = [];
  for (let i = 0; i < 11; i++) statuses.push((await bad.call("tools/list")).status);
  check("bad token → 401 ×10, then 429", statuses.slice(0, 10).every((s) => s === 401) && statuses[10] === 429, statuses);
  unlock();
  const after = await mcp.call("tools/list");
  check("unlock restores access", after.status === 200, after.status);
}

console.log(failures ? `\n${failures} check(s) FAILED` : "\nAll checks passed.");
process.exit(failures ? 1 : 0);
