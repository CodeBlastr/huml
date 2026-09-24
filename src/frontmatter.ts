import { parse } from "yaml";

export interface Frontmatter {
  name: string;
  description: string | null;
  aliases: string[];
}

export class ValidationError extends Error {}

export const MAX_BYTES = 100 * 1024;
const PATH_RE = /^\/[A-Za-z0-9_\-./]+\.md$/;
const FM_RE = /^﻿?---\r?\n([\s\S]*?)\r?\n---[ \t]*(?:\r?\n|$)/;

export function validatePath(path: unknown): string {
  if (typeof path !== "string") throw new ValidationError("path must be a string");
  if (path.length > 512) throw new ValidationError("path must be at most 512 characters");
  if (!PATH_RE.test(path)) {
    throw new ValidationError(
      `invalid path ${JSON.stringify(path)}: must start with "/", contain only A-Z a-z 0-9 - _ / ., and end in ".md"`,
    );
  }
  if (path.includes("//") || path.split("/").some((s) => s === "." || s === "..")) {
    throw new ValidationError(`invalid path ${JSON.stringify(path)}: no empty, "." or ".." segments`);
  }
  return path;
}

export function validateSize(content: string): void {
  const bytes = new TextEncoder().encode(content).length;
  if (bytes > MAX_BYTES) {
    throw new ValidationError(`content is ${bytes} bytes; the limit is ${MAX_BYTES} bytes (100KB) per file`);
  }
}

/** Parse and validate frontmatter. Throws ValidationError with a model-readable message. */
export function parseFrontmatter(content: string): Frontmatter {
  const m = FM_RE.exec(content);
  if (!m) {
    throw new ValidationError(
      'missing frontmatter: content must start with a "---" line, YAML with at least `name:`, then a closing "---" line',
    );
  }
  let data: unknown;
  try {
    data = parse(m[1]);
  } catch (e) {
    throw new ValidationError(`frontmatter is not valid YAML: ${(e as Error).message}`);
  }
  if (!data || typeof data !== "object" || Array.isArray(data)) {
    throw new ValidationError("frontmatter must be a YAML mapping with at least `name:`");
  }
  const fm = data as Record<string, unknown>;

  const name = scalar(fm.name);
  if (!name) throw new ValidationError("frontmatter is missing `name`");
  if (name.length > 200) throw new ValidationError("frontmatter `name` must be at most 200 characters");

  const description = scalar(fm.description) || null;

  let aliases: string[] = [];
  if (Array.isArray(fm.aliases)) {
    aliases = fm.aliases.map(scalar).filter((a): a is string => !!a);
  } else if (fm.aliases != null) {
    const a = scalar(fm.aliases);
    if (a) aliases = [a];
  }
  return { name, description, aliases };
}

function scalar(v: unknown): string | undefined {
  if (typeof v === "string") return v.trim();
  if (typeof v === "number" || typeof v === "boolean") return String(v);
  return undefined;
}
