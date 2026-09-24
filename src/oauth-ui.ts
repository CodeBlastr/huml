import { AuthorizationError, CimdFetchError, type AuthRequest, type ClientInfo } from "@cloudflare/workers-oauth-provider";
import { Hono } from "hono";
import { clientIp, lockoutRemaining, recordFailure, rootFingerprint, tooManyAttempts, verifyStaticToken } from "./auth";
import type { AuthProps, Env } from "./env";

/** Non-API routes: landing page and the OAuth consent page for Claude.ai / ChatGPT connectors. */
export const app = new Hono<{ Bindings: Env }>();

app.get("/", (c) =>
  c.text("huml.ai: MCP memory server. Endpoint: https://huml.ai/mcp\nSource: https://github.com/CodeBlastr/huml\n"),
);

app.get("/authorize", async (c) => {
  const oauth = c.env.OAUTH_PROVIDER;
  try {
    const req = await oauth.parseAuthRequest(c.req.raw);
    const client = await oauth.lookupClient(req.clientId);
    if (!client) return page(400, "Unknown client.");
    const consent = await oauth.beginConsent(req);
    consent.headers.set("Content-Type", "text/html; charset=utf-8");
    return new Response(consentPage(client, req, consent.handle), { headers: consent.headers });
  } catch (e) {
    return authError(e);
  }
});

app.post("/authorize", async (c) => {
  const oauth = c.env.OAUTH_PROVIDER;
  const ip = clientIp(c.req.raw);
  const wait = await lockoutRemaining(c.env, ip);
  if (wait > 0) return tooManyAttempts(wait);

  try {
    const form = await c.req.formData();
    const handle = String(form.get("handle") ?? "");
    if (form.get("decision") !== "approve") {
      const denied = await oauth.denyConsent(c.req.raw, handle);
      return new Response(null, { status: 302, headers: denied.headers });
    }

    // Approving requires one of the server's own tokens: AUTH_TOKEN or an issued api_token.
    const token = await verifyStaticToken(c.env, String(form.get("token") ?? "").trim());
    if (!token) {
      await recordFailure(c.env, ip);
      return page(401, "That token is not valid. Go back and try again.");
    }

    const approved = await oauth.approveConsent(c.req.raw, handle);
    const props: AuthProps = { via: "oauth", tokenId: token.tokenId };
    if (token.tokenId === "root") props.rootFp = await rootFingerprint(c.env);
    const { redirectTo } = await oauth.completeAuthorization({
      request: approved.request,
      userId: "owner",
      metadata: { approvedWith: token.label, approvedAt: new Date().toISOString() },
      scope: approved.request.scope,
      props,
    });
    approved.headers.set("Location", redirectTo);
    return new Response(null, { status: 302, headers: approved.headers });
  } catch (e) {
    return authError(e);
  }
});

function authError(e: unknown): Response {
  if (e instanceof AuthorizationError && e.redirectUri) {
    const redirect = new URL(e.redirectUri);
    redirect.searchParams.set("error", e.code);
    redirect.searchParams.set("error_description", e.description);
    if (e.state) redirect.searchParams.set("state", e.state);
    if (e.issuer) redirect.searchParams.set("iss", e.issuer);
    return Response.redirect(redirect.href, 302);
  }
  if (e instanceof AuthorizationError) return page(400, e.description);
  if (e instanceof CimdFetchError) return page(400, "This app could not be verified.");
  throw e;
}

const escape = (v: string) => v.replace(/[&<>"']/g, (ch) => `&#${ch.charCodeAt(0)};`);

const STYLE = `<style>
:root{color-scheme:light dark;--fg:#1a1a1a;--muted:#666;--bg:#fafafa;--card:#fff;--line:#ddd;--accent:#2f5bd3}
@media (prefers-color-scheme:dark){:root{--fg:#eee;--muted:#aaa;--bg:#111;--card:#1b1b1b;--line:#333;--accent:#7c9cff}}
body{margin:0;background:var(--bg);color:var(--fg);font:16px/1.5 system-ui,sans-serif}
main{max-width:30rem;margin:10vh auto;padding:0 16px}
.card{background:var(--card);border:1px solid var(--line);border-radius:10px;padding:24px}
h1{font-size:1.25rem;margin:0 0 12px} p{margin:0 0 12px} .muted{color:var(--muted);font-size:.9rem}
.warn{border-left:3px solid #d97706;padding-left:10px}
input[type=password]{width:100%;box-sizing:border-box;padding:10px;border:1px solid var(--line);border-radius:6px;background:var(--bg);color:var(--fg);font:inherit}
.row{display:flex;gap:8px;margin-top:16px} button{flex:1;padding:10px;border-radius:6px;border:1px solid var(--line);background:var(--card);color:var(--fg);font:inherit;cursor:pointer}
button.primary{background:var(--accent);border-color:var(--accent);color:#fff}
</style>`;

function consentPage(client: ClientInfo, req: AuthRequest, handle: string): string {
  const name = escape(client.clientName ?? client.clientId);
  const host = new URL(req.redirectUri).hostname;
  const local = /^(localhost|127(\.\d{1,3}){3}|\[::1\])$/.test(host);
  const origin = client.clientId.startsWith("https://")
    ? `Published by <strong>${escape(new URL(client.clientId).hostname)}</strong>.`
    : "This app registered itself; its name is not verified.";
  return `<!doctype html><html lang="en"><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1">
<title>Authorize huml</title>${STYLE}<main><div class="card">
<h1>Allow ${name} to read and write your huml memory?</h1>
<p class="muted">${origin} Access will be sent to <strong>${escape(host)}</strong>.</p>
${local ? '<p class="warn">This sends access to an app on your computer. Continue only if you just started connecting from it.</p>' : ""}
<form method="post">
<input type="hidden" name="handle" value="${escape(handle)}">
<p><label for="t">Paste your huml token (AUTH_TOKEN or an issued client token) to approve:</label></p>
<input id="t" type="password" name="token" autocomplete="current-password">
<div class="row"><button name="decision" value="deny">Deny</button><button class="primary" name="decision" value="approve">Allow</button></div>
</form></div></main></html>`;
}

function page(status: number, message: string): Response {
  const html = `<!doctype html><html lang="en"><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>huml</title>${STYLE}<main><div class="card"><p>${escape(message)}</p></div></main></html>`;
  return new Response(html, {
    status,
    headers: { "Content-Type": "text/html; charset=utf-8", "X-Frame-Options": "DENY" },
  });
}
