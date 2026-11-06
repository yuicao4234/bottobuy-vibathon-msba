import { InputError, fetchProduct, fromText } from "@/lib/amazon";
import { analyze } from "@/lib/pipeline";

export const maxDuration = 60; // Claude + product API; raise on Vercel Pro if needed

export async function POST(req: Request) {
  let body: { url?: string; text?: string };
  try {
    body = await req.json();
  } catch {
    return Response.json({ error: "Send JSON: { url } or { text }." }, { status: 400 });
  }
  try {
    const product = body.text?.trim() ? fromText(body.text.slice(0, 20_000)) : await fetchProduct(String(body.url ?? ""));
    return Response.json(await analyze(product));
  } catch (e) {
    if (e instanceof InputError) return Response.json({ error: e.message }, { status: 422 });
    console.error(e);
    return Response.json({ error: "Something went wrong while analyzing. Try again." }, { status: 500 });
  }
}
