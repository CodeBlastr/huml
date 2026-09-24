import { env } from "cloudflare:test";
import { describe, expect, it } from "vitest";
import { doc, tool, uid } from "./helpers";

async function search(query: string) {
  const r = await tool("memory_search", { query });
  return (r.data.results as { path: string; snippet: string }[]).map((h) => h.path);
}

describe("round trip", () => {
  it("create → read → append → str_replace → delete, with FTS triggers checked at each step", async () => {
    const id = uid();
    const path = `/test/${id}.md`;
    const [w1, w2, w3] = [`alpha${id}`, `bravo${id}`, `charlie${id}`];

    let r = await tool("memory_write", { path, content: doc(`n${id}`, `- first line ${w1}`), if_version: "new" });
    expect(r).toEqual({ isError: false, data: { path, version: 1 } });
    expect(await search(w1)).toEqual([path]); // insert trigger

    r = await tool("memory_read", { path });
    expect(r.data.version).toBe(1);
    expect(r.data.content).toContain(w1);

    r = await tool("memory_append", { path, content: `- appended ${w2}`, if_version: 1 });
    expect(r.data).toEqual({ path, version: 2 });
    expect((await tool("memory_read", { path })).data.content).toMatch(new RegExp(`${w1}\\n- appended ${w2}\\n?$`));
    expect(await search(w2)).toEqual([path]);

    r = await tool("memory_str_replace", { path, old_str: w1, new_str: w3, if_version: "2" });
    expect(r.data).toEqual({ path, version: 3 });
    expect(await search(w1)).toEqual([]); // update trigger removed the old term
    expect(await search(w3)).toEqual([path]);

    r = await tool("memory_delete", { path, if_version: 3 });
    expect(r.data).toEqual({ path, deleted: true });
    expect(await search(w3)).toEqual([]); // delete trigger
    expect((await tool("memory_read", { path })).isError).toBe(true);
  });

  it("reads an array of paths, reporting missing ones", async () => {
    const id = uid();
    const a = `/test/${id}-a.md`;
    await tool("memory_write", { path: a, content: doc(`a${id}`, "x"), if_version: "new" });
    const r = await tool("memory_read", { path: [a, `/test/${id}-missing.md`] });
    expect(r.data.docs[0]).toMatchObject({ path: a, version: 1 });
    expect(r.data.docs[1]).toEqual({ path: `/test/${id}-missing.md`, error: "not_found" });
  });

  it("lists by prefix without content", async () => {
    const id = uid();
    await tool("memory_write", {
      path: `/list${id}/one.md`,
      content: doc(`l${id}`, "body", "aliases: [Foo LLC, Bar]\n"),
      if_version: "new",
    });
    const r = await tool("memory_list", { path_prefix: `/list${id}/` });
    expect(r.data.docs).toHaveLength(1);
    expect(r.data.docs[0]).toMatchObject({ path: `/list${id}/one.md`, name: `l${id}`, aliases: ["Foo LLC", "Bar"] });
    expect(r.data.docs[0].content).toBeUndefined();
  });
});

describe("concurrency", () => {
  it("two concurrent writes with the same if_version: one wins, one gets current content", async () => {
    const id = uid();
    const path = `/test/${id}.md`;
    await tool("memory_write", { path, content: doc(`c${id}`, "v1"), if_version: "new" });

    const [a, b] = await Promise.all([
      tool("memory_write", { path, content: doc(`c${id}`, "from A"), if_version: 1 }),
      tool("memory_write", { path, content: doc(`c${id}`, "from B"), if_version: 1 }),
    ]);
    const winner = a.isError ? b : a;
    const loser = a.isError ? a : b;
    expect([a.isError, b.isError].sort()).toEqual([false, true]);
    expect(winner.data.version).toBe(2);
    expect(loser.data.error).toBe("version_conflict");
    expect(loser.data.current.version).toBe(2);

    const stored = (await tool("memory_read", { path })).data;
    expect(loser.data.current.content).toBe(stored.content);
    expect(stored.content).toContain(a.isError ? "from B" : "from A");
  });

  it("stale if_version on append / str_replace / delete modifies nothing", async () => {
    const id = uid();
    const path = `/test/${id}.md`;
    await tool("memory_write", { path, content: doc(`s${id}`, "hello"), if_version: "new" });
    await tool("memory_append", { path, content: "more", if_version: 1 });
    for (const [name, args] of [
      ["memory_append", { content: "x" }],
      ["memory_str_replace", { old_str: "hello", new_str: "bye" }],
      ["memory_delete", {}],
      ["memory_write", { content: doc(`s${id}`, "clobber") }],
    ] as const) {
      const r = await tool(name, { path, ...args, if_version: 1 });
      expect(r.isError).toBe(true);
      expect(r.data).toMatchObject({ error: "version_conflict", current: { version: 2 } });
    }
    expect((await tool("memory_read", { path })).data.version).toBe(2);
  });

  it('"new" on an existing path is a conflict, and a numeric version on a missing path is too', async () => {
    const id = uid();
    const path = `/test/${id}.md`;
    await tool("memory_write", { path, content: doc(`e${id}`, "x"), if_version: "new" });
    const again = await tool("memory_write", { path, content: doc(`e${id}`, "y"), if_version: "new" });
    expect(again.data).toMatchObject({ error: "version_conflict", current: { version: 1 } });
    const missing = await tool("memory_write", { path: `/test/${id}-no.md`, content: doc(`f${id}`, "y"), if_version: 1 });
    expect(missing.data).toMatchObject({ error: "version_conflict", current: null });
  });
});

