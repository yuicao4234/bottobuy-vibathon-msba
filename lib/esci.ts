// Amazon ESCI query bank: real shopper queries similar to a listing (keyword retrieval, no labels).
import bank from "@/data/esci_queries.json";
import examples from "@/data/esci_examples.json";
import type { Product } from "./types";
import { STOP, tokens } from "./text";

type Bank = { source: string; categories: string[]; queries: [string, number][] };
const B = bank as Bank;
export const ESCI_EXAMPLES = examples as { query: string; product_title: string; label: "E" | "S" | "C" | "I" }[];

let index: { postings: Map<string, number[]>; idf: Map<string, number>; toks: string[][] } | null = null;

function build() {
  const postings = new Map<string, number[]>();
  const toks = B.queries.map(([q]) => [...new Set(tokens(q).filter((w) => !STOP.has(w)))]);
  toks.forEach((ts, i) => ts.forEach((w) => {
    const l = postings.get(w);
    if (l) l.push(i); else postings.set(w, [i]);
  }));
  const N = toks.length;
  const idf = new Map([...postings].map(([w, l]) => [w, Math.log((N + 1) / (l.length + 1)) + 1]));
  index = { postings, idf, toks };
  return index;
}

/**
 * Real ESCI queries that share the most informative words with the listing.
 * Title words count double; a query must be mostly covered by listing words.
 */
export function similarQueries(p: Product, k = 20): string[] {
  const ix = index ?? build();
  const weight = new Map<string, number>();
  const add = (s: string, w: number) => tokens(s).forEach((t) => {
    if (!STOP.has(t) && t.length > 1) weight.set(t, Math.max(weight.get(t) ?? 0, w));
  });
  add([...p.bullets, p.description.slice(0, 800)].join(" "), 1);
  add(p.categories.join(" "), 1);
  add(p.title, 2);
  const score = new Map<number, number>();
  for (const [w, wt] of weight) {
    const post = ix.postings.get(w);
    if (!post || post.length > 20000) continue; // skip words that appear in almost every query
    const s = wt * (ix.idf.get(w) ?? 1);
    for (const i of post) score.set(i, (score.get(i) ?? 0) + s);
  }
  const ranked = [...score]
    .map(([i, s]) => {
      const qt = ix.toks[i];
      const covered = qt.filter((w) => weight.has(w)).length / Math.max(1, qt.length);
      return { i, s: s * covered * covered / Math.sqrt(qt.length) };
    })
    .filter((x) => ix.toks[x.i].length >= 2)
    .sort((a, b) => b.s - a.s);
  const out: string[] = [];
  const seen = new Set<string>();
  for (const { i } of ranked) {
    const key = [...ix.toks[i]].sort().join(" ");
    if (seen.has(key)) continue;
    seen.add(key);
    out.push(B.queries[i][0]);
    if (out.length >= k) break;
  }
  return out;
}

export const ESCI_SOURCE = B.source;
export const ESCI_QUERY_COUNT = B.queries.length;
