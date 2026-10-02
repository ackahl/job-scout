// Heuristics for (1) picking a company's job board out of search results and
// (2) telling an individual job posting apart from a board's landing page.

import type { TavilyResult } from "./search";

// Applicant-tracking systems that host job boards for many companies.
export const ATS_HOSTS = [
  "greenhouse.io",
  "lever.co",
  "ashbyhq.com",
  "myworkdayjobs.com",
  "myworkdaysite.com",
  "smartrecruiters.com",
  "icims.com",
  "jobvite.com",
  "workable.com",
  "bamboohr.com",
  "paylocity.com",
  "paycomonline.net",
  "paycomonline.com",
  "ultipro.com",
  "ukg.net",
  "oraclecloud.com",
  "taleo.net",
  "successfactors.com",
  "eightfold.ai",
  "phenompeople.com",
  "applytojob.com",
  "breezy.hr",
  "rippling.com",
  "dayforcehcm.com",
];

// Aggregators and info sites: never a company's own board.
const BLOCKED_HOSTS = [
  "linkedin.com",
  "indeed.com",
  "glassdoor.com",
  "ziprecruiter.com",
  "simplyhired.com",
  "monster.com",
  "careerbuilder.com",
  "wikipedia.org",
  "builtin.com",
  "comparably.com",
  "levels.fyi",
  "salary.com",
  "payscale.com",
  "facebook.com",
  "x.com",
  "twitter.com",
  "youtube.com",
  "reddit.com",
  "lensa.com",
  "talent.com",
  "jooble.org",
  "dice.com",
  "theladders.com",
];

export function hostOf(url: string): string {
  try {
    return new URL(url).hostname.replace(/^www\./, "").toLowerCase();
  } catch {
    return "";
  }
}

function matchesHost(host: string, list: string[]) {
  return list.some((h) => host === h || host.endsWith(`.${h}`));
}

export const isAtsHost = (host: string) => matchesHost(host, ATS_HOSTS);
export const isBlockedHost = (host: string) => matchesHost(host, BLOCKED_HOSTS);

// "Devon Energy Corp." -> ["devon", "energy"]
export function companyTokens(name: string): string[] {
  const stop = new Set(["inc", "corp", "corporation", "co", "company", "llc", "ltd", "the", "group", "holdings", "plc"]);
  return name
    .toLowerCase()
    .replace(/[^a-z0-9 ]/g, " ")
    .split(/\s+/)
    .filter((t) => t.length > 1 && !stop.has(t));
}

function mentionsCompany(text: string, tokens: string[]) {
  const t = text.toLowerCase().replace(/[^a-z0-9]/g, "");
  return tokens.length > 0 && t.includes(tokens[0]);
}

export function scoreBoardCandidate(r: TavilyResult, tokens: string[]): number {
  const host = hostOf(r.url);
  if (!host || isBlockedHost(host)) return -100;
  const path = (() => {
    try {
      return new URL(r.url).pathname.toLowerCase();
    } catch {
      return "";
    }
  })();
  let score = 0;
  const hostFlat = host.replace(/[^a-z0-9]/g, "");
  const urlFlat = r.url.toLowerCase().replace(/[^a-z0-9]/g, "");
  if (tokens[0] && hostFlat.includes(tokens[0])) score += 4; // company's own domain or its ATS subdomain
  if (isAtsHost(host) && tokens[0] && urlFlat.includes(tokens[0])) score += 4;
  if (/careers?|jobs?|join|opportunit|hiring/.test(host + path)) score += 3;
  if (mentionsCompany(r.title + r.content, tokens)) score += 1;
  if (path.split("/").filter(Boolean).length <= 3) score += 1; // landing pages beat deep links
  return score + r.score; // Tavily's own relevance, 0..1
}

export function pickBoard(results: TavilyResult[], companyName: string) {
  const tokens = companyTokens(companyName);
  const ranked = results
    .map((r) => ({ r, score: scoreBoardCandidate(r, tokens) }))
    .filter((x) => x.score > 3)
    .sort((a, b) => b.score - a.score);

  const best = ranked[0]?.r ?? null;
  const domains = new Set<string>();
  if (best) domains.add(hostOf(best.url));
  // Many company career pages hand off to an ATS. Keep the ATS host too, if one shows up for this company.
  for (const { r } of ranked.slice(0, 6)) {
    const host = hostOf(r.url);
    if (isAtsHost(host) && r.url.toLowerCase().replace(/[^a-z0-9]/g, "").includes(tokens[0] ?? "~")) {
      domains.add(host);
    }
    if (tokens[0] && host.replace(/[^a-z0-9]/g, "").includes(tokens[0])) domains.add(host);
  }
  return { boardUrl: best?.url ?? null, boardDomains: [...domains].slice(0, 4) };
}

// True when a URL looks like one specific job, not a list of jobs.
export function looksLikePosting(url: string, boardUrl: string | null): boolean {
  let u: URL;
  try {
    u = new URL(url);
  } catch {
    return false;
  }
  if (boardUrl && url.replace(/\/$/, "") === boardUrl.replace(/\/$/, "")) return false;
  const path = u.pathname.toLowerCase();
  const segs = path.split("/").filter(Boolean);
  if (/(^|\/)(search|search-results|results|jobs|careers|openings|positions|departments|teams|locations|benefits|culture|career-page|job-search|search-jobs|job-map|job-categories)\/?$/.test(path)) return false;
  if (/\/(job-categories|blog|news|press|about|resources|software|privacy|terms)(\/|$)/.test(path)) return false;
  if (u.searchParams.has("gh_jid") || u.searchParams.has("jobId") || u.searchParams.has("job_id")) return true;
  if (/\/(job|jobs|details|position|positions|posting|requisition|req|opening|career|careers|vacancy)\/[^/]+/.test(path)) return true;
  if (/\d{4,}/.test(path)) return true; // most postings carry a numeric or long ID
  if (/[0-9a-f]{8}-[0-9a-f]{4}-/.test(path)) return true; // Lever / Ashby UUIDs
  return segs.length >= 3;
}

// Some applicant tracking systems accept a keyword in the listing URL. Use it when we know how.
export function listingUrlFor(boardUrl: string, role: string): string {
  try {
    const u = new URL(boardUrl);
    const host = u.hostname.toLowerCase();
    if (host.endsWith("myworkdayjobs.com") || host.endsWith("myworkdaysite.com")) {
      u.searchParams.set("q", role);
      return u.toString();
    }
    return boardUrl;
  } catch {
    return boardUrl;
  }
}
