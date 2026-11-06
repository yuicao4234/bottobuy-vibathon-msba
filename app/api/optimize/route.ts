import type { Analysis } from "@/lib/types";
import { optimize } from "@/lib/pipeline";

export const maxDuration = 60;

export async function POST(req: Request) {
  const raw = await req.text();
  if (raw.length > 400_000) return Response.json({ error: "Request too large." }, { status: 413 });
  let a: Analysis;
  try {
    a = JSON.parse(raw).analysis;
    if (!a?.product?.title || !Array.isArray(a.prompts) || !a.scorecard?.prompts) throw new Error();
  } catch {
    return Response.json({ error: "Send { analysis } from /api/analyze." }, { status: 400 });
  }
  try {
    return Response.json(await optimize(a));
  } catch (e) {
    console.error(e);
    return Response.json({ error: "Could not generate improvements. Try again." }, { status: 500 });
  }
}
