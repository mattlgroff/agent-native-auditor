"use client";

import { FormEvent, useEffect, useMemo, useState } from "react";
import {
  AuditMode,
  AuditResult,
  AuditStatus,
  CrawlPageReport,
} from "@/lib/audit-types";

type ApiError = {
  error?: string;
};

type AuditHistoryItem = {
  target: string;
  checkedAt: string;
  score: number;
  maxScore: number;
  mode: AuditMode;
  durationMs: number;
};

const HISTORY_STORAGE_KEY = "agent-native-auditor:history";

const statusCopy: Record<AuditStatus, string> = {
  pass: "Pass",
  warn: "Needs Work",
  fail: "Fail",
};

const statusClassName: Record<AuditStatus, string> = {
  pass: "border-emerald-300 bg-emerald-50 text-emerald-800",
  warn: "border-amber-300 bg-amber-50 text-amber-900",
  fail: "border-rose-300 bg-rose-50 text-rose-900",
};

function buildVercelDeployUrl(repoUrl: string | undefined): string {
  if (!repoUrl) {
    return "https://vercel.com/new";
  }

  try {
    const params = new URLSearchParams({
      "repository-url": repoUrl,
      "project-name": "agent-native-auditor",
      "repository-name": "agent-native-auditor",
    });

    return `https://vercel.com/new/clone?${params.toString()}`;
  } catch {
    return "https://vercel.com/new";
  }
}

function scorePercent(score: number, maxScore: number): number {
  if (maxScore <= 0) return 0;
  return Math.round((score / maxScore) * 100);
}

function formatDuration(durationMs: number): string {
  if (durationMs < 1000) return `${durationMs} ms`;
  return `${(durationMs / 1000).toFixed(1)} s`;
}

function statusBadgeClass(passed: boolean): string {
  return passed
    ? "border-emerald-300 bg-emerald-50 text-emerald-800"
    : "border-zinc-300 bg-zinc-100 text-zinc-700";
}

function StatusCell({ passed }: { passed: boolean }) {
  return (
    <span
      className={`inline-flex rounded-full border px-2 py-0.5 text-xs font-medium ${statusBadgeClass(passed)}`}
    >
      {passed ? "Yes" : "No"}
    </span>
  );
}

function pageIssueCount(page: CrawlPageReport): number {
  return [
    page.htmlOk,
    page.markdownOk,
    page.hasHeadHints,
    page.hasStructuredData,
  ].filter(Boolean).length;
}

function updateHistory(
  existing: AuditHistoryItem[],
  result: AuditResult,
): AuditHistoryItem[] {
  const nextItem: AuditHistoryItem = {
    target: result.target,
    checkedAt: result.checkedAt,
    score: result.score,
    maxScore: result.maxScore,
    mode: result.crawl.mode,
    durationMs: result.durationMs,
  };

  const deduped = existing.filter(
    (item) =>
      !(
        item.target === nextItem.target && item.checkedAt === nextItem.checkedAt
      ),
  );

  return [nextItem, ...deduped].slice(0, 8);
}

