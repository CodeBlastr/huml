# huml

Open source AI executive assistant that manages context from a centralized location across all your connected AI services and agents.

This repo is the **huml.ai MCP memory server**: a remote MCP server on Cloudflare Workers that stores markdown files in D1. Any MCP client (Claude Code, Claude.ai, Cursor, ChatGPT) can list, read, write, edit and search them. Many sessions can write at once without overwriting each other, because every write must pass the version it read (`if_version`).

- Endpoint: `https://huml.ai/mcp`, Streamable HTTP. It supports MCP 2026-07-28 (stateless) and the older 2025-11-25, 2025-06-18 and 2025-03-26 `initialize`-based clients.
- Auth: a static bearer token (Claude Code, Cursor), or OAuth 2.1 (Claude.ai, ChatGPT). The OAuth consent page asks you for a huml token.

## Tools

| Tool | Arguments | Returns |
|---|---|---|
| `memory_list` | `path_prefix?` | `path, name, description, aliases, updated_at` (no content) |
| `memory_read` | `path` (string or array) | `content, version` |
| `memory_write` | `path, content, if_version` | new `version` (`if_version: "new"` creates) |
| `memory_append` | `path, content, if_version` | new `version` |
| `memory_str_replace` | `path, old_str, new_str, if_version` | new `version`; rejected on 0 or >1 matches |
| `memory_delete` | `path, if_version` | `deleted: true` |
| `memory_search` | `query, limit?` | `path, name, snippet` |

If `if_version` doesn't match the stored version, nothing is modified. The tool returns `version_conflict` with the current `content` and `version`, so the client can merge its change and retry.

Rules:
- Paths start with `/`, use only `A-Z a-z 0-9 - _ / .`, and end in `.md`.
- Each file is capped at 100KB.
- Every file needs frontmatter with a `name`, and names are unique:

```markdown
---
name: razorit
description: one line, what this covers and when to read it
aliases: [RazorIT LLC]
---

- content lines
```

## Connecting clients

Give each client its own token, so you can revoke one without touching the others:

```sh
npm run tokens -- issue claude-code      # prints the token once
```

### Claude Code

```sh
claude mcp add --transport http --scope user huml https://huml.ai/mcp \
  --header "Authorization: Bearer <token>"
```

### Cursor

Add this to `~/.cursor/mcp.json`, or to `.cursor/mcp.json` in a project:

```json
{
  "mcpServers": {
    "huml": {
      "url": "https://huml.ai/mcp",
      "headers": { "Authorization": "Bearer <token>" }
    }
  }
}
```

### Claude.ai

1. Go to Settings → Connectors → **Add custom connector**.
2. Name it `huml` and set the URL to `https://huml.ai/mcp`. Leave the OAuth client ID and secret empty; the connector registers itself.
3. Click **Connect**. On the huml.ai consent page, paste a token (e.g. from `npm run tokens -- issue claude-ai`) and click **Allow**.

### ChatGPT

1. Go to Settings → Apps & Connectors → Advanced settings and turn on **Developer mode**.
2. Under Apps & Connectors, click **Create**. Set the name to `huml`, the MCP server URL to `https://huml.ai/mcp`, and Authentication to **OAuth**.
3. Approve on the huml.ai consent page with a token (e.g. from `npm run tokens -- issue chatgpt`).

An OAuth connection is tied to the token that approved it. Revoking that token (or rotating `AUTH_TOKEN`, if that's what you used) disconnects the client.

## Admin

All admin commands run against production. Add `--local` to target the `wrangler dev` database instead.

```sh
npm run tokens -- issue <label>     # new client token (shown once)
npm run tokens -- list
npm run tokens -- revoke <id>
npm run tokens -- unlock            # show IPs with failed-auth counts
npm run tokens -- unlock <ip>       # clear a lockout (10 failures / 15 min → 429)
npm run tokens -- unlock --all
npm run tokens -- rebuild           # rebuild the FTS index if search looks wrong
```

Import a local folder of markdown. `./notes/areas/x.md` becomes `/areas/x.md`; use `--prefix` to import under a different path:

```sh
npm run seed -- ./notes [--prefix /imported]
```

Run the end-to-end acceptance check against production. It creates and deletes one doc under `/_smoke/`, trips the lockout on purpose, then clears it:

```sh
npm run smoke
```

## Setup and deploy

Credentials live in three separate places. The repo is public, so none of them are ever committed:

| What | Where |
|---|---|
| Wrangler CLI auth (`CLOUDFLARE_API_TOKEN`, `CLOUDFLARE_ACCOUNT_ID`) and script token (`HUML_TOKEN`) | `.env` (gitignored; see `.env.example`) |
| Local dev `AUTH_TOKEN` | `.dev.vars` (gitignored; see `.dev.vars.example`) |
| Production `AUTH_TOKEN` | `wrangler secret put AUTH_TOKEN`, only |

The Cloudflare API token needs: Workers Scripts:Edit, D1:Edit, Workers Routes:Edit, Workers KV Storage:Edit.

```sh
npm install
npm test                  # vitest against a local D1
npm run dev               # http://127.0.0.1:8787/mcp
npm run migrate:remote
npm run deploy
```

To rotate the production root token, run:

```sh
openssl rand -hex 32 | npx wrangler secret put AUTH_TOKEN
```

## Layout

```
src/index.ts          entry: OAuth provider, Origin check, failed-auth lockout
src/mcp.ts            JSON-RPC / MCP protocol handling (both protocol eras)
src/tools.ts          tool schemas and handlers
src/store.ts          D1 storage with compare-and-swap writes
src/frontmatter.ts    path, size and frontmatter validation
src/auth.ts           token checks and rate limiting
src/oauth-ui.ts       /authorize consent page
src/retrieval/        Retriever interface, LexicalRetriever (FTS5), VectorRetriever stub
migrations/           D1 schema
scripts/              seed, tokens (admin), smoke (acceptance test)
```

Search can move to Cloudflare Vectorize without changing the tool contract:
1. Implement `src/retrieval/vector.ts`.
2. Uncomment the `[[vectorize]]` and `[ai]` bindings in `wrangler.toml`.

`makeRetriever()` picks `VectorRetriever` automatically once both bindings exist.

## License

MIT
