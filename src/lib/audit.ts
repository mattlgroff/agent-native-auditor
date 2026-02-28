import {
  AuditCheck,
  AuditMode,
  AuditResult,
  AuditStatus,
  CrawlPageReport,
} from "@/lib/audit-types";

type AuditOptions = {
  mode?: AuditMode;
  maxPages?: number;
};

type FetchResult = {
  ok: boolean;
  status: number;
  contentType: string;
  body: string;
  error?: string;
};

const REQUEST_TIMEOUT_MS = 9000;
const CRAWL_CONCURRENCY = 4;
const HARD_SAFETY_PAGE_LIMIT = 5000;

const DOCS = {
  webMcp: "https://github.com/webmachinelearning/webmcp",
  agentsJson: "https://github.com/wild-card-ai/agents-json",
  markdownToAgents: "https://github.com/vercel-labs/markdown-to-agents",
};

function normalizeTarget(rawUrl: string): URL {
  const trimmed = rawUrl.trim();
  const withProtocol = /^https?:\/\//i.test(trimmed)
    ? trimmed
    : `https://${trimmed}`;
  const parsed = new URL(withProtocol);

  if (!["http:", "https:"].includes(parsed.protocol)) {
    throw new Error("Only http and https URLs are supported.");
  }

  return parsed;
}

function normalizeMaxPages(maxPages?: number): number | null {
  if (!maxPages || Number.isNaN(maxPages) || maxPages < 1) return null;
  return Math.min(HARD_SAFETY_PAGE_LIMIT, Math.floor(maxPages));
}

async function fetchText(
  url: string,
  init?: RequestInit,
): Promise<FetchResult> {
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), REQUEST_TIMEOUT_MS);

  try {
    const response = await fetch(url, {
      ...init,
      redirect: "follow",
      signal: controller.signal,
      headers: {
        ...(init?.headers ?? {}),
      },
    });

    const contentType = response.headers.get("content-type") ?? "";
    const body = await response.text();

    return {
      ok: response.ok,
      status: response.status,
      contentType,
      body,
    };
  } catch (error) {
    return {
      ok: false,
      status: 0,
      contentType: "",
      body: "",
      error: error instanceof Error ? error.message : "Unknown fetch error",
    };
  } finally {
    clearTimeout(timeout);
  }
}

function pointsForStatus(status: AuditStatus, pointsPossible: number): number {
  if (status === "pass") return pointsPossible;
  if (status === "warn") return Math.ceil(pointsPossible / 2);
  return 0;
}

function buildCheck(
  id: string,
  title: string,
  status: AuditStatus,
  details: string,
  recommendation: string,
  evidence: string[],
  docsUrl?: string,
  pointsPossible = 10,
): AuditCheck {
  return {
    id,
    title,
    status,
    details,
    recommendation,
    evidence,
    docsUrl,
    pointsPossible,
    pointsEarned: pointsForStatus(status, pointsPossible),
  };
}

function includesLinkTag(html: string, hrefFragment: string): boolean {
  const escapedFragment = hrefFragment.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
  const pattern = new RegExp(
    `<link[^>]+href=["'][^"']*${escapedFragment}[^"']*["'][^>]*>`,
    "i",
  );
  return pattern.test(html);
}

function parseSitemapUrl(robotsBody: string): string | null {
  const match = robotsBody.match(/^sitemap:\s*(\S+)$/im);
  return match?.[1] ?? null;
}

function getUrlOrigin(url: string): string | null {
  try {
    return new URL(url).origin;
  } catch {
    return null;
  }
}

function isLocalOrigin(origin: string): boolean {
  try {
    const { hostname } = new URL(origin);
    return (
      hostname === "localhost" ||
      hostname === "127.0.0.1" ||
      hostname === "0.0.0.0"
    );
  } catch {
    return false;
  }
}

