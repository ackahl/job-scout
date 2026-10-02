// The two custom tools. The tool descriptions are what the LLM reads to decide when to call them.

import type Anthropic from "@anthropic-ai/sdk";
import { companyTokens, hostOf, isAtsHost, isBlockedHost, listingUrlFor, looksLikePosting, pickBoard, scoreBoardCandidate } from "./board";
import { areaText, chooseBoard, extractRows, selectPostings } from "./extract";
import { firecrawlScrape, markdownLinks, tavilySearch, type ScrapedPage, type TavilyResult } from "./search";
import type { Area, CompanyResult, Employer, RoleSearch } from "./types";

export const MAX_EMPLOYERS = 6;
const POSTINGS_PER_COMPANY = 4;
const BLOCKED_FOR_SEARCH = ["linkedin.com", "indeed.com", "glassdoor.com", "ziprecruiter.com", "simplyhired.com", "monster.com", "careerbuilder.com", "theladders.com", "tealhq.com", "jobzmall.com", "lensa.com", "talent.com", "jooble.org", "builtin.com"];

export const TOOL_DEFINITIONS: Anthropic.Tool[] = [
  {
    name: "update_employer_list",
    description:
      "Save, remove, or replace the companies the user wants to watch for job openings. " +
      "Call this whenever the user names companies they want to work for or want searched (e.g. 'watch Paycom and Devon', " +
      "'add Boeing', 'drop Devon', 'start over with Google and Microsoft'). " +
      "For each newly added company, this tool finds the company's job board from the name alone and returns its URL. " +
      "Do not call it for companies the user only mentions in passing without wanting them searched.",
    input_schema: {
      type: "object",
      properties: {
        action: {
          type: "string",
          enum: ["add", "remove", "replace"],
          description: "'add' keeps existing companies, 'remove' drops the named ones, 'replace' clears the list first.",
        },
        companies: {
          type: "array",
          items: { type: "string" },
          minItems: 1,
          description: "Company names exactly as the user said them, e.g. ['Paycom', 'Devon Energy'].",
        },
      },
      required: ["action", "companies"],
    },
  },
  {
    name: "find_open_roles",
    description:
      "Search the saved companies' job boards for open postings, and return each posting's " +
      "title, location, pay, status and link. Call this when the user asks what jobs, openings, roles or positions " +
      "are available (e.g. 'any data analyst jobs?', 'find me HR manager roles', 'what's open at Devon?'). " +
      "Pass a role to search for one kind of job; omit role to get each company's newest openings across all roles. " +
      "The saved employer list must not be " +
      "empty; if the user names new companies in the same message, call update_employer_list first. " +
      "Do not call this for general career advice, interview prep, resume questions or salary negotiation.",
    input_schema: {
      type: "object",
      properties: {
        role: {
          type: "string",
          description: "Optional. The job type to search for, in plain words, e.g. 'data analyst'. Omit to list the newest openings of any kind.",
        },
        companies: {
          type: "array",
          items: { type: "string" },
          description: "Optional: limit the search to these saved companies. Omit to search every saved company.",
        },
        location: {
          type: "string",
          description: "Optional: city and state to search near, e.g. 'Yukon, OK'. Use the challenger's home turf unless they ask for somewhere else or for anywhere.",
        },
        radius_miles: {
          type: "number",
          description: "Optional: how far from location to search, in miles. Omit for any distance.",
        },
      },
      required: [],
    },
  },
  {
    name: "find_top_contenders",
    description:
      "Scout the best job openings in the challenger's area across ALL employers (not just the saved companies), ranked by stated pay. " +
      "Call this when the challenger asks for top contenders, the best jobs near them, or what's hiring in their area. " +
      "Requires a location; use the challenger's home turf unless they name another place. If no location is known, ask for one instead of calling.",
    input_schema: {
      type: "object",
      properties: {
        location: { type: "string", description: "City and state, e.g. 'Yukon, OK'." },
        radius_miles: { type: "number", description: "Search radius in miles. Default 25." },
        role: { type: "string", description: "Optional job type to focus on. Omit for the best jobs of any kind." },
      },
      required: ["location"],
    },
  },
];

type Status = (text: string) => void;

const uniq = <T,>(xs: T[]) => [...new Set(xs)];

// Posting links on a scraped listing page.
function postingLinks(markdown: string, boardUrl: string | null) {
  return markdownLinks(markdown).filter((l) => {
    const host = hostOf(l.url);
    if (/^(https?:\/\/|www\.)|\.(com|org|net)\b/i.test(l.text)) return false; // bare-URL links are footers, not jobs
    return host && !isBlockedHost(host) && looksLikePosting(l.url, boardUrl);
  });
}

