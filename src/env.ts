import type { OAuthHelpers } from "@cloudflare/workers-oauth-provider";

export interface Env {
  DB: D1Database;
  OAUTH_KV: KVNamespace;
  /** Root bearer token. Secret: `.dev.vars` locally, `wrangler secret put` in prod. */
  AUTH_TOKEN: string;
  PUBLIC_URL: string;
  ALLOWED_ORIGINS: string;
  /** Injected by OAuthProvider into every handler. */
  OAUTH_PROVIDER: OAuthHelpers;
  /** Optional: bind both to switch memory_search to semantic retrieval. */
  VECTORIZE?: VectorizeIndex;
  AI?: Ai;
}

/** What an authenticated request carries in ctx.props. */
export interface AuthProps {
  /** "bearer" = static token in the header; "oauth" = token issued via /authorize. */
  via: "bearer" | "oauth";
  /** "root" for AUTH_TOKEN, otherwise an api_tokens.id. */
  tokenId: string;
  /** For OAuth grants approved with AUTH_TOKEN: fingerprint of that token, so rotating it kills the grant. */
  rootFp?: string;
}
