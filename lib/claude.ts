// Claude calls: (1) read the page like an AI shopping agent and propose shopper prompts,
// (2) judge listing-vs-prompt relevance with ESCI's E/S/C/I definitions, (3) rewrite the listing.
// Every call uses structured output, so the app always gets valid JSON or a clear failure.
import Anthropic from "@anthropic-ai/sdk";
import { betaZodOutputFormat } from "@anthropic-ai/sdk/helpers/beta/zod";
import { z } from "zod";
import type { Product, ShopperPrompt } from "./types";
import { ESCI_EXAMPLES } from "./esci";
import { pageText } from "./amazon";

export const MODEL = "claude-opus-5-5";
export const claudeEnabled = () => !!process.env.ANTHROPIC_API_KEY;

let client: Anthropic | null = null;
const getClient = () => (client ??= new Anthropic({ timeout: 55_000, maxRetries: 1 }));

async function call<T extends z.ZodType>(schema: T, system: string, user: string): Promise<z.infer<T>> {
  const res = await getClient().beta.messages.parse({
    model: MODEL,
    max_tokens: 8000,
    system,
    messages: [{ role: "user", content: user }],
    output_config: { effort: "low", format: betaZodOutputFormat(schema) },
    betas: ["server-side-fallback-2026-07-01"],
    fallbacks: "default", // re-run on a fallback model if the request is declined by a safety classifier
  });
  if (res.stop_reason === "refusal") throw new Error("Claude declined this request.");
  if (res.stop_reason === "max_tokens") throw new Error("Claude's answer was cut off.");
  if (!res.parsed_output) throw new Error("Claude returned an unexpected format.");
  return res.parsed_output as z.infer<T>;
}

function listingBlock(p: Product): string {
  return [
    `TITLE: ${p.title}`,
    `BRAND: ${p.brand || "(none)"}`,
    p.color && `COLOR: ${p.color}`,
    p.price && `PRICE: ${p.price}`,
    p.rating != null && `RATING: ${p.rating}/5 from ${p.ratingsTotal ?? "?"} ratings`,
    p.categories.length && `CATEGORY: ${p.categories.join(" > ")}`,
    `BULLETS:\n${p.bullets.map((b) => `- ${b}`).join("\n") || "(none)"}`,
    `DESCRIPTION: ${p.description || "(none)"}`,
    (p.specifications.length || p.attributes.length) &&
      `DETAILS:\n${[...p.attributes, ...p.specifications].map((s) => `- ${s.name}: ${s.value}`).join("\n")}`,
  ].filter(Boolean).join("\n");
}

// ---- 1) agent view + shopper prompts ----------------------------------------------------------------
const UnderstandSchema = z.object({
  product_type: z.string(),
  summary: z.string(),
  facts: z.array(z.object({ name: z.string(), value: z.string(), source: z.string() })),
  use_cases: z.array(z.string()),
  audience: z.array(z.string()),
  missing: z.array(z.object({ info: z.string(), why: z.string() })),
  conversational_prompts: z.array(z.object({ prompt: z.string(), intent: z.string() })),
  keyword_queries: z.array(z.object({ query: z.string(), from_esci: z.boolean() })),
});

export async function understand(p: Product, esciQueries: string[]) {
  const system = `You are an AI shopping agent reading one Amazon product page on behalf of shoppers.
Report only what the page states. Never invent specs, sizes, materials, certifications or claims.
For each fact, give the field it came from (title, bullets, description, details, brand).`;
  const user = `PRODUCT PAGE:\n${listingBlock(p)}

REAL AMAZON SHOPPER QUERIES (from the Amazon ESCI dataset) that look related:
${esciQueries.map((q) => `- ${q}`).join("\n") || "(none found)"}

Return:
- product_type: 1-4 words, what the product is.
- summary: 2-3 sentences an AI assistant would tell a shopper about this product, using only page facts.
- facts: the 6-15 most decision-relevant facts an agent would extract (size, material, compatibility, quantity, audience, key features).
- use_cases, audience: as stated or clearly implied by the page.
- missing: up to 6 pieces of information shoppers commonly need for this kind of product that the page does NOT state, and why each matters.
- conversational_prompts: 5 natural requests a shopper might type into an AI assistant (ChatGPT, Rufus, Gemini) when looking for this kind of product. Mix exact needs and related needs. Do not mention the brand.
- keyword_queries: 5 short Amazon search queries. Prefer copying real ESCI queries from the list above (from_esci=true, copy exactly); otherwise write ones in the same style (from_esci=false).`;
  return call(UnderstandSchema, system, user);
}