function looksLikeMarkdown(body: string): boolean {
  return /(^#\s)|(^##\s)|(^-\s)|(^\d+\.\s)/m.test(body.trim());
}

function isProbablyHtml(body: string): boolean {
  return /<html|<!doctype\s+html/i.test(body);
}

function isMarkdownFriendlyResponse(response: FetchResult): boolean {
  if (!response.ok) return false;
  const markdownContentType = /text\/(markdown|plain)/i.test(
    response.contentType,
  );
  return (
    (markdownContentType || looksLikeMarkdown(response.body)) &&
    !isProbablyHtml(response.body)
  );
}

function hasAgentsJsonShape(parsed: unknown): parsed is {
  apiVersion: unknown;
  name: unknown;
  description: unknown;
  chains: Record<string, { steps?: unknown }>;
} {
  if (!parsed || typeof parsed !== "object") return false;
  const candidate = parsed as Record<string, unknown>;
  if (typeof candidate.chains !== "object" || candidate.chains === null)
    return false;
  return true;
}

function decodeXmlText(value: string): string {
  return value
    .replaceAll("&amp;", "&")
    .replaceAll("&lt;", "<")
    .replaceAll("&gt;", ">")
    .replaceAll("&quot;", '"')
    .replaceAll("&apos;", "'")
    .trim();
}

function parseSitemapLocUrls(xml: string): string[] {
  return Array.from(xml.matchAll(/<loc>([^<]+)<\/loc>/gi))
    .map((match) => decodeXmlText(match[1] ?? ""))
    .filter(Boolean);
}

function computeCoverageStatus(ratio: number): AuditStatus {
  if (ratio >= 0.8) return "pass";
  if (ratio >= 0.4) return "warn";
  return "fail";
}

async function runWithConcurrency<TInput, TOutput>(
  items: TInput[],
  limit: number,
  worker: (item: TInput) => Promise<TOutput>,
): Promise<TOutput[]> {
  const cappedLimit = Math.max(1, Math.min(limit, items.length || 1));
  const results: TOutput[] = new Array(items.length);
  let nextIndex = 0;

  async function processQueue(): Promise<void> {
    while (nextIndex < items.length) {
      const currentIndex = nextIndex;
      nextIndex += 1;
      results[currentIndex] = await worker(items[currentIndex]);
    }
  }

  await Promise.all(Array.from({ length: cappedLimit }, () => processQueue()));
  return results;
}

async function inspectPage(url: string): Promise<CrawlPageReport> {
  const [html, markdown] = await Promise.all([
    fetchText(url, { headers: { Accept: "text/html" } }),
    fetchText(url, { headers: { Accept: "text/markdown" } }),
  ]);

  const hasHeadHints = html.ok
    ? includesLinkTag(html.body, "/llms.txt") &&
      includesLinkTag(html.body, "/.well-known/agents.json") &&
      /<meta[^>]+name=["']agent-capabilities["']/i.test(html.body)
    : false;

  const hasStructuredData = html.ok
    ? (
        html.body.match(
          /<script[^>]+type=["']application\/ld\+json["'][^>]*>/gi,
        ) ?? []
      ).length > 0
    : false;

  return {
    url,
    htmlOk: html.ok,
    markdownOk: isMarkdownFriendlyResponse(markdown),
    hasHeadHints,
    hasStructuredData,
  };
}

async function resolveSitemapUrls(
  origin: string,
  robotsTxt: FetchResult,
  maxPages: number | null,
): Promise<{
  robotsSitemapUrl: string | null;
  usedLocalSitemapFallback: boolean;
  rewroteSitemapOriginForLocalhost: boolean;
  sitemapUrl: string;
  sitemapResult: FetchResult;
  discoveredUrls: string[];
  auditedUrls: string[];
}> {
  const robotsSitemapUrl = parseSitemapUrl(robotsTxt.body);
  const robotsSitemapOrigin = robotsSitemapUrl
    ? getUrlOrigin(robotsSitemapUrl)
    : null;
  const shouldFallbackToLocalSitemap =
    Boolean(robotsSitemapUrl) &&
    Boolean(robotsSitemapOrigin) &&
    robotsSitemapOrigin !== origin;

  const sitemapUrl = shouldFallbackToLocalSitemap
    ? `${origin}/sitemap.xml`
    : (robotsSitemapUrl ?? `${origin}/sitemap.xml`);
  const sitemapResult = await fetchText(sitemapUrl, {
    headers: { Accept: "application/xml,text/xml,text/plain" },
  });

  if (!sitemapResult.ok) {
    return {
      robotsSitemapUrl,
      usedLocalSitemapFallback: shouldFallbackToLocalSitemap,
      rewroteSitemapOriginForLocalhost: false,
      sitemapUrl,
      sitemapResult,
      discoveredUrls: [],
      auditedUrls: [`${origin}/`],
    };
  }

  const rawUrls = parseSitemapLocUrls(sitemapResult.body);
  const normalizedUrls = Array.from(
    new Set(
      rawUrls
        .map((url) => {
          try {
            return new URL(url, origin).toString();
          } catch {
            return null;
          }
        })
        .filter((url): url is string => Boolean(url)),
    ),
  );

  const sameOrigin = normalizedUrls.filter((url) => {
    try {
      return new URL(url).origin === origin;
    } catch {
      return false;
    }
  });

  let discoveredUrls = sameOrigin;
  let rewroteSitemapOriginForLocalhost = false;

  if (
    sameOrigin.length === 0 &&
    normalizedUrls.length > 0 &&
    isLocalOrigin(origin)
  ) {
    rewroteSitemapOriginForLocalhost = true;
    discoveredUrls = Array.from(
      new Set(
        normalizedUrls
          .map((url) => {
            try {
              const parsed = new URL(url);
              return `${origin}${parsed.pathname}${parsed.search}`;
            } catch {
              return null;
            }
          })
          .filter((url): url is string => Boolean(url)),
      ),
    );
  }

  const sorted = discoveredUrls.sort((a, b) => {
    if (a === `${origin}/`) return -1;
    if (b === `${origin}/`) return 1;
    return a.localeCompare(b);
  });

  const sliceLimit = maxPages ?? sorted.length;
  const auditedUrls = sorted.slice(0, sliceLimit);
  if (!auditedUrls.includes(`${origin}/`)) {
    auditedUrls.unshift(`${origin}/`);
  }

  return {
    robotsSitemapUrl,
    usedLocalSitemapFallback: shouldFallbackToLocalSitemap,
    rewroteSitemapOriginForLocalhost,
    sitemapUrl,
    sitemapResult,
    discoveredUrls,
    auditedUrls: maxPages ? auditedUrls.slice(0, maxPages) : auditedUrls,
  };
}

export async function runAgentNativeAudit(
  rawUrl: string,
  options: AuditOptions = {},
): Promise<AuditResult> {
  const startedAt = Date.now();
  const mode = options.mode ?? "single";
  const maxPages = normalizeMaxPages(options.maxPages);

  const target = normalizeTarget(rawUrl);
  const origin = target.origin;
  const homeUrl = `${origin}/`;

  const [homeHtml, llmsTxt, agentsJson, markdownVersion, robotsTxt] =
    await Promise.all([
      fetchText(homeUrl, { headers: { Accept: "text/html" } }),
      fetchText(`${origin}/llms.txt`, { headers: { Accept: "text/plain" } }),
      fetchText(`${origin}/.well-known/agents.json`, {
        headers: { Accept: "application/json" },
      }),
      fetchText(homeUrl, { headers: { Accept: "text/markdown" } }),
      fetchText(`${origin}/robots.txt`, { headers: { Accept: "text/plain" } }),
    ]);

  const homeHasLlmsLink = homeHtml.ok
    ? includesLinkTag(homeHtml.body, "/llms.txt")
    : false;
  const homeHasAgentsLink = homeHtml.ok
    ? includesLinkTag(homeHtml.body, "/.well-known/agents.json")
    : false;
  const homeHasCapabilityMeta = homeHtml.ok
    ? /<meta[^>]+name=["']agent-capabilities["']/i.test(homeHtml.body)
    : false;
  const homeHasHeadHints =
    homeHasLlmsLink && homeHasAgentsLink && homeHasCapabilityMeta;
  const homeHasStructuredData = homeHtml.ok
    ? (
        homeHtml.body.match(
          /<script[^>]+type=["']application\/ld\+json["'][^>]*>/gi,
        ) ?? []
      ).length > 0
    : false;
  const homeMarkdownOk = isMarkdownFriendlyResponse(markdownVersion);

  const checks: AuditCheck[] = [];

  const sitemapResolution = await resolveSitemapUrls(
    origin,
    robotsTxt,
    maxPages,
  );
  const usedSitemap = sitemapResolution.discoveredUrls.length > 0;

  {
    const evidence = [`HTTP ${llmsTxt.status || "ERR"}`];
    if (llmsTxt.error) evidence.push(llmsTxt.error);
    if (llmsTxt.ok)
      evidence.push(`Content-Type: ${llmsTxt.contentType || "missing"}`);

    const hasHeading = /^#\s+/m.test(llmsTxt.body);
    const hasSection = /^##\s+/m.test(llmsTxt.body);
    const hasEndpoint = /https?:\/\//i.test(llmsTxt.body);

    if (!llmsTxt.ok) {
      checks.push(
        buildCheck(
          "llms_txt",
          "LLMs.txt Discovery",
          "fail",
          "No accessible /llms.txt file found.",
          "Add /llms.txt with concise app context, key pages, and actionable endpoint guidance.",
          evidence,
          DOCS.markdownToAgents,
        ),
      );
    } else if (hasHeading && hasSection && hasEndpoint) {
      checks.push(
        buildCheck(
          "llms_txt",
          "LLMs.txt Discovery",
          "pass",
          "Found a well-structured llms.txt file that appears useful for agents.",
          "Keep this file synchronized with endpoint and policy changes.",
          evidence,
          DOCS.markdownToAgents,
        ),
      );
    } else {
      checks.push(
        buildCheck(
          "llms_txt",
          "LLMs.txt Discovery",
          "warn",
          "Found /llms.txt, but structure appears incomplete for reliable agent use.",
          "Add headings, concrete actions, and explicit URL references.",
          evidence,
          DOCS.markdownToAgents,
        ),
      );
    }
  }

  {
    const evidence = [`HTTP ${agentsJson.status || "ERR"}`];
    if (agentsJson.error) evidence.push(agentsJson.error);
    if (agentsJson.ok)
      evidence.push(`Content-Type: ${agentsJson.contentType || "missing"}`);

    if (!agentsJson.ok) {
      checks.push(
        buildCheck(
          "agents_json",
          "agents.json Contract",
          "fail",
          "No accessible /.well-known/agents.json file found.",
          "Publish a machine-readable action schema with explicit chains and step contracts.",
          evidence,
          DOCS.agentsJson,
        ),
      );
    } else {
      try {
        const parsed: unknown = JSON.parse(agentsJson.body);
        if (!hasAgentsJsonShape(parsed)) {
          checks.push(
            buildCheck(
              "agents_json",
              "agents.json Contract",
              "warn",
              "agents.json is valid JSON but missing expected schema shape.",
              "Include apiVersion, name, description, and chains with actionable steps.",
              evidence,
              DOCS.agentsJson,
            ),
          );
        } else {
          const chains = parsed.chains;
          const chainCount = Object.keys(chains).length;
          const hasValidStep = Object.values(chains).some((chain) => {
            if (!Array.isArray(chain.steps)) return false;
            return chain.steps.some((step) => {
              if (!step || typeof step !== "object") return false;
              const candidate = step as Record<string, unknown>;
              return (
                typeof candidate.endpoint === "string" &&
                typeof candidate.method === "string"
              );
            });
          });

          evidence.push(`Chains: ${chainCount}`);

          checks.push(
            buildCheck(
              "agents_json",
              "agents.json Contract",
              chainCount > 0 && hasValidStep ? "pass" : "warn",
              chainCount > 0 && hasValidStep
                ? "Found agents.json with concrete endpoint/method steps."
                : "Found agents.json, but chains or steps look incomplete.",
              "Define clear chain intents with required parameters and typed responses.",
              evidence,
              DOCS.agentsJson,
            ),
          );
        }
      } catch (error) {
        checks.push(
          buildCheck(
            "agents_json",
            "agents.json Contract",
            "fail",
            "agents.json endpoint exists but did not return valid JSON.",
            "Return valid JSON that matches the agents.json schema.",
            [
              ...evidence,
              error instanceof Error ? error.message : "JSON parse failed",
            ],
            DOCS.agentsJson,
          ),
        );
      }
    }
  }

  {
    const evidence = [`HTTP ${homeHtml.status || "ERR"}`];
    if (homeHtml.error) evidence.push(homeHtml.error);

    if (!homeHtml.ok) {
      checks.push(
        buildCheck(
          "head_hints_home",
          "Head Discovery Hints (Homepage)",
          "fail",
          "Could not fetch homepage HTML to inspect discovery hints.",
          "Expose an indexable homepage and add llms/agents links plus capability metadata.",
          evidence,
        ),
      );
    } else {
      const passCount = [
        homeHasLlmsLink,
        homeHasAgentsLink,
        homeHasCapabilityMeta,
      ].filter(Boolean).length;

      evidence.push(`llms link: ${homeHasLlmsLink ? "yes" : "no"}`);
      evidence.push(`agents link: ${homeHasAgentsLink ? "yes" : "no"}`);
      evidence.push(
        `agent-capabilities meta: ${homeHasCapabilityMeta ? "yes" : "no"}`,
      );

      checks.push(
        buildCheck(
          "head_hints_home",
          "Head Discovery Hints (Homepage)",
          passCount === 3 ? "pass" : passCount > 0 ? "warn" : "fail",
          passCount === 3
            ? "Homepage includes core discovery hints for agents."
            : "Homepage is missing one or more discovery hints.",
          "Add alternate links for llms.txt and agents.json plus a meta capabilities summary.",
          evidence,
        ),
      );
    }
  }

  {
    const evidence = [`HTTP ${markdownVersion.status || "ERR"}`];
    if (markdownVersion.error) evidence.push(markdownVersion.error);
    if (markdownVersion.ok)
      evidence.push(
        `Content-Type: ${markdownVersion.contentType || "missing"}`,
      );

    if (!markdownVersion.ok) {
      checks.push(
        buildCheck(
          "markdown_home",
          "Markdown Negotiation (Homepage)",
          "fail",
          "Requesting text/markdown for homepage did not return success.",
          "Add Accept-header based markdown routing for high-value pages.",
          evidence,
          DOCS.markdownToAgents,
        ),
      );
    } else {
      const bodyLooksHtml = isProbablyHtml(markdownVersion.body);
      const status: AuditStatus = homeMarkdownOk
        ? "pass"
        : bodyLooksHtml
          ? "fail"
          : "warn";

      checks.push(
        buildCheck(
          "markdown_home",
          "Markdown Negotiation (Homepage)",
          status,
          status === "pass"
            ? "Homepage appears to support markdown-friendly responses."
            : status === "warn"
              ? "Response is non-HTML but not clearly markdown-optimized."
              : "Accept: text/markdown appears to return normal HTML.",
          "Return markdown/plain content for agent requests when possible.",
          evidence,
          DOCS.markdownToAgents,
        ),
      );
    }
  }

  {
    const sitemap = sitemapResolution.sitemapResult;
    const evidence = [`robots.txt HTTP ${robotsTxt.status || "ERR"}`];
    if (robotsTxt.error) evidence.push(robotsTxt.error);
    if (sitemapResolution.robotsSitemapUrl) {
      evidence.push(`robots sitemap: ${sitemapResolution.robotsSitemapUrl}`);
    }
    evidence.push(`sitemap URL: ${sitemapResolution.sitemapUrl}`);
    evidence.push(`sitemap HTTP ${sitemap.status || "ERR"}`);
    if (sitemapResolution.usedLocalSitemapFallback) {
      evidence.push(
        "robots sitemap origin differs from target; used local /sitemap.xml fallback",
      );
    }
    if (sitemapResolution.rewroteSitemapOriginForLocalhost) {
      evidence.push(
        "rewrote sitemap URL hostnames to localhost for local preview auditing",
      );
    }
    if (sitemap.error) evidence.push(sitemap.error);

    const hasAllowOrDisallow =
      robotsTxt.ok && /(allow:|disallow:)/i.test(robotsTxt.body);
    const hasSitemapTag = robotsTxt.ok && /^sitemap:/im.test(robotsTxt.body);
    const isXmlSitemap =
      sitemap.ok && /<urlset|<sitemapindex/i.test(sitemap.body);

    checks.push(
      buildCheck(
        "robots_sitemap",
        "Robots + Sitemap",
        hasAllowOrDisallow && isXmlSitemap
          ? "pass"
          : hasSitemapTag || sitemap.ok
            ? "warn"
            : "fail",
        hasAllowOrDisallow && isXmlSitemap
          ? "Found crawl directives and a valid sitemap XML response."
          : "Robots or sitemap exists, but coverage appears incomplete.",
        "Ensure robots.txt has crawl directives and points at a valid sitemap XML.",
        evidence,
      ),
    );
  }

  {
    const evidence = [`Homepage HTTP ${homeHtml.status || "ERR"}`];
    if (homeHtml.error) evidence.push(homeHtml.error);

    if (!homeHtml.ok) {
      checks.push(
        buildCheck(
          "structured_data_home",
          "Structured Data (Homepage)",
          "fail",
          "Could not inspect homepage for JSON-LD schemas.",
          "Expose JSON-LD for website/org and key page entities.",
          evidence,
        ),
      );
    } else {
      const jsonLdScripts = homeHasStructuredData ? 1 : 0;
      evidence.push(
        `JSON-LD scripts found: ${jsonLdScripts > 0 ? "yes" : "no"}`,
      );

      checks.push(
        buildCheck(
          "structured_data_home",
          "Structured Data (Homepage)",
          jsonLdScripts > 0 ? "pass" : "warn",
          jsonLdScripts > 0
            ? "Found JSON-LD structured data on homepage."
            : "No JSON-LD found on homepage.",
          "Add at least WebSite and Organization JSON-LD schemas.",
          evidence,
        ),
      );
    }
  }

  {
    const evidence = [`Homepage HTTP ${homeHtml.status || "ERR"}`];

    if (!homeHtml.ok) {
      checks.push(
        buildCheck(
          "webmcp_surface_home",
          "WebMCP Surface Signals (Homepage)",
          "fail",
          "Could not inspect homepage for form and tool signals.",
          "Expose form-level tool metadata and register tools where browser support exists.",
          evidence,
          DOCS.webMcp,
        ),
      );
    } else {
      const hasDeclarativeTooling =
        /\btoolname\s*=|\btooldescription\s*=|\btoolparamtitle\s*=/i.test(
          homeHtml.body,
        );
      const hasWebMcpHints = /webmcp|modelcontext|registertool/i.test(
        homeHtml.body,
      );
      evidence.push(
        `Declarative tool attrs found: ${hasDeclarativeTooling ? "yes" : "no"}`,
      );
      evidence.push(
        `WebMCP keyword hints found: ${hasWebMcpHints ? "yes" : "no"}`,
      );

      checks.push(
        buildCheck(
          "webmcp_surface_home",
          "WebMCP Surface Signals (Homepage)",
          hasDeclarativeTooling ? "pass" : "warn",
          hasDeclarativeTooling
            ? "Found declarative tool attributes in server-rendered HTML."
            : "No declarative tool metadata found on homepage response.",
          "Annotate high-value forms with tool metadata and progressive enhancement behavior.",
          evidence,
          DOCS.webMcp,
        ),
      );
    }
  }

  let crawledPages: CrawlPageReport[] = [
    {
      url: homeUrl,
      htmlOk: homeHtml.ok,
      markdownOk: homeMarkdownOk,
      hasHeadHints: homeHasHeadHints,
      hasStructuredData: homeHasStructuredData,
    },
  ];
  let pagesDiscovered = sitemapResolution.discoveredUrls.length;
  let pagesAudited = 1;
  let sampledUrls = [homeUrl];

  if (mode === "sitemap") {
    sampledUrls =
      sitemapResolution.auditedUrls.length > 0
        ? sitemapResolution.auditedUrls
        : [homeUrl];
    pagesAudited = sampledUrls.length;
    pagesDiscovered = Math.max(pagesDiscovered, sampledUrls.length);

    crawledPages = await runWithConcurrency(
      sampledUrls,
      CRAWL_CONCURRENCY,
      inspectPage,
    );

    const htmlCoverage =
      crawledPages.filter((page) => page.htmlOk).length / crawledPages.length;
    const headHintCoverage =
      crawledPages.filter((page) => page.hasHeadHints).length /
      crawledPages.length;
    const markdownCoverage =
      crawledPages.filter((page) => page.markdownOk).length /
      crawledPages.length;
    const structuredCoverage =
      crawledPages.filter((page) => page.hasStructuredData).length /
      crawledPages.length;

    checks.push(
      buildCheck(
        "sitemap_crawl_health",
        "Sitemap Crawl Health",
        computeCoverageStatus(htmlCoverage),
        `Crawled ${crawledPages.length} page(s); ${Math.round(htmlCoverage * 100)}% returned usable HTML responses.`,
        "Keep sitemap fresh and ensure key URLs are publicly reachable.",
        [
          `Pages discovered: ${pagesDiscovered}`,
          `Pages audited: ${pagesAudited}`,
          `HTML success rate: ${Math.round(htmlCoverage * 100)}%`,
        ],
        undefined,
        8,
      ),
    );

    checks.push(
      buildCheck(
        "head_hints_coverage",
        "Head Hint Coverage (Sitemap Sample)",
        computeCoverageStatus(headHintCoverage),
        `${Math.round(headHintCoverage * 100)}% of sampled pages expose llms/agents links + capabilities meta.`,
        "Ensure head discovery hints are injected from shared layout so all pages inherit them.",
        [
          `Pages with hints: ${crawledPages.filter((page) => page.hasHeadHints).length}/${crawledPages.length}`,
          `Coverage: ${Math.round(headHintCoverage * 100)}%`,
        ],
        undefined,
        8,
      ),
    );

    checks.push(
      buildCheck(
        "markdown_coverage",
        "Markdown Coverage (Sitemap Sample)",
        computeCoverageStatus(markdownCoverage),
        `${Math.round(markdownCoverage * 100)}% of sampled pages returned markdown-friendly responses.`,
        "Use Accept-header rewrites or content routes so content pages are markdown-accessible.",
        [
          `Pages markdown-ready: ${crawledPages.filter((page) => page.markdownOk).length}/${crawledPages.length}`,
          `Coverage: ${Math.round(markdownCoverage * 100)}%`,
        ],
        DOCS.markdownToAgents,
        8,
      ),
    );

    checks.push(
      buildCheck(
        "structured_data_coverage",
        "Structured Data Coverage (Sitemap Sample)",
        computeCoverageStatus(structuredCoverage),
        `${Math.round(structuredCoverage * 100)}% of sampled pages include JSON-LD schema markup.`,
        "Add page-appropriate JSON-LD templates for higher discoverability and retrieval quality.",
        [
          `Pages with JSON-LD: ${crawledPages.filter((page) => page.hasStructuredData).length}/${crawledPages.length}`,
          `Coverage: ${Math.round(structuredCoverage * 100)}%`,
        ],
        undefined,
        8,
      ),
    );
  }

  const score = checks.reduce((sum, check) => sum + check.pointsEarned, 0);
  const maxScore = checks.reduce((sum, check) => sum + check.pointsPossible, 0);

  return {
    target: origin,
    checkedAt: new Date().toISOString(),
    durationMs: Date.now() - startedAt,
    score,
    maxScore,
    checks,
    crawl: {
      mode,
      usedSitemap,
      pagesDiscovered,
      pagesAudited,
      sampledUrls,
      pageReports: crawledPages,
    },
  };
}
