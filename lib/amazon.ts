// Amazon link -> Product, via the Rainforest product-data API (or offline samples / pasted text).
import samples from "@/data/samples.json";
import type { NameValue, Product } from "./types";
import { clean } from "./text";

export class InputError extends Error {}

const ASIN_PATH = /(?:\/dp\/|\/gp\/product\/|\/gp\/aw\/d\/|\/product-reviews\/|\/ASIN\/|\/d\/)([A-Z0-9]{10})(?:[/?#&]|$)/i;
const ASIN_PARAM = /[?&](?:asin|pd_rd_i|creativeASIN)=([A-Z0-9]{10})(?:&|$)/i;
const SHORT_HOSTS = ["amzn.to", "a.co", "amzn.eu", "amzn.asia"];

export type ParsedLink = { url: string; domain: string; asin: string | null; kind: "product" | "category" | "search" | "store" | "short" | "other" };

export function parseAmazonLink(raw: string): ParsedLink {
  let u: URL;
  try {
    u = new URL(raw.trim());
  } catch {
    throw new InputError("That doesn't look like a link. Paste the full Amazon product address, starting with https://");
  }
  const host = u.hostname.toLowerCase().replace(/^www\.|^smile\./, "");
  if (SHORT_HOSTS.includes(host)) return { url: u.toString(), domain: "amazon.com", asin: null, kind: "short" };
  if (!/^amazon\.[a-z.]+$/.test(host)) throw new InputError("Only Amazon product links are supported (amazon.com, amazon.co.uk, ...).");
  const asin = (u.pathname.match(ASIN_PATH) ?? u.search.match(ASIN_PARAM) ?? [])[1]?.toUpperCase() ?? null;
  const p = u.pathname.toLowerCase();
  const kind = asin ? "product" : /(^|\/)b\/?$/.test(p) || u.searchParams.has("node") ? "category"
    : /(^|\/)s\/?$/.test(p) || u.searchParams.has("k") ? "search" : p.includes("/stores/") ? "store" : "other";
  return { url: u.toString(), domain: host, asin, kind };
}

const NOT_PRODUCT: Record<string, string> = {
  category: "That link is an Amazon category page (a list of many products).",
  search: "That link is an Amazon search results page.",
  store: "That link is a brand storefront page.",
  other: "That link doesn't point to a single product.",
};

export async function fetchProduct(raw: string): Promise<Product> {
  const link = parseAmazonLink(raw);
  if (link.kind !== "product" && link.kind !== "short") {
    throw new InputError(`${NOT_PRODUCT[link.kind]} Open one product (its address contains /dp/ followed by a 10-character code) and paste that link.`);
  }
  const key = process.env.RAINFOREST_API_KEY;
  if (!key) {
    const s = (samples as SampleProduct[]).find((x) => x.asin === link.asin);
    if (s) return fromSample(s, link);
    throw new InputError(
      "Reading live Amazon pages needs a RAINFOREST_API_KEY (see README). Until then, try one of the sample products, or paste the listing text.",
    );
  }
  return fetchRainforest(link, key);
}

// ---- Rainforest API (docs: docs.trajectdata.com/rainforestapi/product-data-api) -----------------
type RFNameValue = { name?: string; value?: string };
type RFProduct = {
  asin?: string; link?: string; title?: string; brand?: string; description?: string;
  feature_bullets?: string[]; specifications?: RFNameValue[]; attributes?: RFNameValue[];
  rating?: number; ratings_total?: number; categories?: { name?: string }[]; main_image?: { link?: string };
  buybox_winner?: { price?: { raw?: string; value?: number; symbol?: string } };
};
type RFResponse = { request_info?: { success?: boolean; message?: string }; product?: RFProduct; message?: string; error?: string };

async function fetchRainforest(link: ParsedLink, key: string): Promise<Product> {
  const q = new URLSearchParams({ api_key: key, type: "product" });
  if (link.asin) {
    q.set("asin", link.asin);
    q.set("amazon_domain", link.domain === "amazon.com" || link.kind === "short" ? "amazon.com" : link.domain);
  } else q.set("url", link.url); // short links: let the API resolve them
  let res: Response;
  try {
    res = await fetch(`https://api.rainforestapi.com/request?${q}`, { cache: "no-store", signal: AbortSignal.timeout(45_000) });
  } catch {
    throw new InputError("The product API did not respond in time. Try again in a moment.");
  }
  // The error format is not documented: handle HTTP errors and request_info.success === false.
  const body = (await res.json().catch(() => ({}))) as RFResponse;
  if (!res.ok || body.request_info?.success === false || !body.product?.title) {
    const why = body.request_info?.message || body.message || body.error || `HTTP ${res.status}`;
    if (res.status === 401 || res.status === 403) throw new InputError("The product API rejected the API key. Check RAINFOREST_API_KEY.");
    if (res.status === 402 || res.status === 429) throw new InputError("The product API is out of credits or rate-limited. Try again later.");
    throw new InputError(`Could not read that product (${why}). Check the link, or paste the listing text instead.`);
  }
  const p = body.product;
  const nv = (xs?: RFNameValue[]): NameValue[] =>
    (xs ?? []).filter((x) => x.name && x.value).map((x) => ({ name: clean(x.name), value: clean(x.value) }));
  const specs = nv(p.specifications);
  const attrs = nv(p.attributes);
  const color = [...attrs, ...specs].find((x) => /^colou?r( name)?$/i.test(x.name))?.value ?? "";
  const price = p.buybox_winner?.price;
  return {
    asin: p.asin ?? link.asin, url: p.link ?? link.url, domain: link.domain,
    title: clean(p.title), brand: clean(p.brand), color,
    bullets: (p.feature_bullets ?? []).map(clean).filter(Boolean),
    description: clean(p.description).slice(0, 4000),
    specifications: specs.slice(0, 40), attributes: attrs.slice(0, 20),
    rating: typeof p.rating === "number" ? p.rating : null,
    ratingsTotal: typeof p.ratings_total === "number" ? p.ratings_total : null,
    price: price?.raw ?? (price?.value != null ? `${price.symbol ?? "$"}${price.value}` : null),
    categories: (p.categories ?? []).map((c) => clean(c.name)).filter(Boolean),
    image: p.main_image?.link ?? null, source: "rainforest",
  };
}

// ---- offline samples (real ESCI listings) --------------------------------------------------------
type SampleProduct = { asin: string; title: string; brand: string; color: string; bullets: string[]; description: string };
export const SAMPLES = (samples as SampleProduct[]).map((s) => ({ asin: s.asin, title: s.title, url: `https://www.amazon.com/dp/${s.asin}` }));

function fromSample(s: SampleProduct, link: ParsedLink): Product {
  return {
    asin: s.asin, url: link.url, domain: "amazon.com", title: s.title, brand: s.brand, color: s.color,
    bullets: s.bullets, description: s.description, specifications: [], attributes: [], rating: null,
    ratingsTotal: null, price: null, categories: [], image: null, source: "sample",
  };
}

// ---- pasted listing text ---------------------------------------------------------------------------
const LABELS: Record<string, keyof Product | "bullets"> = {
  title: "title", name: "title", "product name": "title", brand: "brand", color: "color", colour: "color",
  description: "description", "about this item": "bullets", bullets: "bullets", features: "bullets",
};

export function fromText(text: string): Product {
  const p: Product = {
    asin: null, url: null, domain: "amazon.com", title: "", brand: "", color: "", bullets: [], description: "",
    specifications: [], attributes: [], rating: null, ratingsTotal: null, price: null, categories: [], image: null, source: "pasted",
  };
  const desc: string[] = [];
  let section: "bullets" | "description" | null = null;
  for (const raw of text.split(/\r?\n/)) {
    const line = raw.trim();
    if (!line) continue;
    const m = line.match(/^([A-Za-z][A-Za-z /]{1,28}):\s*(.*)$/);
    const slot = m ? LABELS[m[1].trim().toLowerCase()] : undefined;
    if (m && slot) {
      const v = m[2].trim();
      if (slot === "bullets") { section = "bullets"; if (v) p.bullets.push(v); }
      else if (slot === "description") { section = "description"; if (v) desc.push(v); }
      else { (p[slot] as string) = v; section = null; }
      continue;
    }
    if (m && m[2].length < 80) { p.specifications.push({ name: m[1].trim(), value: m[2].trim() }); continue; }
    const bullet = line.match(/^(?:[-*•·]|\d+[.)])\s+(.*)$/);
    if (bullet || section === "bullets") { p.bullets.push((bullet ? bullet[1] : line).trim()); continue; }
    if (!p.title) p.title = line; else desc.push(line);
  }
  p.description = desc.join(" ");
  if (!p.title) throw new InputError("Paste at least the product title.");
  if (p.title.length > 250 && !p.description) { p.description = p.title; p.title = p.title.split(/(?<=[.!?])\s/)[0].slice(0, 200); }
  return p;
}

/** Text an AI agent can see on the page, used for grounding checks. */
export function pageText(p: Product): string {
  return [p.title, p.brand, p.color, ...p.bullets, p.description,
    ...p.specifications.map((s) => `${s.name}: ${s.value}`), ...p.attributes.map((s) => `${s.name}: ${s.value}`)].join("\n");
}
