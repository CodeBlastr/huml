# How huml was built

huml was written by [Claude Code](https://claude.com/claude-code) (Claude Opus 5.5) from the prompt below, in one session on 2026-09-24. The prompt is reproduced verbatim, including details specific to the original deployment (the huml.ai domain, the author's company name in the examples), so you can see exactly what was asked for and compare it with the code.

## The build prompt

````markdown
# Build: huml.ai MCP memory server

Build a remote MCP server on Cloudflare Workers that stores markdown files and
exposes CRUD plus search to any MCP client (Claude Code, Claude.ai, Cursor,
ChatGPT). Deploy to huml.ai, which is registered in the same Cloudflare
account you'll deploy to.

TypeScript and Wrangler. No framework beyond Hono if you need routing.
Deploying from my laptop, so no CI.

Public repo: github.com/CodeBlastr/huml

## FIRST COMMIT, BEFORE ANYTHING ELSE

Create `.gitignore` containing at minimum:

```
.env
.dev.vars
node_modules/
.wrangler/
*.log
```

Commit that before creating any file that could hold a credential. This repo
is public.

## Credentials, three separate things

**1. Wrangler CLI auth** — `.env` in the project root, gitignored:
```
CLOUDFLARE_API_TOKEN=...
CLOUDFLARE_ACCOUNT_ID=...
```
The API token needs these scopes: Workers Scripts:Edit, D1:Edit, Workers
Routes:Edit. Tell me if the token I provide lacks any of them.

**2. Local dev runtime** — `.dev.vars`, gitignored:
```
AUTH_TOKEN=...
```

**3. Production runtime** — `wrangler secret put AUTH_TOKEN`. Never in a
file, never in wrangler.toml.

Also create `.env.example` and `.dev.vars.example` with the key names and
empty values. Those DO get committed.

## Transport

Streamable HTTP MCP at `https://huml.ai/mcp`. Check the current MCP remote
server spec before implementing rather than assuming from memory.

## Auth

Bearer token in the Authorization header, compared against AUTH_TOKEN. Store
additional tokens in a D1 table so I can issue and revoke per client without
rotating everything. Any request without a valid token returns 401.

Add rate limiting on failed auth attempts. This endpoint is public and the
repo is open, so the token is the only thing protecting the data.

## Storage

Cloudflare D1:

```sql
CREATE TABLE docs (
  path        TEXT PRIMARY KEY,   -- /areas/razorit.md
  name        TEXT NOT NULL,      -- frontmatter name, unique
  description TEXT,
  aliases     TEXT,               -- JSON array
  content     TEXT NOT NULL,      -- full markdown incl. frontmatter
  version     INTEGER NOT NULL,
  updated_at  TEXT NOT NULL
);

CREATE VIRTUAL TABLE docs_fts USING fts5(
  path UNINDEXED, name, description, content,
  content=docs, content_rowid=rowid
);
```

Keep docs_fts in sync with triggers.

## Concurrency, do not skip this

Every write takes `if_version`. If the stored version doesn't match, reject
the write, return the current content and version, and modify nothing.

I run 11+ AI sessions in parallel and they will clobber each other otherwise.

Accept the literal string `new` as if_version to create a file that doesn't
exist yet.

## Retrieval must be swappable

```ts
interface Retriever {
  search(query: string, limit: number): Promise<SearchHit[]>;
}
```

Ship `LexicalRetriever` backed by FTS5. Structure it so a `VectorRetriever`
backed by Cloudflare Vectorize drops in later by changing one binding, with
zero change to the MCP tool contract. Leave a stub file with the interface and
a TODO.

## MCP tools

- `memory_list(path_prefix?)` — path, name, description, aliases, updated_at.
  No content.
- `memory_read(path)` — single path or array. Returns content and version.
- `memory_write(path, content, if_version)` — full replace or create.
- `memory_append(path, content, if_version)` — appends on a new line.
- `memory_str_replace(path, old_str, new_str, if_version)` — exact single
  match required; reject on zero or multiple and say which.
- `memory_delete(path, if_version)`
- `memory_search(query, limit?)` — path, name, snippet.

Every write returns the new version token.

## File format

```
---
name: razorit
description: one line, what this covers and when to read it
aliases: [RazorIT LLC]
---

- content lines
```

Parse frontmatter on write and populate name, description, aliases. Reject
writes with no frontmatter or missing name.

## Constraints

- 100KB cap per file. Reject oversized writes with the limit in the error.
- Path must start with `/`, allow alphanumeric plus `-_/.`, end in `.md`.
- `name` unique across all docs. Reject duplicates.

## Deliverables

1. Worker source
2. wrangler.toml with D1 binding, huml.ai custom domain route, and a
   commented-out Vectorize binding
3. Migration SQL
4. README with the exact `claude mcp add` command for this endpoint plus
   config snippets for Claude.ai, Cursor, and ChatGPT
5. A seed script that imports a local directory of .md files
6. `.gitignore`, `.env.example`, `.dev.vars.example`

## Test before telling me it works

- Two concurrent writes to the same path with the same if_version: one wins,
  one is rejected with current content returned
- Create, read, append, str_replace, delete round trip
- Search finds a doc by a word that appears only in its body
- Unauthenticated request returns 401
- `git status` shows no credential files staged or tracked

Report what you deployed and the production token.
````

## Follow-up

This came after reviewing the first version. It added the `unlock` and `rebuild` admin commands and the search check in the smoke test:

````text
Add an unlock command to scripts/tokens.ts that clears auth_failures for an IP. You'll lock yourself out configuring four clients from one address, and the smoke test trips it deliberately.
Add a rebuild command that runs INSERT INTO docs_fts(docs_fts) VALUES('rebuild'). FTS5 external-content triggers drift silently when wrong, and search returns wrong results with no error.
Extend the smoke test: after a write, immediately search for a word unique to that doc's body. Proves the triggers fire.
````

Later changes (the security review and credential hardening, MCP caching hints, and the README rewrite) were smaller follow-up prompts. They're visible in the commit history.
