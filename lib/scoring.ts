// Rating model (PRD §4), ported from the Python prototype.
//   V(p,q) = 0.40 R + 0.30 A + 0.20 C + 0.10 M      (each 0-100)
// R comes from the relevance judge (Claude, or the keyword fallback). A, C, M and the SEO score are
// deterministic checks on the listing, so they are reproducible and explainable.
import type { AttrCheck, Check, Constraint, Judgement, Product, PromptScore, Scorecard, SeoScore, ShopperPrompt } from "./types";
import { STOP, contentTokens, hasPhrase, numUnits, round1, tokens, uniq } from "./text";

export const WEIGHTS = { R: 0.4, A: 0.3, C: 0.2, M: 0.1 };
const GENERIC_BRAND = /^(generic|unknown|n\/?a|none|unbranded|)$/i;

// ---- A: attribute coverage ---------------------------------------------------------------------
function valueIn(text: string, value: string): boolean {
  const units = numUnits(value);
  if (units.size) {
    const have = numUnits(text);
    return [...units].every((u) => have.has(u));
  }
  if (hasPhrase(text, value)) return true;
  const vt = contentTokens(value);
  if (!vt.length) return false;
  const tt = new Set(tokens(text));
  return vt.every((w) => tt.has(w));
}

function snippet(text: string, value: string): string {
  const first = contentTokens(value)[0] ?? value.toLowerCase();
  const s = text.split(/(?<=[.!?])\s+|\n/).find((x) => tokens(x).includes(first));
  return (s ?? "").trim().slice(0, 180);
}

export function checkAttribute(p: Product, c: Constraint): AttrCheck {
  const structured = [
    ...(p.color ? [{ name: "Color", value: p.color }] : []),
    ...p.attributes, ...p.specifications,
  ];
  const field = structured.find((s) => valueIn(s.value, c.value) || valueIn(`${s.name} ${s.value}`, c.value));
  if (field) return { ...c, status: "Known", credit: 1, field: "details", evidence: `${field.name}: ${field.value}` };
  if (valueIn(p.title, c.value)) return { ...c, status: "Known", credit: 1, field: "title", evidence: p.title.slice(0, 180) };
  const bullets = p.bullets.join("\n");
  if (valueIn(bullets, c.value)) return { ...c, status: "Not exposed", credit: 0.5, field: "bullets", evidence: snippet(bullets, c.value) };
  if (valueIn(p.description, c.value)) return { ...c, status: "Not exposed", credit: 0.5, field: "description", evidence: snippet(p.description, c.value) };
  return { ...c, status: "Unknown", credit: 0, field: null, evidence: "" };
}

// ---- C: clarity rubric (4 x 25) -------------------------------------------------------------------
export function clarity(p: Product): Check[] {
  const brandT = new Set(tokens(p.brand));
  const titleWords = contentTokens(p.title).filter((w) => !brandT.has(w) && !/^\d+$/.test(w));
  const tw = tokens(p.title).filter((w) => !STOP.has(w) && w.length > 2);
  const rep = Math.max(0, ...uniq(tw).map((w) => tw.filter((x) => x === w).length));
  const desc = p.description.trim();
  const copy = !!desc && (desc.toLowerCase() === p.title.toLowerCase() || desc.toLowerCase() === p.bullets.join(" ").toLowerCase());
  const feats = p.bullets.filter((b) => contentTokens(b).length >= 4);
  const dup = new Set(p.bullets.map((b) => b.toLowerCase())).size < p.bullets.length;
  return [
    { name: "Product type is identifiable from the title", pass: titleWords.length >= 2 && p.title.length <= 200,
      detail: `${titleWords.length} descriptive words${p.title.length > 200 ? "; title over 200 characters" : ""}` },
    { name: "Description has real content", pass: desc.length >= 80 && !copy,
      detail: !desc ? "no description" : copy ? "description repeats the title or bullets" : `${desc.length} characters` },
    { name: "Two or more concrete features", pass: feats.length >= 2, detail: `${feats.length} bullet(s) with 4+ descriptive words` },
    { name: "No repeated boilerplate", pass: !dup && rep <= 3 && !copy,
      detail: dup ? "duplicate bullets" : rep > 3 ? `a title word repeats ${rep}x` : copy ? "copied text" : "ok" },
  ];
}

// ---- M: metadata completeness -----------------------------------------------------------------------
export function metadata(p: Product, colorApplicable: boolean) {
  const f = [
    { field: "Title", present: !!p.title },
    { field: "Brand", present: !GENERIC_BRAND.test(p.brand.trim()) },
    { field: "Bullet points", present: p.bullets.length > 0 },
    { field: "Description", present: !!p.description },
    { field: "Product details (3+)", present: p.specifications.length + p.attributes.length >= 3 },
  ];
  if (colorApplicable) f.push({ field: "Color", present: !!p.color });
  return f;
}

// ---- one prompt ------------------------------------------------------------------------------------
function where(p: Product, term: string): string[] {
  const out: string[] = [];
  if (tokens(p.title).includes(term)) out.push("title");
  if (tokens(p.bullets.join(" ")).includes(term)) out.push("bullets");
  if (tokens(p.description).includes(term)) out.push("description");
  if (tokens([p.brand, p.color, ...p.specifications.map((s) => s.value), ...p.attributes.map((s) => s.value)].join(" ")).includes(term)) out.push("details");
  return out;
}

