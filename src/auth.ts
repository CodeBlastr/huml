import type { AuthProps, Env } from "./env";

export const MAX_FAILURES = 10;
export const WINDOW_SECONDS = 15 * 60;

const enc = new TextEncoder();

export async function sha256Hex(s: string): Promise<string> {
  const d = await crypto.subtle.digest("SHA-256", enc.encode(s));
  return [...new Uint8Array(d)].map((b) => b.toString(16).padStart(2, "0")).join("");
}

/** Constant-time equality on SHA-256 digests, so length and content don't leak timing. */
async function safeEqual(a: string, b: string): Promise<boolean> {
  const [da, db] = await Promise.all([
    crypto.subtle.digest("SHA-256", enc.encode(a)),
    crypto.subtle.digest("SHA-256", enc.encode(b)),
  ]);
  return crypto.subtle.timingSafeEqual(da, db);
}

export interface VerifiedToken {
  tokenId: string;
  label: string;
}

/** Check a presented secret against AUTH_TOKEN and the api_tokens table. */
export async function verifyStaticToken(env: Env, token: string): Promise<VerifiedToken | null> {
  if (!token || token.length > 512) return null;
  if (env.AUTH_TOKEN && (await safeEqual(token, env.AUTH_TOKEN))) return { tokenId: "root", label: "root" };

  const hash = await sha256Hex(token);
  const row = await env.DB.prepare("SELECT id, label FROM api_tokens WHERE token_hash = ? AND revoked_at IS NULL")
    .bind(hash)
    .first<{ id: string; label: string }>();
  if (!row) return null;
  const now = new Date();
  const stale = new Date(now.getTime() - 5 * 60 * 1000).toISOString();
  await env.DB.prepare(
    "UPDATE api_tokens SET last_used_at = ? WHERE id = ? AND (last_used_at IS NULL OR last_used_at < ?)",
  )
    .bind(now.toISOString(), row.id, stale)
    .run();
  return { tokenId: row.id, label: row.label };
}

/** Fingerprint of AUTH_TOKEN stored in OAuth grants; rotating AUTH_TOKEN invalidates those grants. */
export async function rootFingerprint(env: Env): Promise<string> {
  return (await sha256Hex(`huml-root:${env.AUTH_TOKEN}`)).slice(0, 16);
}

/** OAuth grants remember which token approved them; they die with that token. */
export async function grantStillValid(env: Env, props: AuthProps): Promise<boolean> {
  if (props.via !== "oauth") return true;
  if (props.tokenId === "root") return props.rootFp === (await rootFingerprint(env));
  const row = await env.DB.prepare("SELECT 1 AS ok FROM api_tokens WHERE id = ? AND revoked_at IS NULL")
    .bind(props.tokenId)
    .first();
  return !!row;
}

// --- Failed-auth rate limiting (per client IP, fixed 15-minute window) ------

export function clientIp(request: Request): string {
  return request.headers.get("cf-connecting-ip") ?? "unknown";
}

/** Seconds until the IP may try again, or 0 if it is not locked out. */
export async function lockoutRemaining(env: Env, ip: string): Promise<number> {
  const now = Math.floor(Date.now() / 1000);
  const row = await env.DB.prepare("SELECT window_start, count FROM auth_failures WHERE ip = ?")
    .bind(ip)
    .first<{ window_start: number; count: number }>();
  if (!row || row.count < MAX_FAILURES) return 0;
  const remaining = row.window_start + WINDOW_SECONDS - now;
  return remaining > 0 ? remaining : 0;
}

export async function recordFailure(env: Env, ip: string): Promise<void> {
  const now = Math.floor(Date.now() / 1000);
  await env.DB.prepare(
    `INSERT INTO auth_failures (ip, window_start, count) VALUES (?1, ?2, 1)
     ON CONFLICT(ip) DO UPDATE SET
       count        = CASE WHEN window_start <= ?2 - ?3 THEN 1  ELSE count + 1 END,
       window_start = CASE WHEN window_start <= ?2 - ?3 THEN ?2 ELSE window_start END`,
  )
    .bind(ip, now, WINDOW_SECONDS)
    .run();
}

export function tooManyAttempts(retryAfter: number): Response {
  return Response.json(
    { error: "too_many_failed_auth_attempts", message: `Too many failed authentication attempts. Retry in ${retryAfter}s.` },
    { status: 429, headers: { "Retry-After": String(retryAfter) } },
  );
}

export async function purgeOldFailures(env: Env): Promise<void> {
  const cutoff = Math.floor(Date.now() / 1000) - WINDOW_SECONDS;
  await env.DB.prepare("DELETE FROM auth_failures WHERE window_start <= ?").bind(cutoff).run();
}
