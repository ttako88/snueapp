// maintenance Route (Vercel Cron GET 진입점). 실제 deps를 코어에 주입하는 얇은 어댑터.
// GPT §4: GET만 구현(다른 메서드는 Next 기본 405), runtime='nodejs'(Node crypto·Supabase Admin),
//   응답 Cache-Control: no-store, body 미독. force-dynamic은 강제하지 않음 — headers 참조로 자동 동적.
//   응답에 사용자 ID·Storage path·DB 오류 원문·secret·project ref 미포함.
import { NextResponse } from "next/server";
import { handleMaintenance } from "../../lib/server/maintenance/core.mjs";
import { createServiceClient } from "../../lib/server/maintenance/serviceClient.mjs";
import { withLease } from "../../lib/server/maintenance/lease.mjs";
import { runJob } from "../../lib/server/maintenance/jobs/registry.mjs";

export const runtime = "nodejs";
export const maxDuration = 60;

export async function GET(request) {
  const authHeader = request.headers.get("authorization");
  const job = new URL(request.url).searchParams.get("job");

  const { status, body } = await handleMaintenance(
    { authHeader, job },
    { env: process.env, createServiceClient, withLease, runJob, leaseTtlSec: 120, budgetMs: 60000 }
  );

  const res = body === null ? new NextResponse(null, { status }) : NextResponse.json(body, { status });
  res.headers.set("Cache-Control", "no-store");
  return res;
}
