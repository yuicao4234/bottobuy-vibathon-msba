// Client-side helpers: word diff for before/after, and CSV / JSON export (no server or database needed).
import type { Analysis, Product, Proposal } from "./types";

export type DiffPart = { t: string; k: "same" | "ins" | "del" };

/** Word-level diff (LCS). Inputs are capped so it stays fast in the browser. */
export function wordDiff(a: string, b: string): DiffPart[] {
  const A = a.split(/(\s+)/).slice(0, 1200), B = b.split(/(\s+)/).slice(0, 1200);
  const n = A.length, m = B.length;
  const dp = Array.from({ length: n + 1 }, () => new Uint16Array(m + 1));
  for (let i = n - 1; i >= 0; i--) for (let j = m - 1; j >= 0; j--) dp[i][j] = A[i] === B[j] ? dp[i + 1][j + 1] + 1 : Math.max(dp[i + 1][j], dp[i][j + 1]);
  const out: DiffPart[] = [];
  const push = (t: string, k: DiffPart["k"]) => { const last = out[out.length - 1]; if (last && last.k === k) last.t += t; else out.push({ t, k }); };
  let i = 0, j = 0;
  while (i < n && j < m) {
    if (A[i] === B[j]) { push(A[i], "same"); i++; j++; }
    else if (dp[i + 1][j] >= dp[i][j + 1]) push(A[i++], "del");
    else push(B[j++], "ins");
  }
  while (i < n) push(A[i++], "del");
  while (j < m) push(B[j++], "ins");
  return out;
}

function listingRows(p: Product) {
  return [
    ["title", p.title],
    ["brand", p.brand],
    ["color", p.color],
    ...p.bullets.map((b, i) => [`bullet_${i + 1}`, b]),
    ["description", p.description],
    ...[...p.attributes, ...p.specifications].map((s) => [`detail: ${s.name}`, s.value]),
  ] as [string, string][];
}

export function buildJson(a: Analysis, prop: Proposal | null, useImproved: boolean) {
  const final = useImproved && prop ? prop.listing : a.product;
  return {
    generated_by: "AgentReady",
    generated_at: new Date().toISOString(),
    asin: a.product.asin,
    url: a.product.url,
    chosen_version: useImproved && prop ? "improved" : "original",
    listing: { title: final.title, brand: final.brand, color: final.color, bullets: final.bullets, description: final.description,
      details: [...final.attributes, ...final.specifications] },
    original_listing: { title: a.product.title, bullets: a.product.bullets, description: a.product.description },
    scores: {
      visibility_before: a.scorecard.visibility, seo_before: a.scorecard.seo.score,
      visibility_after: prop?.scorecard.visibility ?? null, seo_after: prop?.scorecard.seo.score ?? null,
      formula: "V = 0.40 R + 0.30 A + 0.20 C + 0.10 M (averaged over shopper prompts)",
    },
    ai_agent_view: a.agentView,
    shopper_prompts: a.scorecard.prompts.map((s) => {
      const after = prop?.scorecard.prompts.find((x) => x.prompt.id === s.prompt.id);
      return { prompt: s.prompt.prompt, style: s.prompt.style, origin: s.prompt.origin, esci_label: s.judgement.label,
        score_before: s.V, score_after: after?.V ?? null };
    }),
    new_prompts: prop?.newPrompts ?? [],
    needs_seller_confirmation: prop?.needsConfirmation ?? [],
    mode: { ...a.mode, rewrite: prop?.mode ?? null },
  };
}

const q = (s: unknown) => `"${String(s ?? "").replace(/"/g, '""')}"`;

export function buildCsv(a: Analysis, prop: Proposal | null, useImproved: boolean): string {
  const rows: string[][] = [["section", "item", "original", "improved", "chosen"]];
  const before = listingRows(a.product), after = prop ? listingRows(prop.listing) : [];
  const keys = [...new Set([...before.map((r) => r[0]), ...after.map((r) => r[0])])];
  for (const k of keys) {
    const o = before.find((r) => r[0] === k)?.[1] ?? "", n = after.find((r) => r[0] === k)?.[1] ?? "";
    rows.push(["listing", k, o, prop ? n : "", useImproved && prop ? n : o]);
  }
  rows.push(["score", "visibility (0-100)", String(a.scorecard.visibility), String(prop?.scorecard.visibility ?? ""), ""]);
  rows.push(["score", "seo (0-100)", String(a.scorecard.seo.score), String(prop?.scorecard.seo.score ?? ""), ""]);
  for (const s of a.scorecard.prompts) {
    const after = prop?.scorecard.prompts.find((x) => x.prompt.id === s.prompt.id);
    rows.push(["prompt", s.prompt.prompt, String(s.V), String(after?.V ?? ""), `${s.prompt.style}/${s.prompt.origin}/${s.judgement.label}`]);
  }
  for (const n of prop?.newPrompts ?? []) rows.push(["new_prompt", n.prompt, "", n.why, ""]);
  for (const n of prop?.needsConfirmation ?? []) rows.push(["needs_confirmation", n.question, "", n.wouldAdd, ""]);
  return rows.map((r) => r.map(q).join(",")).join("\r\n");
}

export function download(name: string, text: string, type: string) {
  const url = URL.createObjectURL(new Blob([text], { type }));
  const a = document.createElement("a");
  a.href = url; a.download = name; a.click();
  setTimeout(() => URL.revokeObjectURL(url), 1000);
}
