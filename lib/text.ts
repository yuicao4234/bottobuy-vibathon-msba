// Tokenising shared by retrieval, scoring and guards (port of app/common.py).

export const STOP = new Set(
  ("a an the for under over get buy i me my need want to of and with in on order is that some any or less than " +
    "find looking please can you it its this these those good best by from at as be are was were will your our " +
    "their pack set piece pcs what which who should recommend recommendation something")
    .split(" "),
);

export function stem(w: string): string {
  if (w.length > 4 && w.endsWith("ies")) return w.slice(0, -3) + "y";
  if (w.length > 3 && w.endsWith("s") && !w.endsWith("ss")) return w.slice(0, -1);
  return w;
}

export function tokens(s: string | null | undefined): string[] {
  return (String(s ?? "").toLowerCase().match(/[a-z0-9]+(?:\.[0-9]+)?/g) ?? []).map(stem);
}

export function contentTokens(s: string | null | undefined): string[] {
  return tokens(s).filter((w) => !STOP.has(w));
}

export const uniq = <T,>(xs: T[]) => [...new Set(xs)];
export const round1 = (x: number) => Math.round(x * 10) / 10;
export const clean = (s: unknown) => String(s ?? "").replace(/\s+/g, " ").trim();

export function sentences(text: string): string[] {
  return text.split(/(?<=[.!?])\s+|\n+/).map((s) => s.trim()).filter(Boolean);
}

/** Whole-word, case-insensitive containment (handles multi-word values). */
export function hasPhrase(text: string, phrase: string): boolean {
  const p = phrase.trim().toLowerCase();
  if (!p) return false;
  const esc = p.replace(/[.*+?^${}()|[\]\\]/g, "\\$&").replace(/\s+/g, "\\s+");
  return new RegExp(`(^|[^a-z0-9])${esc}s?([^a-z0-9]|$)`, "i").test(text);
}

// ---- numbers with units ("32 oz", "pack of 2", "12 inch") -------------------------------------
const UNITS: Record<string, string> = {
  inch: "in", inches: "in", in: "in", '"': "in", ft: "ft", foot: "ft", feet: "ft", oz: "oz", ounce: "oz",
  ounces: "oz", fl: "oz", lb: "lb", lbs: "lb", pound: "lb", pounds: "lb", ml: "ml", l: "l", liter: "l",
  litre: "l", gallon: "gal", gal: "gal", gb: "gb", tb: "tb", mm: "mm", cm: "cm", m: "m", w: "w", watt: "w",
  watts: "w", v: "v", volt: "v", mah: "mah", pack: "pack", pk: "pack", count: "count", ct: "count", pcs: "pc",
  pc: "pc", piece: "pc", pieces: "pc", qt: "qt", quart: "qt",
};
const UNIT_RE = new RegExp(
  `(\\d+(?:\\.\\d+)?)\\s*-?\\s*(${Object.keys(UNITS).sort((a, b) => b.length - a.length).map((u) => u.replace(/"/, '\\"')).join("|")})\\b`,
  "gi",
);
export function numUnits(text: string): Set<string> {
  const out = new Set<string>();
  for (const m of String(text).toLowerCase().matchAll(UNIT_RE)) out.add(`${parseFloat(m[1])} ${UNITS[m[2]]}`);
  for (const m of String(text).toLowerCase().matchAll(/(?:pack|set|box) of (\d+)/g)) out.add(`${parseFloat(m[1])} pack`);
  return out;
}
