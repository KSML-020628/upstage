import { NextResponse } from "next/server";
import { loadCostOfLivingSnapshot } from "../../lib/cost-of-living";

export async function GET() {
  const snapshot = await loadCostOfLivingSnapshot();
  return NextResponse.json(snapshot, {
    headers: { "Cache-Control": snapshot.fallback ? "public, s-maxage=3600, stale-while-revalidate=86400" : "public, s-maxage=86400, stale-while-revalidate=604800" },
  });
}