const JOB_SEARCH_LINK = /search (all )?jobs|job search|view (all )?(open )?(jobs|positions|openings|roles)|see (all )?(open )?(jobs|positions|openings|roles)|open positions|current openings|explore (jobs|roles|opportunities)|find (a )?job/i;

// If a careers page has no job links, follow its "Search Jobs" link (or a /jobs page on the same site) once.
const LISTING_PATH = /\/(jobs|job-search|search-jobs|search|openings|careers\/search|en\/jobs)\/?$/i;
async function followToListing(page: ScrapedPage): Promise<ScrapedPage> {
  if (postingLinks(page.markdown, page.finalUrl).length >= 2) return page;
  const host = hostOf(page.finalUrl);
  const links = markdownLinks(page.markdown).filter((l) => !isBlockedHost(hostOf(l.url)));
  const next =
    links.find((l) => JOB_SEARCH_LINK.test(l.text)) ??
    links.find((l) => hostOf(l.url) === host && LISTING_PATH.test(new URL(l.url).pathname));
  if (!next || next.url.split("#")[0] === page.finalUrl.split("#")[0]) return page;
  const listing = await firecrawlScrape(next.url, { waitForMs: 2500, mainContentOnly: false });
  return listing && postingLinks(listing.markdown, listing.finalUrl).length >= 2 ? listing : page;
}

// ---------- Tool 1 ----------

async function findBoard(name: string): Promise<Employer> {
  const tokens = companyTokens(name);
  // Two searches: one for the careers site, one that tends to surface the applicant tracking system.
  const [a, b] = await Promise.all([
    tavilySearch(`${name} careers job openings official site`, { maxResults: 10 }),
    tavilySearch(`${name} jobs apply now`, { maxResults: 8, excludeDomains: BLOCKED_FOR_SEARCH }).catch(() => []),
  ]);
  const seen = new Set<string>();
  const candidates = [...a, ...b]
    .filter((r) => {
      const host = hostOf(r.url);
      if (!host || isBlockedHost(host) || seen.has(r.url)) return false;
      seen.add(r.url);
      return true;
    })
    .sort((x, y) => scoreBoardCandidate(y, tokens) - scoreBoardCandidate(x, tokens))
    .slice(0, 12);

  // Let a small model make the call (it can tell "Paycom" from "Paycom Center"); fall back to the heuristic.
  let boardUrl: string | null = null;
  let hosts: string[] = [];
  try {
    const choice = await chooseBoard(name, candidates);
    if (choice && choice.index >= 0 && candidates[choice.index]) {
      boardUrl = candidates[choice.index].url;
      hosts = choice.jobHosts;
    }
  } catch (error) {
    console.error("[findBoard] chooseBoard", name, error);
  }
  if (!boardUrl) {
    const h = pickBoard(candidates, name);
    boardUrl = h.boardUrl;
    hosts = h.boardDomains;
  }
  if (!boardUrl) return { name, boardUrl: null, boardDomains: [] };

  // Open the board. Follow redirects, and if it's a landing page, follow its "search jobs" link once.
  let page = await firecrawlScrape(boardUrl, { waitForMs: 2500, mainContentOnly: false });
  if (page) {
    boardUrl = page.finalUrl;
    page = await followToListing(page);
    boardUrl = page.finalUrl;
    for (const l of postingLinks(page.markdown, boardUrl).slice(0, 5)) hosts.push(hostOf(l.url));
  }
  hosts.push(hostOf(boardUrl));
  return { name, boardUrl, boardDomains: uniq(hosts.filter(Boolean)).slice(0, 5) };
}

