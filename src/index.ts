import { OAuthProvider } from "@cloudflare/workers-oauth-provider";
import {
  clientIp,
  grantStillValid,
  lockoutRemaining,
  purgeOldFailures,
  recordFailure,
  tooManyAttempts,
  verifyStaticToken,
} from "./auth";
import type { AuthProps, Env } from "./env";
import { handleMcp } from "./mcp";
import { app } from "./oauth-ui";

/**
 * OAuthProvider serves /token, /register and the /.well-known metadata, and guards
 * /mcp. A bearer token it didn't issue goes to resolveExternalToken, which accepts
 * AUTH_TOKEN and api_tokens, so Claude Code and Cursor can use a static header.
 */
function makeProvider(origin: string) {
  const resource = `${origin}/mcp`;
  return new OAuthProvider<Env>({
    apiRoute: "/mcp",
    apiHandler: {
      async fetch(request, env, ctx) {
        const props = (ctx as ExecutionContext<AuthProps>).props;
        if (!props || !(await grantStillValid(env, props))) {
          return new Response(JSON.stringify({ error: "invalid_token", error_description: "grant revoked" }), {
            status: 401,
            headers: {
              "Content-Type": "application/json",
              "WWW-Authenticate": `Bearer error="invalid_token", resource_metadata="${new URL(request.url).origin}/.well-known/oauth-protected-resource/mcp"`,
            },
          });
        }
        return handleMcp(request, env);
      },
    },
    defaultHandler: { fetch: (request, env, ctx) => app.fetch(request, env, ctx) },
    authorizeEndpoint: "/authorize",
    tokenEndpoint: "/token",
    clientRegistrationEndpoint: "/register",
    clientIdMetadataDocumentEnabled: true,
    scopesSupported: ["memory"],
    accessTokenTTL: 60 * 60,
    resourceMetadata: {
      resource,
      authorization_servers: [origin],
      scopes_supported: ["memory"],
      resource_name: "huml memory",
    },
    async resolveExternalToken({ token, env }) {
      const t = await verifyStaticToken(env, token);
      if (!t) return null;
      const props: AuthProps = { via: "bearer", tokenId: t.tokenId };
      return { props, audience: resource };
    },
  });
}

// The provider checks resource/issuer URLs against the request origin. In production
// that is always https://huml.ai (custom domain only, workers.dev disabled). Locally,
// `npm run dev` keeps requests on http://127.0.0.1:8787 via --local-upstream.
const providers = new Map<string, OAuthProvider<Env>>();
function providerFor(env: Env, url: URL): OAuthProvider<Env> {
  const loopback = url.hostname === "localhost" || url.hostname === "127.0.0.1";
  const origin = loopback ? url.origin : new URL(env.PUBLIC_URL).origin;
  let p = providers.get(origin);
  if (!p) providers.set(origin, (p = makeProvider(origin)));
  return p;
}

export default {
  async fetch(request: Request, env: Env, ctx: ExecutionContext): Promise<Response> {
    const url = new URL(request.url);
    const isMcp = url.pathname === "/mcp" || url.pathname.startsWith("/mcp/");

    if (isMcp) {
      const origin = request.headers.get("origin");
      if (origin && !allowedOrigin(env, origin)) {
        return Response.json({ jsonrpc: "2.0", error: { code: -32600, message: "Forbidden origin" } }, { status: 403 });
      }
      // 2026-07-28: no GET stream, no sessions. Legacy clients treat 405 as "no SSE stream".
      if (request.method !== "POST") {
        return new Response(null, { status: 405, headers: { Allow: "POST" } });
      }
    }

    // Brute-force guard on everything that checks a secret.
    const guarded = isMcp || (url.pathname === "/authorize" && request.method === "POST");
    const ip = clientIp(request);
    if (guarded) {
      const wait = await lockoutRemaining(env, ip);
      if (wait > 0) return tooManyAttempts(wait);
    }

    const response = await providerFor(env, url).fetch(request, env, ctx);

    // A 401 on /mcp *with* credentials is a failed guess. A bare 401 is just OAuth discovery.
    if (isMcp && response.status === 401 && request.headers.has("authorization")) {
      await recordFailure(env, ip);
    }
    return response;
  },

  async scheduled(_controller: ScheduledController, env: Env, ctx: ExecutionContext): Promise<void> {
    ctx.waitUntil(Promise.all([providerFor(env, new URL(env.PUBLIC_URL)).purgeExpiredData(env), purgeOldFailures(env)]));
  },
} satisfies ExportedHandler<Env>;

function allowedOrigin(env: Env, origin: string): boolean {
  let o: URL;
  try {
    o = new URL(origin);
  } catch {
    return false;
  }
  return env.ALLOWED_ORIGINS.split(",").some((allowed) => {
    const a = new URL(allowed.trim());
    // http://localhost in the list allows any port on localhost.
    if (a.hostname === "localhost" || a.hostname === "127.0.0.1") {
      return o.protocol === a.protocol && o.hostname === a.hostname;
    }
    return o.origin === a.origin;
  });
}
