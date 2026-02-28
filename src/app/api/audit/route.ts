import { NextRequest, NextResponse } from "next/server";
import { runAgentNativeAudit } from "@/lib/audit";
import type { AuditMode } from "@/lib/audit-types";

type AuditRequestBody = {
  url?: unknown;
  mode?: unknown;
  maxPages?: unknown;
};

function isAuditMode(mode: unknown): mode is AuditMode {
  return mode === "single" || mode === "sitemap";
}

export async function POST(request: NextRequest) {
  let body: AuditRequestBody;

  try {
    body = (await request.json()) as AuditRequestBody;
  } catch {
    return NextResponse.json(
      { error: "Request body must be valid JSON." },
      { status: 400 },
    );
  }

  if (typeof body.url !== "string" || body.url.trim().length === 0) {
    return NextResponse.json(
      { error: "Please provide a valid URL." },
      { status: 400 },
    );
  }

  if (body.mode !== undefined && !isAuditMode(body.mode)) {
    return NextResponse.json(
      { error: 'mode must be "single" or "sitemap".' },
      { status: 400 },
    );
  }

  if (
    body.maxPages !== undefined &&
    (typeof body.maxPages !== "number" ||
      Number.isNaN(body.maxPages) ||
      body.maxPages < 1)
  ) {
    return NextResponse.json(
      { error: "maxPages must be a positive number." },
      { status: 400 },
    );
  }

  try {
    const result = await runAgentNativeAudit(body.url, {
      mode: body.mode,
      maxPages: body.maxPages,
    });
    return NextResponse.json(result, { status: 200 });
  } catch (error) {
    const message = error instanceof Error ? error.message : "Unknown error";
    return NextResponse.json({ error: message }, { status: 400 });
  }
}
