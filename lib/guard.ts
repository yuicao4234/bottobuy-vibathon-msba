// Grounding guards: nothing the tool proposes may add claims the product page does not support.
import { contentTokens, tokens } from "./text";

const RISKY = ["organic", "vegan", "waterproof", "hypoallergenic", "dermatologist", "fda", "clinically", "paraben",
  "sulfate", "cruelty", "certified", "guaranteed", "non-toxic", "bpa", "unscented", "fragrance-free", "natural",
  "best", "#1", "patented", "award", "warranty", "lifetime", "eco", "recyclable", "medical", "cure"];

/** Risky words and numbers in `text` that do not appear in `source`. */
export function unsupportedClaims(text: string, source: string): string[] {
  const s = source.toLowerCase(), t = text.toLowerCase();
  const bad = RISKY.filter((w) => t.includes(w) && !s.includes(w));
  for (const n of t.match(/\d+(?:\.\d+)?/g) ?? []) if (!s.includes(n)) bad.push(n);
  return [...new Set(bad)];
}

/** A fact is "verified" when most of its value's words appear on the page. */
export function grounded(value: string, source: string): boolean {
  const vt = contentTokens(value);
  if (!vt.length) return false;
  const st = new Set(tokens(source));
  return vt.filter((w) => st.has(w)).length / vt.length >= 0.6 && unsupportedClaims(value, source).length === 0;
}