export function scorePrompt(p: Product, prompt: ShopperPrompt, j: Judgement, C: number, mFields: { present: boolean }[]): PromptScore {
  const attrs = j.constraints.slice(0, 6).map((c) => checkAttribute(p, c));
  const A = attrs.length ? (100 * attrs.reduce((s, a) => s + a.credit, 0)) / attrs.length : null;
  const M = (100 * mFields.filter((f) => f.present).length) / mFields.length;
  const R = Math.max(0, Math.min(100, j.relevance));
  const w = A == null ? { R: 0.4 / 0.7, A: 0, C: 0.2 / 0.7, M: 0.1 / 0.7 } : { ...WEIGHTS };
  // contributions are rounded first so the displayed parts always add up to the displayed total
  const contrib = { R: round1(w.R * R), A: round1(w.A * (A ?? 0)), C: round1(w.C * C), M: round1(w.M * M) };
  return {
    prompt, judgement: j, R: round1(R), A: A == null ? null : round1(A), C, M: round1(M), weights: w, contrib,
    V: round1(contrib.R + contrib.A + contrib.C + contrib.M), attributes: attrs,
    matchedTerms: uniq(contentTokens(prompt.prompt)).map((t) => ({ term: t, where: where(p, t) })),
  };
}

// ---- SEO (Amazon keyword search) -----------------------------------------------------------------------
export function seo(p: Product, prompts: ShopperPrompt[], productType: string): SeoScore {
  const brandT = new Set(tokens(p.brand));
  const freq = new Map<string, number>();
  prompts.forEach((q) => uniq(contentTokens(q.prompt)).forEach((w) => {
    if (!brandT.has(w) && w.length > 2 && !/^\d+$/.test(w)) freq.set(w, (freq.get(w) ?? 0) + (q.style === "keyword" ? 2 : 1));
  }));
  const kw = [...freq].sort((a, b) => b[1] - a[1]).slice(0, 8).map(([w]) => w);
  const tt = new Set(tokens(p.title)), bt = new Set(tokens(p.bullets.join(" "))), dt = new Set(tokens(p.description));
  const keywords = kw.map((term) => ({ term, inTitle: tt.has(term), inBullets: bt.has(term), inDescription: dt.has(term) }));
  const share = (f: (k: (typeof keywords)[0]) => boolean) => (keywords.length ? keywords.filter(f).length / keywords.length : 0);
  const L = p.title.length;
  const first8 = new Set(tokens(p.title).slice(0, 10));
  const typeWords = contentTokens(productType);
  const tw = tokens(p.title).filter((w) => !STOP.has(w) && w.length > 2);
  const rep = Math.max(0, ...uniq(tw).map((w) => tw.filter((x) => x === w).length));
  const checks = [
    { name: "Title length 80-200 characters", max: 15, points: L >= 80 && L <= 200 ? 15 : L >= 50 && L <= 250 ? 8 : 0, detail: `${L} characters` },
    { name: "Brand in title", max: 10, points: p.brand && hasPhrase(p.title, p.brand) ? 10 : 0, detail: p.brand ? `brand: ${p.brand}` : "no brand" },
    { name: "Product type near the start of the title", max: 15,
      points: typeWords.length && typeWords.some((w) => first8.has(w)) ? 15 : 0, detail: `type: ${productType || "unknown"}` },
    { name: "Shopper keywords in title", max: 20, points: Math.round(20 * share((k) => k.inTitle)),
      detail: `${keywords.filter((k) => k.inTitle).length} of ${keywords.length} top keywords` },
    { name: "Shopper keywords in bullets or description", max: 15, points: Math.round(15 * share((k) => k.inBullets || k.inDescription)),
      detail: `${keywords.filter((k) => k.inBullets || k.inDescription).length} of ${keywords.length}` },
    { name: "Five bullet points", max: 10, points: Math.min(10, 2 * p.bullets.length), detail: `${p.bullets.length} bullets` },
    { name: "Description of 200+ characters", max: 10, points: p.description.length >= 200 ? 10 : p.description.length >= 80 ? 5 : 0,
      detail: `${p.description.length} characters` },
    { name: "No keyword stuffing in title", max: 5, points: rep <= 3 ? 5 : 0, detail: rep > 3 ? `a word repeats ${rep}x` : "ok" },
  ].map((c) => ({ ...c, pass: c.points === c.max }));
  return { score: checks.reduce((s, c) => s + c.points, 0), checks, keywords };
}

// ---- whole scorecard -----------------------------------------------------------------------------------
export function scorecard(p: Product, prompts: ShopperPrompt[], judgements: Judgement[], productType: string): Scorecard {
  const clar = clarity(p);
  const C = 25 * clar.filter((c) => c.pass).length;
  const colorApplicable = !!p.color || judgements.some((j) => j.constraints.some((c) => /colou?r/i.test(c.key)));
  const meta = metadata(p, colorApplicable);
  const byId = new Map(judgements.map((j) => [j.promptId, j]));
  const scored = prompts.filter((q) => byId.has(q.id)).map((q) => scorePrompt(p, q, byId.get(q.id)!, C, meta));
  const n = Math.max(1, scored.length);
  const avg = (k: "R" | "A" | "C" | "M") => round1(scored.reduce((s, x) => s + x.contrib[k], 0) / n);
  const contrib = { R: avg("R"), A: avg("A"), C: avg("C"), M: avg("M") };
  const mx = (k: "R" | "A" | "C" | "M") => round1((100 * scored.reduce((s, x) => s + x.weights[k], 0)) / n);
  return {
    visibility: round1(contrib.R + contrib.A + contrib.C + contrib.M), contrib,
    max: { R: mx("R"), A: mx("A"), C: mx("C"), M: mx("M") },
    renormalized: scored.filter((x) => x.A == null).length,
    seo: seo(p, prompts, productType), clarity: clar, metadata: meta,
    prompts: [...scored].sort((a, b) => a.V - b.V),
  };
}
