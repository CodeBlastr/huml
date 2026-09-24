import type { Retriever, SearchHit } from "./types";

/** FTS5/BM25 retrieval over docs_fts. Name matches outrank description, then body. */
export class LexicalRetriever implements Retriever {
  constructor(private db: D1Database) {}

  async search(query: string, limit: number): Promise<SearchHit[]> {
    // Quote each term so user input can never be parsed as FTS5 syntax.
    const terms = (query.toLowerCase().match(/[\p{L}\p{N}_]+/gu) ?? []).slice(0, 32).map((t) => `"${t}"`);
    if (terms.length === 0) return [];

    const all = await this.run(terms.join(" "), limit);
    if (all.length > 0 || terms.length === 1) return all;
    return this.run(terms.join(" OR "), limit);
  }

  private async run(match: string, limit: number): Promise<SearchHit[]> {
    const { results } = await this.db
      .prepare(
        `SELECT d.path AS path, d.name AS name,
                snippet(docs_fts, -1, '**', '**', '…', 16) AS snippet,
                bm25(docs_fts, 0.0, 10.0, 5.0, 1.0) AS rank
         FROM docs_fts JOIN docs d ON d.rowid = docs_fts.rowid
         WHERE docs_fts MATCH ?
         ORDER BY rank LIMIT ?`,
      )
      .bind(match, limit)
      .all<{ path: string; name: string; snippet: string; rank: number }>();
    // bm25() is lower-is-better; flip it so score is higher-is-better.
    return results.map((r) => ({ path: r.path, name: r.name, snippet: r.snippet, score: -r.rank }));
  }
}
