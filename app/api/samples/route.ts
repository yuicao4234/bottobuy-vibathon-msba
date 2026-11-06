import { connection } from "next/server";
import { SAMPLES } from "@/lib/amazon";
import { claudeEnabled, MODEL } from "@/lib/claude";
import { ESCI_QUERY_COUNT } from "@/lib/esci";

export async function GET() {
  await connection(); // read env vars at request time, so adding keys on Vercel takes effect without a rebuild
  return Response.json({
    samples: SAMPLES,
    liveAmazon: !!process.env.RAINFOREST_API_KEY,
    claude: claudeEnabled() ? MODEL : null,
    esciQueries: ESCI_QUERY_COUNT,
  });
}