export async function runUpdateEmployerList(
  input: { action: "add" | "remove" | "replace"; companies: string[] },
  current: Employer[],
  status: Status,
): Promise<{ employers: Employer[]; forModel: string }> {
  const norm = (s: string) => s.trim().toLowerCase();
  const names = [...new Set(input.companies.map((c) => c.trim()).filter(Boolean))];

  if (input.action === "remove") {
    const drop = new Set(names.map(norm));
    const employers = current.filter((e) => !drop.has(norm(e.name)));
    return { employers, forModel: JSON.stringify({ saved_companies: employers.map((e) => e.name), removed: names }) };
  }

  const base = input.action === "replace" ? [] : current;
  const existing = new Set(base.map((e) => norm(e.name)));
  const toAdd = names.filter((n) => !existing.has(norm(n)));
  const room = Math.max(0, MAX_EMPLOYERS - base.length);
  const accepted = toAdd.slice(0, room);
  const rejected = toAdd.slice(room);

  if (accepted.length) status(`Scouting the arena for ${accepted.join(", ")}... finding their job boards...`);
  const found = await Promise.all(
    accepted.map(async (name) => {
      try {
        return await findBoard(name);
      } catch (error) {
        console.error("[update_employer_list]", name, error);
        return { name, boardUrl: null, boardDomains: [] } satisfies Employer;
      }
    }),
  );

  const employers = [...base, ...found];
  return {
    employers,
    forModel: JSON.stringify({
      saved_companies: employers.map((e) => ({ name: e.name, job_board: e.boardUrl ?? "not found" })),
      newly_added: found.map((e) => e.name),
      already_saved: names.filter((n) => existing.has(norm(n))),
      not_added_list_full: rejected,
      max_companies: MAX_EMPLOYERS,
    }),
  };
}

// ---------- Tool 2 ----------

type Candidate = { text: string; url: string };

async function candidatePostings(employer: Employer, role: string, area: Area | null): Promise<Candidate[]> {
  const where = area?.radiusMiles ? ` ${area.location}` : "";
  const tokens = companyTokens(employer.name);
  const t = tokens[0] ?? "~";
  const out: Candidate[] = [];
  const seen = new Set<string>();
  const add = (c: Candidate) => {
    const key = c.url.split("?")[0];
    if (seen.has(key)) return;
    seen.add(key);
    out.push(c);
  };

  // 1) Read the board's own listing (with a keyword search where the board supports one).
  const listingTask = employer.boardUrl
    ? firecrawlScrape(listingUrlFor(employer.boardUrl, role), { waitForMs: 2500, mainContentOnly: false })
    : Promise.resolve(null);

  // 2) Search the board's domains for this role.
  const siteTask = employer.boardDomains.length
    ? tavilySearch(role ? `${role} ${employer.name}${where}` : `${employer.name} job opening${where}`, { includeDomains: employer.boardDomains, maxResults: 10 }).catch(() => [])
    : Promise.resolve([] as TavilyResult[]);

  const [landing, site] = await Promise.all([listingTask, siteTask]);
  const listing = landing ? await followToListing(landing) : null;
  if (listing) for (const l of postingLinks(listing.markdown, employer.boardUrl)) add({ text: l.context ? `${l.text} | ${l.context}` : l.text, url: l.url });
  for (const r of site) {
    if (!isBlockedHost(hostOf(r.url)) && looksLikePosting(r.url, employer.boardUrl)) add({ text: r.title, url: r.url });
  }

  // 3) Thin results: open web search, keeping only the company's own site or an ATS page naming the company.
  if (out.length < 3) {
    const open = await tavilySearch(`"${employer.name}" ${role || "job opening"} job${where}`, {
      maxResults: 10,
      excludeDomains: BLOCKED_FOR_SEARCH,
    }).catch(() => []);
    for (const r of open) {
      const host = hostOf(r.url);
      if (!host || isBlockedHost(host) || !looksLikePosting(r.url, employer.boardUrl)) continue;
      const flat = (r.url + r.title).toLowerCase().replace(/[^a-z0-9]/g, "");
      if (host.replace(/[^a-z0-9]/g, "").includes(t) || (isAtsHost(host) && flat.includes(t))) add({ text: r.title, url: r.url });
    }
  }
  return out.slice(0, 80);
}

