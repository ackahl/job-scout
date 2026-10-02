// The two custom tools. The tool descriptions are what the LLM reads to decide when to call them.

import type Anthropic from "@anthropic-ai/sdk";
import { companyTokens, hostOf, isAtsHost, isBlockedHost, looksLikePosting, pickBoard } from "./board";
import { extractRows } from "./extract";
import { firecrawlScrape, tavilySearch, type TavilyResult } from "./search";
import type { CompanyResult, Employer, RoleSearch } from "./types";

export const MAX_EMPLOYERS = 6;
const POSTINGS_PER_COMPANY = 5;

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
      "Search the saved companies' job boards for open postings matching a type of job, and return each posting's " +
      "title, location, pay, status and link. Call this when the user asks what jobs, openings, roles or positions " +
      "are available (e.g. 'any data analyst jobs?', 'find me HR manager roles'). The saved employer list must not be " +
      "empty; if the user names new companies in the same message, call update_employer_list first. " +
      "Do not call this for general career advice, interview prep, resume questions or salary negotiation.",
    input_schema: {
      type: "object",
      properties: {
        role: {
          type: "string",
          description: "The job type to search for, in plain words, e.g. 'data analyst' or 'HR business partner'.",
        },
        companies: {
          type: "array",
          items: { type: "string" },
          description: "Optional: limit the search to these saved companies. Omit to search every saved company.",
        },
      },
      required: ["role"],
    },
  },
];

type Status = (text: string) => void;

// ---------- Tool 1 ----------

async function findBoard(name: string): Promise<Employer> {
  const results = await tavilySearch(`${name} careers job openings official site`, { maxResults: 10 });
  const { boardUrl, boardDomains } = pickBoard(results, name);
  return { name, boardUrl, boardDomains };
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
    return { employers, forModel: JSON.stringify({ saved_companies: employers, removed: names }) };
  }

  const base = input.action === "replace" ? [] : current;
  const existing = new Set(base.map((e) => norm(e.name)));
  const toAdd = names.filter((n) => !existing.has(norm(n)));
  const room = Math.max(0, MAX_EMPLOYERS - base.length);
  const accepted = toAdd.slice(0, room);
  const rejected = toAdd.slice(room);

  status(`Scouting the arena for ${accepted.join(", ") || "nobody new"}... finding their job boards...`);
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

async function candidatePostings(employer: Employer, role: string): Promise<TavilyResult[]> {
  const tokens = companyTokens(employer.name);
  const keep = (r: TavilyResult) => {
    const host = hostOf(r.url);
    return !!host && !isBlockedHost(host) && looksLikePosting(r.url, employer.boardUrl);
  };

  let results: TavilyResult[] = [];
  if (employer.boardDomains.length > 0) {
    results = (
      await tavilySearch(`${role} job ${employer.name}`, { includeDomains: employer.boardDomains, maxResults: 10 })
    ).filter(keep);
  }

  // Fall back to an open web search, keeping only the company's own site or an ATS page that names the company.
  if (results.length < 2) {
    const open = await tavilySearch(`"${employer.name}" ${role} job opening apply`, { maxResults: 10 });
    const t = tokens[0] ?? "~";
    const extra = open.filter((r) => {
      if (!keep(r)) return false;
      const host = hostOf(r.url);
      const flat = (r.url + r.title).toLowerCase().replace(/[^a-z0-9]/g, "");
      return host.replace(/[^a-z0-9]/g, "").includes(t) || (isAtsHost(host) && flat.includes(t));
    });
    const seen = new Set(results.map((r) => r.url));
    results = [...results, ...extra.filter((r) => !seen.has(r.url))];
  }

  return results.sort((a, b) => b.score - a.score).slice(0, POSTINGS_PER_COMPANY);
}

async function searchCompany(employer: Employer, role: string, status: Status): Promise<CompanyResult> {
  const base = { company: employer.name, boardUrl: employer.boardUrl };
  try {
    const candidates = await candidatePostings(employer, role);
    if (candidates.length === 0) {
      return { ...base, rows: [], note: "No matching postings found on this company's job board." };
    }
    status(`Tag partner Jax "The Jackhammer" Offerletter is tearing through ${candidates.length} posting${candidates.length > 1 ? "s" : ""} at ${employer.name}...`);
    const pages = (await Promise.all(candidates.map((c) => firecrawlScrape(c.url)))).filter(
      (p): p is NonNullable<typeof p> => p !== null && p.markdown.length > 200,
    );
    if (pages.length === 0) {
      return { ...base, rows: [], note: "Found postings but none could be read." };
    }
    const rows = await extractRows(employer.name, role, pages);
    // Open postings first, then unverified, then closed.
    const order = { open: 0, unverified: 1, closed: 2 } as const;
    rows.sort((a, b) => order[a.status] - order[b.status]);
    return rows.length > 0
      ? { ...base, rows }
      : { ...base, rows: [], note: "Postings found, but none matched this role." };
  } catch (error) {
    console.error("[find_open_roles]", employer.name, error);
    return { ...base, rows: [], note: "Search failed for this company. Try again." };
  }
}

export async function runFindOpenRoles(
  input: { role: string; companies?: string[] },
  employers: Employer[],
  status: Status,
): Promise<{ search: RoleSearch | null; forModel: string }> {
  if (employers.length === 0) {
    return {
      search: null,
      forModel: JSON.stringify({ error: "No companies saved yet. Ask the user which companies to watch." }),
    };
  }
  const wanted = input.companies?.map((c) => c.trim().toLowerCase()).filter(Boolean);
  const targets = wanted?.length ? employers.filter((e) => wanted.includes(e.name.toLowerCase())) : employers;
  const list = targets.length > 0 ? targets : employers;

  status(`Storming the job boards of ${list.map((e) => e.name).join(", ")} for "${input.role}"...`);
  const companies = await Promise.all(list.map((e) => searchCompany(e, input.role, status)));
  const search: RoleSearch = { role: input.role, companies };

  return {
    search,
    forModel: JSON.stringify({
      note: "The app already shows these results to the user as a table grouped by company. Do not repeat the table.",
      role: input.role,
      results: companies.map((c) => ({
        company: c.company,
        job_board: c.boardUrl,
        postings: c.rows,
        ...(c.note ? { note: c.note } : {}),
      })),
    }),
  };
}
