/**
 * Admin commands against the huml D1 database, via `wrangler d1 execute`.
 * Runs against production (--remote) unless --local is given.
 *
 *   npm run tokens -- issue <label>     create a client token; plaintext is printed once
 *   npm run tokens -- list              list tokens (never shows secrets)
 *   npm run tokens -- revoke <id>       revoke a token (also kills OAuth grants it approved)
 *   npm run tokens -- unlock            show IPs with failed-auth counts
 *   npm run tokens -- unlock <ip>       clear the lockout for one IP
 *   npm run tokens -- unlock --all      clear all lockouts
 *   npm run tokens -- rebuild           rebuild the FTS index from docs, then compare row counts
 */
import { execFileSync } from "node:child_process";
import { createHash, randomBytes } from "node:crypto";

const argv = process.argv.slice(2);
const local = argv.includes("--local");
const all = argv.includes("--all");
const [cmd, arg] = argv.filter((a) => !a.startsWith("--"));

function sql(command: string): any[] {
  const out = execFileSync(
    "npx",
    ["wrangler", "d1", "execute", "huml", local ? "--local" : "--remote", "--json", "--command", command],
    { encoding: "utf8", stdio: ["ignore", "pipe", "inherit"] },
  );
  const parsed = JSON.parse(out) as { results: any[] }[];
  return parsed.flatMap((r) => r.results ?? []);
}

// wrangler --command can't bind parameters, so every interpolated value is validated first.
function check(value: string | undefined, re: RegExp, what: string): string {
  if (!value || !re.test(value)) {
    console.error(`invalid ${what}: ${value ?? "(missing)"}`);
    process.exit(2);
  }
  return value;
}

const now = new Date().toISOString();

switch (cmd) {
  case "issue": {
    const label = check(arg, /^[A-Za-z0-9 _.-]{1,64}$/, "label (1-64 chars: letters, digits, space, _ . -)");
    const id = randomBytes(4).toString("hex");
    const token = `huml_${randomBytes(32).toString("base64url")}`;
    const hash = createHash("sha256").update(token).digest("hex");
    sql(`INSERT INTO api_tokens (id, label, token_hash, created_at) VALUES ('${id}', '${label}', '${hash}', '${now}')`);
    console.log(`Issued token ${id} (${label}). Shown once; store it in the client's config:\n\n${token}\n`);
    break;
  }
  case "list":
    console.table(sql("SELECT id, label, created_at, last_used_at, revoked_at FROM api_tokens ORDER BY created_at"));
    break;
  case "revoke": {
    const id = check(arg, /^[0-9a-f]{8}$/, "token id");
    sql(`UPDATE api_tokens SET revoked_at = '${now}' WHERE id = '${id}' AND revoked_at IS NULL`);
    console.table(sql(`SELECT id, label, revoked_at FROM api_tokens WHERE id = '${id}'`));
    break;
  }
  case "unlock": {
    if (all) {
      sql("DELETE FROM auth_failures");
      console.log("Cleared all failed-auth counters.");
    } else if (arg) {
      const ip = check(arg, /^[0-9A-Fa-f:.]{2,45}$|^unknown$/, "IP address");
      sql(`DELETE FROM auth_failures WHERE ip = '${ip}'`);
      console.log(`Cleared failed-auth counter for ${ip}.`);
    } else {
      const rows = sql(
        "SELECT ip, count, datetime(window_start, 'unixepoch') AS window_start_utc FROM auth_failures ORDER BY count DESC",
      );
      if (rows.length === 0) console.log("No failed-auth counters.");
      else console.table(rows);
      console.log("Locked out at count >= 10 within 15 minutes. Clear with: npm run tokens -- unlock <ip>");
    }
    break;
  }
  case "rebuild": {
    sql("INSERT INTO docs_fts(docs_fts) VALUES('rebuild')");
    sql("INSERT INTO docs_fts(docs_fts) VALUES('integrity-check')"); // throws if the index disagrees with docs
    const [counts] = sql(
      "SELECT (SELECT count(*) FROM docs) AS docs, (SELECT count(*) FROM docs_fts_docsize) AS fts_rows",
    );
    console.table([counts]);
    if (counts.docs !== counts.fts_rows) {
      console.error("Row counts differ after rebuild. Investigate before trusting search.");
      process.exit(1);
    }
    console.log("FTS index rebuilt and consistent.");
    break;
  }
  default:
    console.error("usage: npm run tokens -- <issue <label> | list | revoke <id> | unlock [ip|--all] | rebuild> [--local]");
    process.exit(2);
}
