import { NextRequest, NextResponse } from "next/server";

export async function GET(request: NextRequest) {
  const currency = request.nextUrl.searchParams.get("currency")?.toUpperCase() ?? "";
  if (!/^[A-Z]{3}$/.test(currency)) return NextResponse.json({ error:"잘못된 통화 코드입니다." }, { status:400 });
  if (currency === "KRW") return NextResponse.json({ base:"KRW", quote:"KRW", rate:1, date:new Date().toISOString().slice(0,10) });
  try {
    const response = await fetch(`https://api.frankfurter.dev/v2/rate/${currency}/KRW`, { next:{ revalidate:3600 } });
    if (!response.ok) throw new Error(`rate ${response.status}`);
    const data = await response.json() as { date:string; base:string; quote:string; rate:number };
    return NextResponse.json(data, { headers:{ "Cache-Control":"public, s-maxage=3600, stale-while-revalidate=86400" } });
  } catch {
    return NextResponse.json({ error:"환율을 잠시 불러올 수 없습니다." }, { status:502 });
  }
}