describe("validation", () => {
  it("str_replace rejects zero and multiple matches, naming which", async () => {
    const id = uid();
    const path = `/test/${id}.md`;
    await tool("memory_write", { path, content: doc(`r${id}`, "dup dup"), if_version: "new" });
    const none = await tool("memory_str_replace", { path, old_str: "absent", new_str: "x", if_version: 1 });
    expect(none.data.message).toMatch(/not found/);
    const many = await tool("memory_str_replace", { path, old_str: "dup", new_str: "x", if_version: 1 });
    expect(many.data.message).toMatch(/matched 2 times/);
    expect((await tool("memory_read", { path })).data.version).toBe(1);
  });

  it("rejects missing frontmatter, missing name, bad paths, oversize, duplicate names", async () => {
    const id = uid();
    const bad = async (args: Record<string, unknown>) => {
      const r = await tool("memory_write", { if_version: "new", ...args });
      expect(r.isError).toBe(true);
      return r.data.message as string;
    };
    expect(await bad({ path: `/t/${id}a.md`, content: "no frontmatter" })).toMatch(/missing frontmatter/);
    expect(await bad({ path: `/t/${id}b.md`, content: "---\ndescription: x\n---\nbody" })).toMatch(/missing `name`/);
    expect(await bad({ path: `t/${id}.md`, content: doc(`p${id}`, "x") })).toMatch(/invalid path/);
    expect(await bad({ path: `/t/${id}.txt`, content: doc(`p${id}`, "x") })).toMatch(/invalid path/);
    expect(await bad({ path: `/t/../${id}.md`, content: doc(`p${id}`, "x") })).toMatch(/invalid path/);
    expect(await bad({ path: `/t/${id} x.md`, content: doc(`p${id}`, "x") })).toMatch(/invalid path/);
    expect(await bad({ path: `/t/${id}c.md`, content: doc(`big${id}`, "x".repeat(100 * 1024)) })).toMatch(
      /limit is 102400 bytes/,
    );

    await tool("memory_write", { path: `/t/${id}d.md`, content: doc(`dup${id}`, "x"), if_version: "new" });
    expect(await bad({ path: `/t/${id}e.md`, content: doc(`dup${id}`, "y") })).toMatch(/already used by \/t\/.*d\.md/);
  });

  it("append that would exceed 100KB is rejected", async () => {
    const id = uid();
    const path = `/test/${id}.md`;
    await tool("memory_write", { path, content: doc(`big${id}`, "x".repeat(60 * 1024)), if_version: "new" });
    const r = await tool("memory_append", { path, content: "y".repeat(60 * 1024), if_version: 1 });
    expect(r.data.message).toMatch(/100KB/);
  });
});

describe("search", () => {
  it("finds a doc by a word only in its body, and rebuild restores a wiped index", async () => {
    const id = uid();
    const word = `zq${id}`;
    const path = `/test/${id}.md`;
    await tool("memory_write", { path, content: doc(`sr${id}`, `- the body mentions ${word} once`), if_version: "new" });
    const r = await tool("memory_search", { query: word });
    expect(r.data.results).toEqual([{ path, name: `sr${id}`, snippet: expect.stringContaining(`**${word}**`) }]);

    await env.DB.prepare("INSERT INTO docs_fts(docs_fts) VALUES('delete-all')").run();
    expect(await search(word)).toEqual([]);
    await env.DB.prepare("INSERT INTO docs_fts(docs_fts) VALUES('rebuild')").run();
    expect(await search(word)).toEqual([path]);
  });

  it("treats FTS syntax in queries as plain words", async () => {
    const r = await tool("memory_search", { query: 'NEAR(" OR * ) -"' });
    expect(r.isError).toBe(false);
  });
});
