# huml

A simple, open source framework for connecting an AI executive assistant to all your tools. It keeps your context in one place, so every AI service and agent you connect works from the same memory.

In practice, huml is a small [MCP](https://modelcontextprotocol.io) server that stores plain markdown files. Claude, ChatGPT, Cursor, Claude Code, or any other MCP client can list, read, write, edit and search those files. You tell Claude Code about a client, a project decision, or how you like your emails written, and ChatGPT already knows it the next time you open it. Your context is no longer stuck inside one vendor's memory feature.

It's about 1,100 lines of TypeScript with three runtime dependencies. You deploy it to your own Cloudflare account, and the whole thing runs on the free plan for personal use.

## Why it's this simple

Most AI memory projects are pipelines: they extract "facts" with an LLM, embed them into a vector database, build knowledge graphs, and decide for you what's worth remembering. huml doesn't do any of that. The models you already pay for are good at reading and writing text, so huml gives them a shared folder of markdown files and stays out of the way.

That buys you a few things:

- **You can read and edit your memory yourself.** It's markdown files with paths like `/people/jane.md` and `/projects/launch.md`. There are no opaque embeddings or extracted triples. You can export it, grep it, or seed it from a notes folder you already have.
- **It has no opinions about how you organize things.** The only rule is that each file has a unique `name` in its frontmatter. Folders, file layout and writing style are up to you (or your agents). huml has no built-in schema for "people", "tasks" or "preferences".
- **The server never calls an LLM.** No API keys, no inference cost, no surprise bills, and nothing leaves your deployment except to the clients you connect. All the reasoning happens in the AI client you're already using.
- **It works with any MCP client.** No SDK, no plugin per vendor. If a tool speaks MCP over HTTP, it can connect.
- **Many agents can use it at once without clobbering each other.** Every write must include the version it read. If another session changed the file in the meantime, the write is rejected with the current content, and the agent merges its change and retries. There are no locks or sessions.
- **It's small enough to audit.** You're handing this server your personal and work context, and you can read all of it in an afternoon.

## FAQ

**Is this only for Claude?**
No. It's a standard MCP server. The setup instructions below cover Claude Code, Claude.ai, ChatGPT and Cursor, and anything else that supports remote MCP servers with a bearer token or OAuth should work too.

**Do I need Cloudflare?**
For this implementation, yes. It runs on Cloudflare Workers, stores files in D1 (Cloudflare's SQLite), and keeps OAuth state in Workers KV. A free Cloudflare account is enough; you don't need a paid plan or a domain on Cloudflare (a `*.workers.dev` URL works). Nothing about the design depends on Cloudflare, though: the tool contract is plain MCP, and storage is SQLite with FTS5 full-text search. Porting it to Node, Bun or Deno with local SQLite would mean replacing `src/store.ts` and the OAuth provider in `src/index.ts`. That port doesn't exist yet, and contributions are welcome.

**Is huml.ai a hosted service I can sign up for?**
No. `huml.ai` is the author's own deployment, and each deployment belongs to one person. You deploy your own copy (see [Self-hosting](#self-hosting)) and point your clients at your URL. The examples below use `https://huml.example.com` as a stand-in.

**Where does my data live?**
In a D1 database in your Cloudflare account. Only you hold the tokens. Client tokens are stored as SHA-256 hashes, and repeated failed logins from an IP get locked out.

**Can it be shared by several people?**
Not yet. There's one memory per deployment, and every token has full read/write access to it. A team can share a deployment if everyone should see everything.

**How is this different from ChatGPT or Claude's built-in memory?**
Built-in memory only works inside one product, and you can't choose what it keeps or how it's organized. huml is shared across every tool you connect, and it's just files you can see and edit.

**How does search work without embeddings?**
SQLite FTS5 with Porter stemming, ranked by BM25, over each file's name, description and content. With a few hundred to a few thousand well-named files, that plus `memory_list` is plenty for an agent to find what it needs. If you want semantic search, the retriever is behind an interface, and a Cloudflare Vectorize backend is stubbed out (see [Layout](#layout)). The tools stay the same either way.

**How do my agents know to use it?**
The server sends MCP instructions telling clients how to search, read and write safely. Whether a client checks memory on its own depends on the client, so it helps to add a line to your system prompt, `CLAUDE.md`, or custom instructions, e.g. *"Check huml memory for context about people, projects and my preferences before answering, and save anything worth remembering."*

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
name: acme-corp
description: one line, what this covers and when to read it
aliases: [Acme, Acme Corporation]
---

- content lines
```

Protocol details: the endpoint is `/mcp` over Streamable HTTP. It supports MCP 2026-07-28 (stateless) and the older 2025-11-25, 2025-06-18 and 2025-03-26 `initialize`-based clients. Auth is either a static bearer token (Claude Code, Cursor) or OAuth 2.1 (Claude.ai, ChatGPT), where the consent page asks you for a huml token.

## Self-hosting

You need Node 22+ and a Cloudflare account (the free plan is fine).

1. Clone and install:

   ```sh
   git clone https://github.com/CodeBlastr/huml && cd huml
   npm install
   ```

2. Copy `.env.example` to `.env` and fill in `CLOUDFLARE_API_TOKEN` and `CLOUDFLARE_ACCOUNT_ID`. The API token needs Workers Scripts:Edit, D1:Edit, Workers Routes:Edit and Workers KV Storage:Edit. (Running `npx wrangler login` also works for the `npx wrangler` commands below.)

3. Create your own database and KV namespace, then replace the `database_id` and the KV `id` in `wrangler.toml` with the IDs these commands print:

   ```sh
   npx wrangler d1 create huml
   npx wrangler kv namespace create OAUTH_KV
   ```

4. Point `wrangler.toml` at your URL:
   - **Custom domain** (the domain must be a zone in your Cloudflare account): change the `routes` pattern, `PUBLIC_URL`, and the first entry in `ALLOWED_ORIGINS` to your domain.
   - **No domain**: set `workers_dev = true`, delete the `routes` block, and set `PUBLIC_URL` (and the first `ALLOWED_ORIGINS` entry) to `https://huml.<your-subdomain>.workers.dev`.

5. Create the tables, deploy, and set a root token:

   ```sh
   npm run migrate:remote
   npm run deploy
   openssl rand -hex 32 | npx wrangler secret put AUTH_TOKEN
   ```

6. Set `HUML_URL` in `.env` to `https://<your-host>/mcp`, then issue a token for each client (see below). If you already keep notes in markdown, you can import them with `npm run seed`.

## Connecting clients

Give each client its own token, so you can revoke one without touching the others:

```sh
npm run tokens -- issue claude-code      # prints the token once
```

### Claude Code

```sh
claude mcp add --transport http --scope user huml https://huml.example.com/mcp \
  --header "Authorization: Bearer <token>"
```

### Cursor

Add this to `~/.cursor/mcp.json`, or to `.cursor/mcp.json` in a project:

```json
{
  "mcpServers": {
    "huml": {
      "url": "https://huml.example.com/mcp",
      "headers": { "Authorization": "Bearer <token>" }
    }
  }
}
```

### Claude.ai

1. Go to Settings → Connectors → **Add custom connector**.
2. Name it `huml` and set the URL to `https://huml.example.com/mcp`. Leave the OAuth client ID and secret empty; the connector registers itself.
3. Click **Connect**. On your huml consent page, paste a token (e.g. from `npm run tokens -- issue claude-ai`) and click **Allow**.

### ChatGPT

1. Go to Settings → Apps & Connectors → Advanced settings and turn on **Developer mode**.
2. Under Apps & Connectors, click **Create**. Set the name to `huml`, the MCP server URL to `https://huml.example.com/mcp`, and Authentication to **OAuth**.
3. Approve on your huml consent page with a token (e.g. from `npm run tokens -- issue chatgpt`).

An OAuth connection is tied to the token that approved it. Revoking that token (or rotating `AUTH_TOKEN`, if that's what you used) disconnects the client.

## Admin

All admin commands run against your deployed database. Add `--local` to target the `wrangler dev` database instead.

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

Run the end-to-end acceptance check against `HUML_URL`. It creates and deletes one doc under `/_smoke/`, trips the lockout on purpose, then clears it:

```sh
npm run smoke
```

To rotate the root token:

```sh
openssl rand -hex 32 | npx wrangler secret put AUTH_TOKEN
```

## Development

```sh
npm test                  # vitest against a local D1
npm run dev               # http://127.0.0.1:8787/mcp
```

Credentials live in three separate places, and none of them are ever committed:

| What | Where |
|---|---|
| Wrangler CLI auth (`CLOUDFLARE_API_TOKEN`, `CLOUDFLARE_ACCOUNT_ID`) and script token (`HUML_TOKEN`) | `.env` (gitignored; see `.env.example`) |
| Local dev `AUTH_TOKEN` | `.dev.vars` (gitignored; see `.dev.vars.example`) |
| Production `AUTH_TOKEN` | `wrangler secret put AUTH_TOKEN`, only |

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

## How it was built

huml was written with Claude Code from a single detailed prompt, plus a few short follow-ups. The full prompt is in [PROMPT.md](PROMPT.md), verbatim, so you can compare what was asked for with what was built.

## License

MIT
