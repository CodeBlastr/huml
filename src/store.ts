import { parseFrontmatter, validatePath, validateSize, ValidationError } from "./frontmatter";

export interface DocMeta {
  path: string;
  name: string;
  description: string | null;
  aliases: string[];
  updated_at: string;
}

export interface DocVersion {
  path: string;
  content: string;
  version: number;
}

/**
 * Result of a write. On conflict nothing was modified; `current` is the stored
 * doc (or null if it doesn't exist) so the caller can re-apply its change.
 */
export type WriteResult =
  | { ok: true; path: string; version: number; deleted?: boolean }
  | { ok: false; error: "version_conflict"; message: string; current: DocVersion | null }
  | { ok: false; error: "invalid"; message: string };

type Expected = "new" | number;

interface Row {
  path: string;
  name: string;
  description: string | null;
  aliases: string | null;
  content: string;
  version: number;
  updated_at: string;
}

export class Store {
  constructor(private db: D1Database) {}

  async list(prefix?: string): Promise<DocMeta[]> {
    const stmt = prefix
      ? this.db
          .prepare(
            "SELECT path, name, description, aliases, updated_at FROM docs WHERE substr(path, 1, length(?1)) = ?1 ORDER BY path",
          )
          .bind(prefix)
      : this.db.prepare("SELECT path, name, description, aliases, updated_at FROM docs ORDER BY path");
    const { results } = await stmt.all<Omit<Row, "content" | "version">>();
    return results.map((r) => ({ ...r, aliases: r.aliases ? JSON.parse(r.aliases) : [] }));
  }

  async read(path: string): Promise<DocVersion | null> {
    return this.db
      .prepare("SELECT path, content, version FROM docs WHERE path = ?")
      .bind(path)
      .first<DocVersion>();
  }

  /** Full replace, or create when ifVersion is "new". */
  async write(path: string, content: string, ifVersion: unknown): Promise<WriteResult> {
    return this.guard(async () => {
      validatePath(path);
      const expected = parseIfVersion(ifVersion);
      if (expected === "new") return this.create(path, content);
      return this.update(path, content, expected);
    });
  }

  async append(path: string, content: string, ifVersion: unknown): Promise<WriteResult> {
    return this.guard(async () => {
      validatePath(path);
      const expected = requireExisting(ifVersion, "memory_append");
      const cur = await this.read(path);
      if (!cur || cur.version !== expected) return conflict(path, expected, cur);
      const sep = cur.content.endsWith("\n") ? "" : "\n";
      return this.update(path, cur.content + sep + content, expected);
    });
  }

  async strReplace(path: string, oldStr: string, newStr: string, ifVersion: unknown): Promise<WriteResult> {
    return this.guard(async () => {
      validatePath(path);
      const expected = requireExisting(ifVersion, "memory_str_replace");
      if (!oldStr) throw new ValidationError("old_str must be a non-empty string");
      const cur = await this.read(path);
      if (!cur || cur.version !== expected) return conflict(path, expected, cur);
      const n = countOccurrences(cur.content, oldStr);
      if (n === 0) throw new ValidationError(`old_str not found in ${path}; nothing was changed`);
      if (n > 1) {
        throw new ValidationError(
          `old_str matched ${n} times in ${path}; include more surrounding text so it matches exactly once. Nothing was changed`,
        );
      }
      const i = cur.content.indexOf(oldStr);
      const next = cur.content.slice(0, i) + newStr + cur.content.slice(i + oldStr.length);
      return this.update(path, next, expected);
    });
  }

  async delete(path: string, ifVersion: unknown): Promise<WriteResult> {
    return this.guard(async () => {
      validatePath(path);
      const expected = requireExisting(ifVersion, "memory_delete");
      const res = await this.db
        .prepare("DELETE FROM docs WHERE path = ? AND version = ?")
        .bind(path, expected)
        .run();
      if (res.meta.changes === 0) return conflict(path, expected, await this.read(path));
      return { ok: true, path, version: expected, deleted: true };
    });
  }

