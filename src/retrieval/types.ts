export interface SearchHit {
  path: string;
  name: string;
  /** Short excerpt around the match; matched terms wrapped in ** when available. */
  snippet: string;
  /** Higher is better. Only comparable within one result set. */
  score: number;
}

export interface Retriever {
  search(query: string, limit: number): Promise<SearchHit[]>;
}
