# Agent Native Auditor

Web app to audit whether a site follows key agent-native web principles.

## What it checks

- `/.well-known/agents.json` availability and schema quality
- `/llms.txt` availability and structure signals
- Homepage discovery hints (`<link rel="alternate">`, `meta name="agent-capabilities"`)
- `Accept: text/markdown` support
- `robots.txt` and `sitemap.xml` coverage
- JSON-LD structured data presence
- WebMCP-related HTML tooling signals
- Optional sitemap-based multi-page crawl coverage

Each check returns:

- pass/warn/fail status
- evidence from HTTP response and parsed content
- recommendation for fixing gaps
- weighted points that roll up into a total score
- runtime duration and crawl metadata
- optional per-page sitemap sample diagnostics

## Audit modes

- `single`: homepage-focused audit
- `sitemap`: crawls `sitemap.xml` URLs (or the sitemap URL listed in `robots.txt`) and computes coverage metrics across sampled pages

Sitemap mode crawls all discovered sitemap URLs by default.

The UI also includes:

- recent run history (stored in localStorage)
- score delta against previous run for the same domain
- per-page signal matrix for sitemap samples
- JSON report download for sharing/debugging

## Stack

- Next.js App Router
- TypeScript
- Tailwind CSS

## Run locally

```bash
npm install
npm run dev
```

Open `http://localhost:3000`.

## API

`POST /api/audit`

Request body:

```json
{
  "url": "https://example.com",
  "mode": "sitemap"
}
```

`mode` supports `single` or `sitemap`.

Optional: include `maxPages` to manually limit sitemap crawl breadth for very large sites.

## One-click Vercel deploy

1. Push this repo to GitHub.
2. Set `NEXT_PUBLIC_GITHUB_REPO_URL` in your Vercel project (see `.env.example`).
3. Use this clone URL pattern for one-click deploy links:

```text
https://vercel.com/new/clone?repository-url=https://github.com/mattlgroff/agent-native-auditor&project-name=agent-native-auditor&repository-name=agent-native-auditor
```

The app includes a `Deploy This Auditor` button that uses `NEXT_PUBLIC_GITHUB_REPO_URL` when provided.

The included `vercel.json` sets Next.js framework defaults and standard install/build commands.

## Reference specs and resources

- WebMCP proposal: https://github.com/webmachinelearning/webmcp
- agents.json spec: https://github.com/wild-card-ai/agents-json
- markdown-to-agents reference: https://github.com/vercel-labs/markdown-to-agents
