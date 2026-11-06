// Shared types for AgentReady (Vercel / Next.js version).

export type NameValue = { name: string; value: string };

/** Canonical product listing: only what is shown on the Amazon product page. */
export type Product = {
  asin: string | null;
  url: string | null;
  domain: string;
  title: string;
  brand: string;
  color: string;
  bullets: string[];
  description: string;
  specifications: NameValue[]; // product details / technical tables
  attributes: NameValue[]; // attribute chips shown under the title
  rating: number | null;
  ratingsTotal: number | null;
  price: string | null;
  categories: string[];
  image: string | null;
  source: "rainforest" | "sample" | "pasted";
};

export type EsciLabel = "E" | "S" | "C" | "I";

/** What an AI shopping agent would pull out of the page. */
export type AgentFact = { name: string; value: string; source: string; verified: boolean };
export type AgentView = {
  productType: string;
  summary: string; // what an AI shopper would tell a customer about this product
  facts: AgentFact[];
  useCases: string[];
  audience: string[];
  missing: { info: string; why: string }[];
};

/** A shopper prompt the product is tested against. */
export type ShopperPrompt = {
  id: string;
  prompt: string;
  style: "conversational" | "keyword";
  origin: "esci" | "generated"; // esci = a real Amazon shopper query from the ESCI dataset
  intent: string;
};

export type Constraint = { key: string; value: string };

/** Relevance judgement of one listing for one prompt (ESCI definitions). */
export type Judgement = {
  promptId: string;
  label: EsciLabel;
  relevance: number; // 0-100
  constraints: Constraint[];
  reason: string;
};

export type AttrStatus = "Known" | "Not exposed" | "Unknown";
export type AttrCheck = Constraint & { status: AttrStatus; credit: number; field: string | null; evidence: string };
export type Check = { name: string; pass: boolean; detail: string };

export type PromptScore = {
  prompt: ShopperPrompt;
  judgement: Judgement;
  R: number;
  A: number | null;
  C: number;
  M: number;
  weights: { R: number; A: number; C: number; M: number };
  contrib: { R: number; A: number; C: number; M: number };
  V: number;
  attributes: AttrCheck[];
  matchedTerms: { term: string; where: string[] }[];
};

export type SeoScore = { score: number; checks: (Check & { points: number; max: number })[]; keywords: { term: string; inTitle: boolean; inBullets: boolean; inDescription: boolean }[] };

export type Scorecard = {
  visibility: number;
  contrib: { R: number; A: number; C: number; M: number };
  max: { R: number; A: number; C: number; M: number };
  renormalized: number;
  seo: SeoScore;
  clarity: Check[];
  metadata: { field: string; present: boolean }[];
  prompts: PromptScore[];
};

export type Analysis = {
  product: Product;
  agentView: AgentView;
  prompts: ShopperPrompt[];
  esciMatches: string[];
  scorecard: Scorecard;
  mode: { judge: "claude" | "heuristic"; model: string | null; data: Product["source"] };
  createdAt: string;
};

export type Change = { field: string; before: string; after: string; why: string; source: string };

export type Proposal = {
  listing: Product;
  changes: Change[];
  needsConfirmation: { question: string; wouldAdd: string }[];
  blocked: string[];
  newPrompts: { prompt: string; why: string }[];
  scorecard: Scorecard; // same prompts, same scoring, improved listing
  mode: { rewrite: "claude" | "rule-based"; model: string | null };
};