async function searchCompanyOnce(
  employer: Employer,
  role: string,
  status: Status,
  area: Area | null,
): Promise<{ result: CompanyResult; learnedHosts: string[] }> {
  const base = { company: employer.name, boardUrl: employer.boardUrl };
  try {
    const candidates = await candidatePostings(employer, role, area);
    if (candidates.length === 0) {
      return { result: { ...base, rows: [], note: "Couldn't find any postings on this company's job board." }, learnedHosts: [] };
    }
    // No role: take the board's newest postings as listed. With a role: let the model pick the matches.
    const picks =
      role || area?.radiusMiles
        ? await selectPostings(employer.name, role, candidates, POSTINGS_PER_COMPANY + 1, area)
        : candidates.slice(0, POSTINGS_PER_COMPANY + 1).map((_, i) => i);
    if (picks.length === 0) {
      return { result: { ...base, rows: [], note: `Checked ${candidates.length} postings; none match${role ? " this role" : ""}${area?.radiusMiles ? ` ${areaText(area)}` : ""}.` }, learnedHosts: [] };
    }
    const chosen = picks.map((i) => candidates[i]);
    status(`Tag partner Jax "The Jackhammer" Offerletter is tearing through ${chosen.length} posting${chosen.length > 1 ? "s" : ""} at ${employer.name}...`);
    const pages = (await Promise.all(chosen.map((c) => firecrawlScrape(c.url, { waitForMs: 1500 })))).filter(
      (p): p is NonNullable<typeof p> => p !== null && p.markdown.length > 150,
    );
    if (pages.length === 0) {
      return { result: { ...base, rows: [], note: "Found matching postings but couldn't open them." }, learnedHosts: [] };
    }
    const rows = await extractRows(employer.name, role, pages, area);
    const order = { open: 0, unverified: 1, closed: 2 } as const;
    rows.sort((a, b) => order[a.status] - order[b.status]);
    return {
      result: rows.length > 0 ? { ...base, rows } : { ...base, rows: [], note: `Postings found, but none matched${role ? " this role" : ""}${area?.radiusMiles ? ` ${areaText(area)}` : ""}.` },
      learnedHosts: rows.map((r) => hostOf(r.url)).filter(Boolean),
    };
  } catch (error) {
    console.error("[find_open_roles]", employer.name, error);
    return { result: { ...base, rows: [], note: "Search failed for this company. Try again." }, learnedHosts: [] };
  }
}

// A title search that comes up empty falls back to what the company does have open,
// so the user always sees real openings instead of an empty table.
async function searchCompany(
  employer: Employer,
  role: string,
  status: Status,
  area: Area | null,
): Promise<{ result: CompanyResult; learnedHosts: string[] }> {
  const first = await searchCompanyOnce(employer, role, status, area);
  if (!role || first.result.rows.length > 0) return first;
  status(`No "${role}" title shots at ${employer.name}... pulling everything they DO have open...`);
  const any = await searchCompanyOnce(employer, "", status, area);
  if (any.result.rows.length === 0) return first;
  return {
    result: {
      ...any.result,
      fallback: true,
      note: `No "${role}" openings at ${employer.name}${area?.radiusMiles ? ` ${areaText(area)}` : ""} right now. Here's what they do have open${area?.radiusMiles ? " in range" : ""}:`,
    },
    learnedHosts: any.learnedHosts,
  };
}

export async function runFindOpenRoles(
  input: { role?: string; companies?: string[]; location?: string; radius_miles?: number },
  employers: Employer[],
  status: Status,
): Promise<{ search: RoleSearch | null; employers: Employer[]; forModel: string }> {
  if (employers.length === 0) {
    return {
      search: null,
      employers,
      forModel: JSON.stringify({ error: "No companies saved yet. Ask the user which companies to watch." }),
    };
  }
  const wanted = input.companies?.map((c) => c.trim().toLowerCase()).filter(Boolean);
  const targets = wanted?.length ? employers.filter((e) => wanted.includes(e.name.toLowerCase())) : employers;
  const list = targets.length > 0 ? targets : employers;

  const role = input.role?.trim() ?? "";
  const area: Area | null = input.location?.trim()
    ? { location: input.location.trim(), radiusMiles: input.radius_miles && input.radius_miles > 0 ? Math.round(input.radius_miles) : null }
    : null;
  const label = role || "All openings";
  status(`Storming the job boards of ${list.map((e) => e.name).join(", ")} for ${role ? `"${role}"` : "every open title shot"}...`);
  const outcomes = await Promise.all(list.map((e) => searchCompany(e, role, status, area)));
  const companies = outcomes.map((o) => o.result);
  const search: RoleSearch = { role: label, companies, ...(area?.radiusMiles ? { area: areaText(area) } : {}) };

  // Remember any new job-posting hosts we confirmed, so the next search looks there directly.
  const learned = new Map(list.map((e, i) => [e.name, outcomes[i].learnedHosts]));
  const updated = employers.map((e) => {
    const extra = learned.get(e.name) ?? [];
    return extra.length ? { ...e, boardDomains: uniq([...e.boardDomains, ...extra]).slice(0, 6) } : e;
  });

  return {
    search,
    employers: updated,
    forModel: JSON.stringify({
      note: "The app already shows these results to the user as a table grouped by company. Do not repeat the table.",
      role: label,
      location_filter: area?.radiusMiles ? areaText(area) : "none",
      results: companies.map((c) => ({
        company: c.company,
        job_board: c.boardUrl,
        postings: c.rows,
        ...(c.fallback ? { no_match_for_role: true, showing: "other current openings at this company" } : {}),
        ...(c.note ? { note: c.note } : {}),
      })),
    }),
  };
}