export function AuditDashboard() {
  const [url, setUrl] = useState("https://");
  const [mode, setMode] = useState<AuditMode>("sitemap");
  const [isLoading, setIsLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [result, setResult] = useState<AuditResult | null>(null);
  const [history, setHistory] = useState<AuditHistoryItem[]>([]);

  const percentage = useMemo(() => {
    if (!result) return 0;
    return scorePercent(result.score, result.maxScore);
  }, [result]);

  const previousResultForTarget = useMemo(() => {
    if (!result) return null;
    return (
      history.find(
        (item) =>
          item.target === result.target && item.checkedAt !== result.checkedAt,
      ) ?? null
    );
  }, [history, result]);

  const deltaFromPrevious = useMemo(() => {
    if (!result || !previousResultForTarget) return null;
    const currentPct = scorePercent(result.score, result.maxScore);
    const previousPct = scorePercent(
      previousResultForTarget.score,
      previousResultForTarget.maxScore,
    );
    return currentPct - previousPct;
  }, [previousResultForTarget, result]);

  const deployUrl = useMemo(
    () => buildVercelDeployUrl(process.env.NEXT_PUBLIC_GITHUB_REPO_URL),
    [],
  );

  useEffect(() => {
    try {
      const raw = localStorage.getItem(HISTORY_STORAGE_KEY);
      if (!raw) return;
      const parsed = JSON.parse(raw) as AuditHistoryItem[];
      if (Array.isArray(parsed)) {
        setHistory(parsed.slice(0, 8));
      }
    } catch {
      setHistory([]);
    }
  }, []);

  useEffect(() => {
    if (!result) return;

    setHistory((prev) => {
      const next = updateHistory(prev, result);
      localStorage.setItem(HISTORY_STORAGE_KEY, JSON.stringify(next));
      return next;
    });
  }, [result]);

  async function runAudit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    setIsLoading(true);
    setError(null);
    setResult(null);

    try {
      const response = await fetch("/api/audit", {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
        },
        body: JSON.stringify({
          url,
          mode,
        }),
      });

      if (!response.ok) {
        const payload = (await response.json()) as ApiError;
        throw new Error(payload.error ?? "Audit failed.");
      }

      const payload = (await response.json()) as AuditResult;
      setResult(payload);
    } catch (requestError) {
      setError(
        requestError instanceof Error
          ? requestError.message
          : "Unexpected error running audit.",
      );
    } finally {
      setIsLoading(false);
    }
  }

  function downloadReport() {
    if (!result) return;
    const blob = new Blob([JSON.stringify(result, null, 2)], {
      type: "application/json;charset=utf-8",
    });
    const objectUrl = URL.createObjectURL(blob);
    const anchor = document.createElement("a");
    const hostname = new URL(result.target).hostname.replace(
      /[^a-zA-Z0-9.-]/g,
      "-",
    );
    anchor.href = objectUrl;
    anchor.download = `agent-native-audit-${hostname}-${Date.now()}.json`;
    anchor.click();
    URL.revokeObjectURL(objectUrl);
  }

  return (
    <main className="mx-auto flex min-h-screen w-full max-w-6xl flex-col px-5 py-10 sm:px-8 sm:py-14 lg:px-10">
      <section className="rounded-3xl border border-zinc-200 bg-white/90 p-6 shadow-sm backdrop-blur sm:p-10">
        <div className="mb-6 flex flex-col gap-4 sm:flex-row sm:items-start sm:justify-between">
          <div className="max-w-3xl">
            <p className="inline-flex w-fit rounded-full bg-blue-50 px-3 py-1 text-xs font-semibold tracking-wide text-blue-800">
              Agent Native Auditor
            </p>
            <h1 className="mt-3 text-3xl font-semibold tracking-tight text-zinc-900 sm:text-4xl">
              Audit any site for agent-native web readiness
            </h1>
            <p className="mt-3 text-sm leading-6 text-zinc-600 sm:text-base">
              Run a diagnostic for discovery files, markdown negotiation, SEO
              crawl surfaces, structured data, and WebMCP-related signals.
            </p>
          </div>

          <a
            href={deployUrl}
            target="_blank"
            rel="noreferrer"
            className="inline-flex h-10 shrink-0 items-center rounded-lg border border-zinc-300 bg-zinc-50 px-4 text-sm font-medium text-zinc-700 transition hover:bg-zinc-100"
          >
            Deploy This Auditor
          </a>
        </div>

        <form onSubmit={runAudit} className="space-y-4">
          <div className="flex flex-col gap-3 sm:flex-row sm:items-center">
            <label htmlFor="target-url" className="sr-only">
              Website URL
            </label>
            <input
              id="target-url"
              type="text"
              value={url}
              onChange={(event) => setUrl(event.target.value)}
              placeholder="https://example.com"
              className="h-12 w-full rounded-xl border border-zinc-300 bg-white px-4 text-sm text-zinc-900 outline-none ring-blue-500 transition placeholder:text-zinc-400 focus:ring-2"
            />
            <button
              type="submit"
              disabled={isLoading}
              className="h-12 shrink-0 rounded-xl bg-zinc-900 px-6 text-sm font-semibold text-white transition hover:bg-zinc-700 disabled:cursor-not-allowed disabled:bg-zinc-500"
            >
              {isLoading ? "Auditing..." : "Run Audit"}
            </button>
          </div>

          <div className="flex flex-col gap-3 rounded-xl border border-zinc-200 bg-zinc-50/80 p-4 sm:flex-row sm:items-center sm:justify-between">
            <div className="flex flex-wrap items-center gap-4">
              <label className="inline-flex items-center gap-2 text-sm text-zinc-700">
                <input
                  type="radio"
                  name="audit-mode"
                  value="single"
                  checked={mode === "single"}
                  onChange={() => setMode("single")}
                />
                Single-page mode
              </label>
              <label className="inline-flex items-center gap-2 text-sm text-zinc-700">
                <input
                  type="radio"
                  name="audit-mode"
                  value="sitemap"
                  checked={mode === "sitemap"}
                  onChange={() => setMode("sitemap")}
                />
                Sitemap crawl mode
              </label>
            </div>

            <span className="text-sm text-zinc-600">
              Sitemap mode crawls all sitemap URLs by default.
            </span>
          </div>
        </form>

        <div className="mt-4 text-xs text-zinc-500 sm:text-sm">
          Best for public websites. Sitemap crawl mode checks wider page
          coverage when `sitemap.xml` is available.
        </div>
      </section>

      {history.length > 0 && (
        <section className="mt-6 rounded-2xl border border-zinc-200 bg-white p-4 shadow-sm sm:p-5">
          <h2 className="text-sm font-semibold text-zinc-800">Recent Audits</h2>
          <div className="mt-3 grid gap-2">
            {history.map((item) => (
              <button
                key={`${item.target}-${item.checkedAt}`}
                onClick={() => {
                  setUrl(item.target);
                  setMode(item.mode);
                }}
                className="flex w-full flex-wrap items-center justify-between gap-2 rounded-lg border border-zinc-200 bg-zinc-50 px-3 py-2 text-left text-xs text-zinc-700 transition hover:bg-zinc-100"
                type="button"
              >
                <span className="max-w-[55%] truncate font-medium">
                  {item.target}
                </span>
                <span>{item.mode}</span>
                <span>{scorePercent(item.score, item.maxScore)}%</span>
                <span>{formatDuration(item.durationMs)}</span>
              </button>
            ))}
          </div>
        </section>
      )}

      {error && (
        <section className="mt-6 rounded-2xl border border-rose-200 bg-rose-50 p-4 text-sm text-rose-800">
          {error}
        </section>
      )}

      {result && (
        <section className="mt-6 space-y-6">
          <div className="rounded-3xl border border-zinc-200 bg-white p-6 shadow-sm sm:p-8">
            <div className="flex flex-col gap-4 sm:flex-row sm:items-end sm:justify-between">
              <div>
                <h2 className="text-2xl font-semibold text-zinc-900">
                  Audit Results
                </h2>
                <p className="mt-1 text-sm text-zinc-600">{result.target}</p>
                <p className="mt-1 text-xs text-zinc-500">
                  Checked {new Date(result.checkedAt).toLocaleString()}
                </p>
                <p className="mt-1 text-xs text-zinc-500">
                  Mode:{" "}
                  <strong className="font-medium text-zinc-700">
                    {result.crawl.mode}
                  </strong>{" "}
                  | Sitemap used:{" "}
                  <strong className="font-medium text-zinc-700">
                    {result.crawl.usedSitemap ? "yes" : "no"}
                  </strong>
                </p>
                <p className="mt-1 text-xs text-zinc-500">
                  Pages discovered: {result.crawl.pagesDiscovered} | Pages
                  audited: {result.crawl.pagesAudited} | Runtime:{" "}
                  {formatDuration(result.durationMs)}
                </p>
                {deltaFromPrevious !== null && (
                  <p className="mt-1 text-xs text-zinc-500">
                    Delta from previous run:{" "}
                    <strong
                      className={
                        deltaFromPrevious >= 0
                          ? "text-emerald-700"
                          : "text-rose-700"
                      }
                    >
                      {deltaFromPrevious >= 0 ? "+" : ""}
                      {deltaFromPrevious}%
                    </strong>
                  </p>
                )}
              </div>
              <div className="flex items-end gap-3">
                <button
                  onClick={downloadReport}
                  className="h-10 rounded-lg border border-zinc-300 bg-zinc-50 px-3 text-xs font-semibold text-zinc-700 transition hover:bg-zinc-100"
                  type="button"
                >
                  Download JSON
                </button>
                <div className="rounded-2xl border border-zinc-200 bg-zinc-50 px-5 py-4 text-right">
                  <p className="text-xs font-medium uppercase tracking-wide text-zinc-500">
                    Score
                  </p>
                  <p className="text-3xl font-semibold text-zinc-900">
                    {percentage}%
                  </p>
                  <p className="text-xs text-zinc-500">
                    {result.score} / {result.maxScore}
                  </p>
                </div>
              </div>
            </div>

            {result.crawl.sampledUrls.length > 0 && (
              <div className="mt-4 rounded-xl border border-zinc-200 bg-zinc-50 p-3">
                <p className="text-xs font-semibold uppercase tracking-wide text-zinc-500">
                  Sampled URLs
                </p>
                <ul className="mt-2 flex flex-wrap gap-2">
                  {result.crawl.sampledUrls.slice(0, 12).map((sampleUrl) => (
                    <li
                      key={sampleUrl}
                      className="rounded-md bg-white px-2 py-1 text-xs text-zinc-700 ring-1 ring-zinc-200"
                    >
                      {sampleUrl}
                    </li>
                  ))}
                </ul>
              </div>
            )}
          </div>

          {result.crawl.pageReports.length > 0 && (
            <div className="rounded-2xl border border-zinc-200 bg-white p-4 shadow-sm sm:p-6">
              <h3 className="text-lg font-semibold text-zinc-900">
                Per-Page Crawl Signals
              </h3>
              <p className="mt-1 text-xs text-zinc-500">
                Quick page-level diagnostics for sitemap sample URLs. Rows with
                lower signal counts are likely where to start debugging.
              </p>
              <div className="mt-4 overflow-x-auto">
                <table className="min-w-full border-separate border-spacing-y-2 text-left text-xs sm:text-sm">
                  <thead>
                    <tr>
                      <th className="px-2 py-1 text-zinc-500">URL</th>
                      <th className="px-2 py-1 text-zinc-500">HTML</th>
                      <th className="px-2 py-1 text-zinc-500">Markdown</th>
                      <th className="px-2 py-1 text-zinc-500">Head Hints</th>
                      <th className="px-2 py-1 text-zinc-500">JSON-LD</th>
                      <th className="px-2 py-1 text-zinc-500">Signal Count</th>
                    </tr>
                  </thead>
                  <tbody>
                    {result.crawl.pageReports
                      .slice()
                      .sort((a, b) => pageIssueCount(a) - pageIssueCount(b))
                      .map((page) => (
                        <tr key={page.url} className="bg-zinc-50">
                          <td className="rounded-l-lg px-2 py-2 font-medium text-zinc-700">
                            {page.url}
                          </td>
                          <td className="px-2 py-2">
                            <StatusCell passed={page.htmlOk} />
                          </td>
                          <td className="px-2 py-2">
                            <StatusCell passed={page.markdownOk} />
                          </td>
                          <td className="px-2 py-2">
                            <StatusCell passed={page.hasHeadHints} />
                          </td>
                          <td className="px-2 py-2">
                            <StatusCell passed={page.hasStructuredData} />
                          </td>
                          <td className="rounded-r-lg px-2 py-2 text-zinc-700">
                            {pageIssueCount(page)}/4
                          </td>
                        </tr>
                      ))}
                  </tbody>
                </table>
              </div>
            </div>
          )}

          <div className="grid gap-4">
            {result.checks.map((check) => (
              <article
                key={check.id}
                className="rounded-2xl border border-zinc-200 bg-white p-5 shadow-sm sm:p-6"
              >
                <div className="mb-3 flex flex-wrap items-center gap-3">
                  <h3 className="text-lg font-semibold text-zinc-900">
                    {check.title}
                  </h3>
                  <span
                    className={`rounded-full border px-2.5 py-1 text-xs font-semibold ${statusClassName[check.status]}`}
                  >
                    {statusCopy[check.status]}
                  </span>
                  <span className="text-xs text-zinc-500">
                    {check.pointsEarned}/{check.pointsPossible} points
                  </span>
                </div>

                <p className="text-sm text-zinc-700">{check.details}</p>
                <p className="mt-2 text-sm text-zinc-600">
                  <strong className="font-semibold text-zinc-800">
                    Recommendation:
                  </strong>{" "}
                  {check.recommendation}
                </p>

                {check.evidence.length > 0 && (
                  <ul className="mt-3 flex flex-wrap gap-2">
                    {check.evidence.map((item) => (
                      <li
                        key={`${check.id}-${item}`}
                        className="rounded-md bg-zinc-100 px-2 py-1 text-xs text-zinc-700"
                      >
                        {item}
                      </li>
                    ))}
                  </ul>
                )}

                {check.docsUrl && (
                  <p className="mt-3 text-sm">
                    <a
                      href={check.docsUrl}
                      target="_blank"
                      rel="noreferrer"
                      className="font-medium text-blue-700 underline decoration-blue-400 underline-offset-2 hover:text-blue-900"
                    >
                      Reference documentation
                    </a>
                  </p>
                )}
              </article>
            ))}
          </div>
        </section>
      )}
    </main>
  );
}
