// Rule-based fallbacks used when ANTHROPIC_API_KEY is not set (or a Claude call fails).
// They keep the app usable for demos and make every number reproducible without an LLM.
import type { AgentView, Change, Constraint, Judgement, Product, ShopperPrompt } from "./types";
import { contentTokens, hasPhrase, numUnits, sentences, tokens, uniq } from "./text";
import { pageText } from "./amazon";
import { checkAttribute } from "./scoring";

const COLORS = "black white red blue green yellow pink purple orange brown gray grey silver gold beige navy teal ivory maroon burgundy turquoise khaki".split(" ");
const MATERIALS = "cotton leather wood wooden metal steel stainless silicone plastic glass bamboo wool linen polyester ceramic aluminum nylon velvet marble copper brass rubber canvas denim silk fleece acrylic".split(" ");
const AUDIENCE: Record<string, string> = { men: "men", mens: "men", women: "women", womens: "women", kid: "kids", kids: "kids", baby: "baby", toddler: "toddler", boy: "boys", boys: "boys", girl: "girls", girls: "girls", teen: "teens" };

/** Constraints a shopper query states (color, material, audience, size/quantity). */
export function extractConstraints(q: string): Constraint[] {
  const words: string[] = q.toLowerCase().match(/[a-z0-9]+/g) ?? [];
  const out: Constraint[] = [];
  COLORS.filter((c) => words.includes(c)).forEach((c) => out.push({ key: "Color", value: c === "grey" ? "gray" : c }));
  MATERIALS.filter((m) => words.includes(m)).forEach((m) => out.push({ key: "Material", value: m === "wooden" ? "wood" : m }));
  uniq(words.filter((w) => AUDIENCE[w]).map((w) => AUDIENCE[w])).forEach((a) => out.push({ key: "Audience", value: a }));
  numUnits(q).forEach((u) => out.push({ key: "Size / quantity", value: u }));
  return out;
}

/** Product type: the title phrase real shoppers use most (from similar ESCI queries), else the title head. */
export function productTypeOf(p: Product, esci: string[] = []): string {
  const brand = new Set(tokens(p.brand));
  const tt = contentTokens(p.title.replace(/\([^)]*\)/g, " ")).filter((w) => !brand.has(w) && !/\d/.test(w));
  const qs = esci.map((q) => " " + tokens(q).join(" ") + " ");
  let best = "", bestN = 0;
  for (let i = 0; i < tt.length; i++) for (const len of [2, 1]) {
    const ph = tt.slice(i, i + len).join(" ");
    if (ph.split(" ").length !== len) continue;
    const c = qs.filter((q) => q.includes(` ${ph} `)).length;
    const n = len === 2 ? (c >= 2 ? c * 3 : 0) : c;
    if (n > bestN) { bestN = n; best = ph; }
  }
  if (best) return best;
  const head = p.title.split(/,| - | \| | with | for /i)[0];
  const words = contentTokens(head).filter((w) => !brand.has(w) && !/\d/.test(w));
  return words.slice(-2).join(" ") || words[0] || "product";
}

export function heuristicAgentView(p: Product, esci: string[] = []): AgentView {
  const facts = [
    ...(p.brand ? [{ name: "Brand", value: p.brand, source: "brand", verified: true }] : []),
    ...(p.color ? [{ name: "Color", value: p.color, source: "details", verified: true }] : []),
    ...[...p.attributes, ...p.specifications].slice(0, 10).map((s) => ({ name: s.name, value: s.value, source: "details", verified: true })),
    ...[...numUnits(pageText(p))].slice(0, 4).map((u) => ({ name: "Size / quantity", value: u, source: "text", verified: true })),
  ];
  const text = pageText(p).toLowerCase();
  const audience = uniq(Object.entries(AUDIENCE).filter(([k]) => hasPhrase(text, k)).map(([, v]) => v));
  const missing = [
    !p.description && { info: "Product description", why: "Agents summarise from the description; without it they rely on the title alone." },
    p.specifications.length + p.attributes.length < 3 && { info: "Product details table", why: "Agents compare products on structured details like size, material and color." },
    !p.color && { info: "Color", why: "Shoppers often filter or ask by color." },
    !audience.length && { info: "Who it is for", why: "Requests like 'for kids' or 'for women' can't be matched." },
  ].filter(Boolean) as AgentView["missing"];
  return {
    productType: productTypeOf(p, esci),
    summary: `${p.brand ? p.brand + " " : ""}${productTypeOf(p, esci)}. ${sentences(p.description || p.bullets.join(". "))[0] ?? ""}`.trim(),
    facts, useCases: [], audience, missing,
  };
}