// ---------- Tool 3: area-wide "top contenders" ----------

const ATS_SEARCH_DOMAINS = [
  "myworkdayjobs.com", "myworkdaysite.com", "greenhouse.io", "lever.co", "ashbyhq.com", "icims.com",
  "paycomonline.net", "paycomonline.com", "smartrecruiters.com", "jobvite.com", "workable.com",
  "bamboohr.com", "paylocity.com", "ultipro.com", "applytojob.com",
];

// Highest annual figure stated in a pay string; hourly rates are annualized at 2,080 hours. 0 if no pay stated.
export function payScore(pay: string): number {
  if (!pay || /not listed/i.test(pay)) return 0;
  const hourly = /hour|hr\b|\/hr|per hr/i.test(pay);
  const nums = [...pay.matchAll(/\$\s?([\d,]+(?:\.\d+)?)\s*(k)?/gi)].map((m) => {
    const n = parseFloat(m[1].replace(/,/g, ""));
    return m[2] ? n * 1000 : n;
  });
  if (nums.length === 0) return 0;
  const top = Math.max(...nums);
  return hourly || top < 300 ? top * 2080 : top;
}

export async function runTopContenders(
  input: { location: string; radius_miles?: number; role?: string },
  status: Status,
): Promise<{ search: RoleSearch | null; forModel: string }> {
  const location = input.location?.trim();
  if (!location) {
    return { search: null, forModel: JSON.stringify({ error: "No location given. Ask the challenger where to search." }) };
  }
  const area: Area = { location, radiusMiles: input.radius_miles && input.radius_miles > 0 ? Math.round(input.radius_miles) : 25 };
  const role = input.role?.trim() ?? "";
  const what = role || "jobs";
  status(`Scouting every arena ${areaText(area)} for the top contenders...`);

  const [open, ats] = await Promise.all([
    tavilySearch(`${what} hiring ${location} salary apply`, { maxResults: 15, excludeDomains: BLOCKED_FOR_SEARCH }).catch(() => []),
    tavilySearch(`${what} ${location}`, { maxResults: 15, includeDomains: ATS_SEARCH_DOMAINS }).catch(() => []),
  ]);
  const seen = new Set<string>();
  const candidates: Candidate[] = [];
  for (const r of [...ats, ...open]) {
    const host = hostOf(r.url);
    const key = r.url.split("?")[0];
    if (!host || isBlockedHost(host) || seen.has(key) || !looksLikePosting(r.url, null)) continue;
    seen.add(key);
    candidates.push({ text: `${r.title} | ${r.content.replace(/\s+/g, " ").slice(0, 140)}`, url: r.url });
  }
  if (candidates.length === 0) {
    return { search: { role: role || "Top contenders", area: areaText(area), companies: [] }, forModel: JSON.stringify({ result: "No postings found in this area." }) };
  }

  const picks = await selectPostings("any employer", role, candidates, 8, area);
  const chosen = picks.map((i) => candidates[i]);
  status(`Tag partner Jax "The Jackhammer" Offerletter is tearing through ${chosen.length} postings ${areaText(area)}...`);
  const pages = (await Promise.all(chosen.map((c) => firecrawlScrape(c.url, { waitForMs: 1500 })))).filter(
    (p): p is NonNullable<typeof p> => p !== null && p.markdown.length > 150,
  );
  const rows = (await extractRows("", role, pages, area)).filter((r) => r.status !== "closed");

  // Group by employer; rank employers by their best stated pay, postings with pay first.
  const groups = new Map<string, typeof rows>();
  for (const r of rows) {
    const k = r.employer || "Unknown employer";
    groups.set(k, [...(groups.get(k) ?? []), r]);
  }
  const companies: CompanyResult[] = [...groups.entries()]
    .map(([company, rs]) => ({
      company,
      boardUrl: null,
      rows: rs.sort((a, b) => payScore(b.pay) - payScore(a.pay)),
    }))
    .sort((a, b) => payScore(b.rows[0].pay) - payScore(a.rows[0].pay));

  const search: RoleSearch = { role: role ? `Top contenders: ${role}` : "Top contenders", area: areaText(area), companies };
  return {
    search,
    forModel: JSON.stringify({
      note: "The app already shows these as a table grouped by employer, ranked by highest stated pay. Do not repeat the table.",
      area: areaText(area),
      ranking: "highest stated pay first; postings that hide pay rank last",
      results: companies.map((c) => ({ employer: c.company, postings: c.rows })),
    }),
  };
}
