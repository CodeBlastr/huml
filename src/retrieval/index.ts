import type { Env } from "../env";
import { LexicalRetriever } from "./lexical";
import type { Retriever } from "./types";
import { VectorRetriever } from "./vector";

export type { Retriever, SearchHit } from "./types";

/** The one switch point: binding VECTORIZE + AI in wrangler.toml selects semantic search. */
export function makeRetriever(env: Env): Retriever {
  if (env.VECTORIZE && env.AI) return new VectorRetriever(env.VECTORIZE, env.AI, env.DB);
  return new LexicalRetriever(env.DB);
}