// ---- 2) relevance judge (ESCI definitions) -----------------------------------------------------------
const JudgeSchema = z.object({
  judgements: z.array(z.object({
    id: z.string(),
    label: z.enum(["E", "S", "C", "I"]),
    relevance: z.number(),
    constraints: z.array(z.object({ key: z.string(), value: z.string() })),
    reason: z.string(),
  })),
});

export async function judge(p: Product, prompts: ShopperPrompt[]) {
  const ex = ESCI_EXAMPLES.map((e) => `- [${e.label}] query "${e.query}" -> "${e.product_title}"`).join("\n");
  const system = `You grade how well one product listing satisfies shopper requests, using the Amazon ESCI labels:
E (Exact): the product satisfies the request and all its stated constraints.
S (Substitute): it is not exactly what was asked but could replace it (e.g. different size, flavor, brand).
C (Complement): it does not satisfy the request but is used together with what was asked (accessory, part, refill).
I (Irrelevant): it does not fit the request.
Judge ONLY from what the listing states; if a constraint is not stated, the listing cannot be credited for it.
Labelled examples from the ESCI dataset:\n${ex}`;
  const user = `LISTING:\n${listingBlock(p)}

REQUESTS:\n${prompts.map((q) => `[${q.id}] ${q.prompt}`).join("\n")}

For every request return: id; label (E/S/C/I); relevance 0-100 (E roughly 70-100, S 40-75, C 15-45, I 0-20, higher when the listing states the facts clearly); constraints = the specific attributes the request asks for (key like Color, Size, Material, Audience, Quantity, Compatibility, Feature; value in the shopper's words, at most 4); reason = one sentence.`;
  const out = await call(JudgeSchema, system, user);
  return out.judgements;
}

// ---- 3) grounded rewrite --------------------------------------------------------------------------------
const RewriteSchema = z.object({
  title: z.string(),
  bullets: z.array(z.string()),
  description: z.string(),
  details_to_add: z.array(z.object({ name: z.string(), value: z.string(), source_quote: z.string() })),
  changes: z.array(z.object({ field: z.string(), why: z.string(), source_quote: z.string() })),
  needs_confirmation: z.array(z.object({ question: z.string(), would_add: z.string() })),
  new_prompts: z.array(z.object({ prompt: z.string(), why: z.string() })),
});

export async function rewrite(p: Product, weak: { prompt: string; issues: string[] }[], missing: string[]) {
  const system = `You improve an Amazon listing so AI shopping agents and Amazon search understand it better.
Use ONLY facts stated on the current page. Never add numbers, materials, sizes, certifications, benefits or claims
that are not on the page, and never strengthen a claim (water resistant is not waterproof).
If a shopper need could be met only with a fact that is not on the page, put it in needs_confirmation instead.`;
  const user = `CURRENT PAGE:\n${listingBlock(p)}

WEAKEST SHOPPER REQUESTS AND WHY:
${weak.map((w) => `- "${w.prompt}": ${w.issues.join("; ")}`).join("\n")}

INFORMATION SHOPPERS NEED THAT THE PAGE DOESN'T STATE:
${missing.map((m) => `- ${m}`).join("\n") || "(none)"}

Return:
- title: under 200 characters, brand first, then product type, then the most-asked attributes the page supports.
- bullets: 5 scannable bullets, each starting with a short CAPS label, facts from the page only.
- description: 2-4 sentences, facts from the page only.
- details_to_add: structured details (name/value) that are stated somewhere on the page but not in its details table, with the exact quote that supports each.
- changes: what you changed and why, each with the exact page quote that supports it.
- needs_confirmation: facts shoppers ask for that only the seller can confirm (a question, and what would be added).
- new_prompts: 4 shopper requests this improved listing would now answer well, and why.`;
  return call(RewriteSchema, system, user);
}

/** Short, user-facing reason for a failed Claude call (typed SDK errors, most specific first). */
export function claudeErrorText(e: unknown): string {
  if (e instanceof Anthropic.AuthenticationError) return "the Claude API key was rejected";
  if (e instanceof Anthropic.PermissionDeniedError) return "the Claude API key lacks permission";
  if (e instanceof Anthropic.RateLimitError) return "Claude is rate-limited right now";
  if (e instanceof Anthropic.APIConnectionTimeoutError) return "Claude took too long to answer";
  if (e instanceof Anthropic.APIConnectionError) return "Claude could not be reached";
  if (e instanceof Anthropic.APIError) return `Claude API error ${e.status ?? ""}`.trim();
  return (e as Error)?.message || "unknown error";
}

export { pageText };
