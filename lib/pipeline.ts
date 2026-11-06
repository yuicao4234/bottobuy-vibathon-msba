// analyze(): product page -> agent view, shopper prompts, scores.
// optimize(): weak spots -> grounded rewrite -> re-scored with the SAME prompts and the SAME judge.
import type { AgentView, Analysis, Change, Judgement, Product, Proposal, ShopperPrompt } from "./types";
import { MODEL, claudeEnabled, claudeErrorText, judge, rewrite, understand } from "./claude";
import { heuristicAgentView, heuristicJudge, heuristicPrompts, heuristicRewrite, productTypeOf } from "./heuristics";
import { grounded, unsupportedClaims } from "./guard";
import { similarQueries } from "./esci";
import { pageText } from "./amazon";
import { scorecard } from "./scoring";
import { clean } from "./text";

async function judgeWith(mode: "claude" | "heuristic", p: Product, prompts: ShopperPrompt[]): Promise<Judgement[]> {
  if (mode === "heuristic") return heuristicJudge(p, prompts);
  const raw = await judge(p, prompts);
  const ids = new Set(prompts.map((q) => q.id));
  return raw.filter((j) => ids.has(j.id)).map((j) => ({
    promptId: j.id, label: j.label, relevance: Math.max(0, Math.min(100, Math.round(j.relevance))),
    constraints: j.constraints.slice(0, 4).map((c) => ({ key: clean(c.key), value: clean(c.value) })).filter((c) => c.key && c.value),
    reason: j.reason,
  }));
}

export async function analyze(p: Product): Promise<Analysis & { warning?: string }> {
  const esci = similarQueries(p, 20);
  const source = pageText(p);
  let agentView: AgentView, prompts: ShopperPrompt[], judgements: Judgement[];
  let mode: "claude" | "heuristic" = claudeEnabled() ? "claude" : "heuristic";
  let warning: string | undefined;
  if (mode === "claude") {
    try {
      const u = await understand(p, esci);
      const esciSet = new Set(esci);
      agentView = {
        productType: clean(u.product_type), summary: u.summary,
        facts: u.facts.map((f) => ({ name: clean(f.name), value: clean(f.value), source: clean(f.source), verified: grounded(f.value, source) })),
        useCases: u.use_cases, audience: u.audience, missing: u.missing,
      };
      prompts = [
        ...u.conversational_prompts.slice(0, 5).map((c, i) => ({ id: `c${i}`, prompt: clean(c.prompt), style: "conversational" as const, origin: "generated" as const, intent: c.intent })),
        ...u.keyword_queries.slice(0, 5).map((k, i) => {
          const q = clean(k.query).toLowerCase();
          return { id: `k${i}`, prompt: q, style: "keyword" as const, origin: esciSet.has(q) ? ("esci" as const) : ("generated" as const), intent: "Amazon search" };
        }),
      ];
      judgements = await judgeWith("claude", p, prompts);
    } catch (e) {
      mode = "heuristic";
      warning = `Claude was unavailable (${claudeErrorText(e)}), so these results use the keyword rules instead.`;
    }
  }
  if (mode === "heuristic") {
    agentView = heuristicAgentView(p, esci);
    prompts = heuristicPrompts(p, esci);
    judgements = heuristicJudge(p, prompts);
  }
  return {
    product: p, agentView: agentView!, prompts: prompts!, esciMatches: esci,
    scorecard: scorecard(p, prompts!, judgements!, agentView!.productType),
    mode: { judge: mode, model: mode === "claude" ? MODEL : null, data: p.source },
    createdAt: new Date().toISOString(), warning,
  };
}

export async function optimize(a: Analysis): Promise<Proposal & { warning?: string }> {
  const p = a.product;
  const source = pageText(p);
  const weak = a.scorecard.prompts.slice(0, 4).map((s) => ({
    prompt: s.prompt.prompt,
    issues: [
      `${s.judgement.label} match: ${s.judgement.reason}`,
      ...s.attributes.filter((x) => x.status !== "Known").map((x) => `${x.key} "${x.value}" is ${x.status === "Unknown" ? "not stated" : "only in the " + x.field}`),
    ],
  }));
  let mode: "claude" | "rule-based" = a.mode.judge === "claude" && claudeEnabled() ? "claude" : "rule-based";
  let warning: string | undefined;
  let listing: Product = structuredClone(p);
  let changes: Change[] = [], needsConfirmation: Proposal["needsConfirmation"] = [], newPrompts: Proposal["newPrompts"] = [];
  const blocked: string[] = [];

  if (mode === "claude") {
    try {
      const rw = await rewrite(p, weak, a.agentView.missing.map((m) => m.info));
      // Guard every generated field against claims the page does not support.
      const ok = (field: string, text: string) => {
        const bad = unsupportedClaims(text, source);
        if (bad.length) blocked.push(`${field}: ${bad.join(", ")}`);
        return bad.length === 0;
      };
      const title = clean(rw.title).slice(0, 200);
      if (title && ok("title", title)) listing.title = title;
      const bullets = rw.bullets.map(clean).filter((b) => b && ok(`bullet "${b.slice(0, 40)}…"`, b));
      if (bullets.length >= 2) listing.bullets = bullets;
      if (rw.description && ok("description", rw.description)) listing.description = clean(rw.description);
      for (const d of rw.details_to_add) {
        if (grounded(d.value, source) && ok(`detail ${d.name}`, d.value)) listing.specifications.push({ name: clean(d.name), value: clean(d.value) });
        else blocked.push(`detail ${d.name}: "${d.value}" is not supported by the page`);
      }
      const before: Record<string, string> = { title: p.title, bullets: p.bullets.join("\n"), description: p.description };
      const after: Record<string, string> = { title: listing.title, bullets: listing.bullets.join("\n"), description: listing.description };
      changes = rw.changes.map((c) => {
        const f = c.field.toLowerCase().includes("bullet") ? "bullets" : c.field.toLowerCase().includes("desc") ? "description" : c.field.toLowerCase().includes("title") ? "title" : c.field;
        return { field: f, before: before[f] ?? "", after: after[f] ?? "", why: c.why, source: c.source_quote };
      });
      needsConfirmation = rw.needs_confirmation.map((n) => ({ question: n.question, wouldAdd: n.would_add }));
      newPrompts = rw.new_prompts;
    } catch (e) {
      mode = "rule-based";
      warning = `Claude was unavailable (${claudeErrorText(e)}), so this is the rule-based rewrite.`;
      listing = structuredClone(p);
    }
  }
  if (mode === "rule-based") {
    const judgements = a.scorecard.prompts.map((s) => s.judgement);
    const h = heuristicRewrite(p, judgements);
    listing = h.listing; changes = h.changes; needsConfirmation = h.needsConfirmation; newPrompts = h.newPrompts;
  }
  // Retest: same prompts, same judge as the baseline, only the listing changed.
  let judgements: Judgement[];
  try {
    judgements = await judgeWith(a.mode.judge, listing, a.prompts);
  } catch (e) {
    judgements = heuristicJudge(listing, a.prompts);
    warning = `${warning ? warning + " " : ""}The retest could not use Claude (${claudeErrorText(e)}), so the projected score uses the keyword fallback and is not comparable.`;
  }
  return {
    listing, changes, needsConfirmation, blocked, newPrompts,
    scorecard: scorecard(listing, a.prompts, judgements, a.agentView.productType || productTypeOf(p)),
    mode: { rewrite: mode, model: mode === "claude" ? MODEL : null }, warning,
  };
}
