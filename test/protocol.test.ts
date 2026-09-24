import { env } from "cloudflare:test";
import { describe, expect, it } from "vitest";
import { sha256Hex } from "../src/auth";
import { fetchWorker, rpc, uid, URL_MCP } from "./helpers";

describe("auth", () => {
  it("no token → 401 with OAuth discovery challenge, and it does not count as a failure", async () => {
    const ip = `198.51.100.${Math.floor(Math.random() * 250)}`;
    const r = await rpc("tools/list", {}, { token: null, ip });
    expect(r.status).toBe(401);
    expect(r.headers.get("www-authenticate")).toMatch(/resource_metadata=/);
    const row = await env.DB.prepare("SELECT count FROM auth_failures WHERE ip = ?").bind(ip).first();
    expect(row).toBeNull();
  });

  it("bad token → 401; 10 failures lock the IP out with 429, even for a good token", async () => {
    const ip = `192.0.2.${Math.floor(Math.random() * 250)}`;
    for (let i = 0; i < 10; i++) {
      expect((await rpc("tools/list", {}, { token: `wrong-${i}`, ip })).status).toBe(401);
    }
    const locked = await rpc("tools/list", {}, { token: "wrong-11", ip });
    expect(locked.status).toBe(429);
    expect(Number(locked.headers.get("retry-after"))).toBeGreaterThan(0);
    expect((await rpc("tools/list", {}, { ip })).status).toBe(429);
    // Other IPs are unaffected; unlock clears it.
    expect((await rpc("tools/list", {}, { ip: "192.0.2.254" })).status).toBe(200);
    await env.DB.prepare("DELETE FROM auth_failures WHERE ip = ?").bind(ip).run();
    expect((await rpc("tools/list", {}, { ip })).status).toBe(200);
  });

  it("D1-issued tokens work until revoked", async () => {
    const token = `huml_${uid()}`;
    const id = uid();
    await env.DB.prepare("INSERT INTO api_tokens (id, label, token_hash, created_at) VALUES (?, 'test', ?, ?)")
      .bind(id, await sha256Hex(token), new Date().toISOString())
      .run();
    expect((await rpc("tools/list", {}, { token, ip: "203.0.113.50" })).status).toBe(200);
    await env.DB.prepare("UPDATE api_tokens SET revoked_at = ? WHERE id = ?").bind(new Date().toISOString(), id).run();
    expect((await rpc("tools/list", {}, { token, ip: "203.0.113.50" })).status).toBe(401);
  });

  it("rejects foreign Origin with 403", async () => {
    const r = await rpc("tools/list", {}, { headers: { Origin: "https://evil.example" } });
    expect(r.status).toBe(403);
    expect((await rpc("tools/list", {}, { headers: { Origin: "https://claude.ai" } })).status).toBe(200);
  });
});

describe("transport", () => {
  it("legacy: initialize, notifications/initialized → 202, tools/list", async () => {
    const init = await rpc("initialize", {
      protocolVersion: "2025-06-18",
      capabilities: {},
      clientInfo: { name: "t", version: "0" },
    });
    expect(init.json.result.protocolVersion).toBe("2025-06-18");
    expect(init.headers.get("mcp-session-id")).toBeNull();

    const note = await fetchWorker(URL_MCP, {
      method: "POST",
      headers: { Authorization: "Bearer test-root-token", "Content-Type": "application/json" },
      body: JSON.stringify({ jsonrpc: "2.0", method: "notifications/initialized" }),
    });
    expect(note.status).toBe(202);

    const list = await rpc("tools/list");
    expect(list.json.result.tools.map((t: { name: string }) => t.name).sort()).toEqual([
      "memory_append",
      "memory_delete",
      "memory_list",
      "memory_read",
      "memory_search",
      "memory_str_replace",
      "memory_write",
    ]);
    expect(list.json.result.resultType).toBeUndefined();
    expect(list.json.result.ttlMs).toBeUndefined();
  });

  it("modern: server/discover and tools/list carry resultType", async () => {
    const d = await rpc("server/discover", {}, { modern: true });
    expect(d.json.result).toMatchObject({ resultType: "complete", supportedVersions: expect.arrayContaining(["2026-07-28"]) });
    expect(d.json.result).toMatchObject({ ttlMs: expect.any(Number), cacheScope: "public" });
    const l = await rpc("tools/list", {}, { modern: true });
    expect(l.json.result.tools).toHaveLength(7);
    expect(l.json.result).toMatchObject({ resultType: "complete", ttlMs: expect.any(Number), cacheScope: "public" });
  });

  it("modern: header mismatch → 400 -32020; bad version → 400 -32022; unknown method → 404", async () => {
    const mismatch = await rpc("tools/list", {}, { modern: true, headers: { "Mcp-Method": "tools/call" } });
    expect(mismatch.status).toBe(400);
    expect(mismatch.json.error.code).toBe(-32020);

    const noName = await rpc(
      "tools/call",
      { name: "memory_list", arguments: {} },
      { modern: true, headers: { "Mcp-Name": "memory_read" } },
    );
    expect(noName.json.error.code).toBe(-32020);

    const b64 = await rpc(
      "tools/call",
      { name: "memory_list", arguments: {} },
      { modern: true, headers: { "Mcp-Name": `=?base64?${btoa("memory_list")}?=` } },
    );
    expect(b64.status).toBe(200);

    const ver = await rpc("tools/list", {}, {
      modern: true,
      headers: { "MCP-Protocol-Version": "1900-01-01" },
    });
    expect(ver.json.error.code).toBe(-32020); // header ≠ _meta is checked first

    const unknown = await rpc("nope/nope", {}, { modern: true });
    expect(unknown.status).toBe(404);
    expect(unknown.json.error.code).toBe(-32601);
  });

  it("GET and DELETE → 405", async () => {
    expect((await fetchWorker(URL_MCP, { method: "GET" })).status).toBe(405);
    expect((await fetchWorker(URL_MCP, { method: "DELETE" })).status).toBe(405);
  });

  it("serves OAuth metadata for connector discovery", async () => {
    const pr = await fetchWorker("https://huml.ai/.well-known/oauth-protected-resource/mcp");
    expect(await pr.json()).toMatchObject({ resource: "https://huml.ai/mcp" });
    const as = await fetchWorker("https://huml.ai/.well-known/oauth-authorization-server");
    expect(await as.json()).toMatchObject({ authorization_endpoint: "https://huml.ai/authorize" });
  });
});