  private async create(path: string, content: string): Promise<WriteResult> {
    const fm = checkContent(content);
    try {
      await this.db
        .prepare(
          "INSERT INTO docs (path, name, description, aliases, content, version, updated_at) VALUES (?, ?, ?, ?, ?, 1, ?)",
        )
        .bind(path, fm.name, fm.description, JSON.stringify(fm.aliases), content, now())
        .run();
    } catch (e) {
      if (!String((e as Error).message).includes("UNIQUE constraint failed")) throw e;
      // Either constraint can fire first when both collide; an existing path wins.
      const existing = await this.read(path);
      if (existing) return conflict(path, "new", existing);
      return this.nameTaken(fm.name);
    }
    return { ok: true, path, version: 1 };
  }

  /** Compare-and-swap: the UPDATE only applies if the stored version still equals `expected`. */
  private async update(path: string, content: string, expected: number): Promise<WriteResult> {
    const fm = checkContent(content);
    let changes: number;
    try {
      const res = await this.db
        .prepare(
          `UPDATE docs SET name = ?, description = ?, aliases = ?, content = ?, version = version + 1, updated_at = ?
           WHERE path = ? AND version = ?`,
        )
        .bind(fm.name, fm.description, JSON.stringify(fm.aliases), content, now(), path, expected)
        .run();
      changes = res.meta.changes;
    } catch (e) {
      if (String((e as Error).message).includes("docs.name")) return this.nameTaken(fm.name);
      throw e;
    }
    if (changes === 0) return conflict(path, expected, await this.read(path));
    return { ok: true, path, version: expected + 1 };
  }

  private async nameTaken(name: string): Promise<WriteResult> {
    const other = await this.db.prepare("SELECT path FROM docs WHERE name = ?").bind(name).first<{ path: string }>();
    return {
      ok: false,
      error: "invalid",
      message: `frontmatter name ${JSON.stringify(name)} is already used by ${other?.path ?? "another doc"}; names must be unique. Nothing was changed`,
    };
  }

  private async guard(fn: () => Promise<WriteResult>): Promise<WriteResult> {
    try {
      return await fn();
    } catch (e) {
      if (e instanceof ValidationError) return { ok: false, error: "invalid", message: e.message };
      throw e;
    }
  }
}

function checkContent(content: string) {
  if (typeof content !== "string") throw new ValidationError("content must be a string");
  validateSize(content);
  return parseFrontmatter(content);
}

function parseIfVersion(v: unknown): Expected {
  if (v === "new") return "new";
  const n = typeof v === "number" ? v : typeof v === "string" && /^\d+$/.test(v.trim()) ? Number(v) : NaN;
  if (!Number.isSafeInteger(n) || n < 1) {
    throw new ValidationError(
      'if_version is required: the version from memory_read/the last write, or the string "new" to create a file',
    );
  }
  return n;
}

function requireExisting(v: unknown, tool: string): number {
  const e = parseIfVersion(v);
  if (e === "new") throw new ValidationError(`${tool} needs an existing file; if_version "new" only works with memory_write`);
  return e;
}

function conflict(path: string, expected: Expected, current: DocVersion | null): WriteResult {
  const message = current
    ? expected === "new"
      ? `${path} already exists (version ${current.version}); nothing was changed. Re-apply your change to the current content with if_version ${current.version}`
      : `version conflict on ${path}: you sent if_version ${expected} but the current version is ${current.version}; nothing was changed. Re-apply your change to the current content below`
    : `${path} does not exist; nothing was changed. Use memory_write with if_version "new" to create it`;
  return { ok: false, error: "version_conflict", message, current };
}

function countOccurrences(haystack: string, needle: string): number {
  let n = 0;
  // Overlapping matches count too: "aa" in "aaa" is ambiguous.
  for (let i = haystack.indexOf(needle); i !== -1; i = haystack.indexOf(needle, i + 1)) n++;
  return n;
}

function now(): string {
  return new Date().toISOString();
}
