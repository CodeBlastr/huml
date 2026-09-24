import type { Retriever, SearchHit } from "./types";

/**
 * Semantic retrieval backed by Cloudflare Vectorize.
 *
 * TODO: implement. To enable:
 *   1. `wrangler vectorize create huml-docs --dimensions=768 --metric=cosine`
 *      (768 matches @cf/baai/bge-base-en-v1.5; the Cloudflare token also needs Vectorize:Edit).
 *   2. Uncomment the [[vectorize]] and [ai] bindings in wrangler.toml.
 *      makeRetriever() switches to this class automatically once both bindings exist.
 *   3. Index on write: after each successful Store write/append/str_replace, embed the
 *      doc (or chunks of it) and `VECTORIZE.upsert([{ id: path, values, metadata: { path, name } }])`;
 *      on delete, `VECTORIZE.deleteByIds([path])`. A backfill script should embed existing docs.
 *   4. search(): embed the query, `VECTORIZE.query(values, { topK: limit, returnMetadata: "all" })`,
 *      then load name/snippet for the matched paths from D1.
 *
 * The MCP tool contract (memory_search returns path, name, snippet) does not change.
 */
export class VectorRetriever implements Retriever {
  constructor(
    private index: VectorizeIndex,
    private ai: Ai,
    private db: D1Database,
  ) {}

  async search(_query: string, _limit: number): Promise<SearchHit[]> {
    throw new Error("VectorRetriever is not implemented yet; unbind VECTORIZE to fall back to LexicalRetriever");
  }
}
