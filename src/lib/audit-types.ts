export type AuditStatus = "pass" | "warn" | "fail";
export type AuditMode = "single" | "sitemap";

export interface AuditCheck {
  id: string;
  title: string;
  status: AuditStatus;
  details: string;
  recommendation: string;
  evidence: string[];
  docsUrl?: string;
  pointsEarned: number;
  pointsPossible: number;
}

export interface CrawlPageReport {
  url: string;
  htmlOk: boolean;
  markdownOk: boolean;
  hasHeadHints: boolean;
  hasStructuredData: boolean;
}

export interface AuditResult {
  target: string;
  checkedAt: string;
  durationMs: number;
  score: number;
  maxScore: number;
  checks: AuditCheck[];
  crawl: {
    mode: AuditMode;
    usedSitemap: boolean;
    pagesDiscovered: number;
    pagesAudited: number;
    sampledUrls: string[];
    pageReports: CrawlPageReport[];
  };
}