export function heuristicPrompts(p: Product, esci: string[]): ShopperPrompt[] {
  const type = productTypeOf(p, esci);
  const view = heuristicAgentView(p, esci);
  const out: ShopperPrompt[] = esci.slice(0, 6).map((q, i) => ({ id: `e${i}`, prompt: q, style: "keyword", origin: "esci", intent: "real Amazon search" }));
  const aud = view.audience[0];
  const conv = [
    `What's a good ${type}${aud ? ` for ${aud}` : ""}?`,
    `I need a ${type}${p.color ? ` in ${p.color.toLowerCase()}` : ""}. What do you recommend?`,
  ];
  conv.forEach((q, i) => out.push({ id: `g${i}`, prompt: q, style: "conversational", origin: "generated", intent: "AI assistant request" }));
  return out;
}

/** Keyword relevance (fallback for Claude): share of query words on the page, weighted to the title. */
export function heuristicJudge(p: Product, prompts: ShopperPrompt[]): Judgement[] {
  const tt = new Set(tokens(p.title)), ft = new Set(tokens(pageText(p)));
  return prompts.map((q) => {
    const qc = uniq(contentTokens(q.prompt)).filter((w) => w.length > 1);
    const n = qc.length || 1;
    const inTitle = qc.filter((w) => tt.has(w)).length / n, inPage = qc.filter((w) => ft.has(w)).length / n;
    const relevance = Math.round(100 * (0.6 * inTitle + 0.4 * inPage));
    const label = relevance >= 70 ? "E" : relevance >= 45 ? "S" : relevance >= 25 ? "C" : "I";
    return { promptId: q.id, label, relevance, constraints: extractConstraints(q.prompt),
      reason: `${Math.round(inTitle * 100)}% of the query words are in the title, ${Math.round(inPage * 100)}% anywhere on the page (keyword fallback, not Claude).` };
  });
}

/** Rule-based rewrite: only moves facts that are already on the page into more visible places. */
export function heuristicRewrite(p: Product, judgements: Judgement[]) {
  const listing: Product = structuredClone(p);
  const changes: Change[] = [];
  const needsConfirmation: { question: string; wouldAdd: string }[] = [];
  const surfaced: string[] = [];
  const seen = new Set<string>();
  for (const j of judgements) for (const c of j.constraints) {
    const k = `${c.key}:${c.value}`.toLowerCase();
    if (seen.has(k)) continue;
    seen.add(k);
    const a = checkAttribute(p, c);
    if (a.status === "Not exposed") {
      listing.specifications.push({ name: c.key, value: c.value });
      changes.push({ field: `details: ${c.key}`, before: "", after: c.value, why: `shoppers ask for ${c.key.toLowerCase()} "${c.value}"`, source: a.evidence });
      if (surfaced.length < 2) surfaced.push(c.key === "Audience" ? `for ${c.value}` : c.value);
    } else if (a.status === "Unknown") {
      needsConfirmation.push({ question: `Is it ${c.value}? Shoppers ask for ${c.key.toLowerCase()} "${c.value}" and the page doesn't say.`, wouldAdd: `${c.key}: ${c.value}` });
    }
  }
  let title = p.title;
  if (p.brand && !hasPhrase(title, p.brand)) title = `${p.brand} ${title}`;
  const adds = surfaced.filter((v) => !hasPhrase(title, v.replace(/^for /, "")));
  const aud = adds.filter((v) => v.startsWith("for ")).map((v) => v.slice(4));
  const suffix = [...adds.filter((v) => !v.startsWith("for ")), ...(aud.length ? [`for ${aud.join(" and ")}`] : [])].join(", ");
  if (suffix && title.length + suffix.length + 2 <= 200) title = `${title}, ${suffix}`;
  if (title !== p.title) {
    changes.push({ field: "title", before: p.title, after: title, why: "lead with the brand and surface attributes shoppers ask for", source: "brand field and page text" });
    listing.title = title;
  }
  if (p.bullets.length < 3 && p.description) {
    const extra = sentences(p.description).filter((s) => contentTokens(s).length >= 4).slice(0, 5 - p.bullets.length);
    if (extra.length) {
      listing.bullets = [...p.bullets, ...extra];
      changes.push({ field: "bullets", before: p.bullets.join("\n"), after: listing.bullets.join("\n"), why: "agents scan bullets; these sentences were already in the description", source: "description" });
    }
  }
  if (p.description.length < 80) needsConfirmation.push({ question: "Add a 2-3 sentence description (what it is, who it's for, key specs).", wouldAdd: "description" });
  return { listing, changes, needsConfirmation, newPrompts: [] as { prompt: string; why: string }[] };
}
