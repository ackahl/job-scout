// Adzuna job-listings API: area-wide search with a radius, sortable by salary.
// Docs: https://developer.adzuna.com/docs/search  (distance is in kilometres; results_per_page max 50)

import type { Area, CompanyResult, RoleRow } from "./types";

export const adzunaEnabled = () => !!(process.env.ADZUNA_APP_ID && process.env.ADZUNA_APP_KEY);

type AdzunaJob = {
  title?: string;
  company?: { display_name?: string };
  location?: { display_name?: string };
  salary_min?: number;
  salary_max?: number;
  salary_is_predicted?: string | number;
  redirect_url?: string;
  created?: string;
};

const STATES: Record<string, string> = {
  AL: "Alabama", AK: "Alaska", AZ: "Arizona", AR: "Arkansas", CA: "California", CO: "Colorado", CT: "Connecticut",
  DE: "Delaware", FL: "Florida", GA: "Georgia", HI: "Hawaii", ID: "Idaho", IL: "Illinois", IN: "Indiana", IA: "Iowa",
  KS: "Kansas", KY: "Kentucky", LA: "Louisiana", ME: "Maine", MD: "Maryland", MA: "Massachusetts", MI: "Michigan",
  MN: "Minnesota", MS: "Mississippi", MO: "Missouri", MT: "Montana", NE: "Nebraska", NV: "Nevada", NH: "New Hampshire",
  NJ: "New Jersey", NM: "New Mexico", NY: "New York", NC: "North Carolina", ND: "North Dakota", OH: "Ohio",
  OK: "Oklahoma", OR: "Oregon", PA: "Pennsylvania", RI: "Rhode Island", SC: "South Carolina", SD: "South Dakota",
  TN: "Tennessee", TX: "Texas", UT: "Utah", VT: "Vermont", VA: "Virginia", WA: "Washington", WV: "West Virginia",
  WI: "Wisconsin", WY: "Wyoming", DC: "District of Columbia",
};

// "Yukon, OK" -> "Yukon, Oklahoma" (Adzuna matches full state names more reliably)
function expandState(location: string) {
  return location.replace(/,\s*([A-Za-z]{2})\s*$/, (m, st: string) => (STATES[st.toUpperCase()] ? `, ${STATES[st.toUpperCase()]}` : m));
}

async function page(where: string, what: string, km: number, n: number) {
  const params = new URLSearchParams({
    app_id: process.env.ADZUNA_APP_ID!,
    app_key: process.env.ADZUNA_APP_KEY!,
    where,
    distance: String(km),
    sort_by: "salary",
    results_per_page: "50",
    max_days_old: "30",
    "content-type": "application/json",
  });
  if (what) params.set("what", what);
  const res = await fetch(`https://api.adzuna.com/v1/api/jobs/us/search/${n}?${params}`, {
    signal: AbortSignal.timeout(20_000),
  });
  if (!res.ok) throw new Error(`Adzuna returned ${res.status}: ${(await res.text()).slice(0, 200)}`);
  return (await res.json()) as { count?: number; results?: AdzunaJob[] };
}

// Listings whose "salary" is really gross business revenue (truck owner-operators, lease-purchase).
const NOT_A_SALARY = /owner[\s/-]*op|lease[\s-]*(purchase|operator)|independent contractor/i;

// Common abbreviations users type in the job type box.
function expandRole(role: string): string[] {
  const r = role.trim();
  const extra: Record<string, string> = {
    hr: "human resources",
    it: "information technology",
    rn: "registered nurse",
    pm: "project manager",
    ops: "operations",
  };
  const more = extra[r.toLowerCase()];
  return more ? [r, more] : [r];
}

const money = (n: number) => `$${Math.round(n).toLocaleString("en-US")}`;

function payText(j: AdzunaJob): { text: string; stated: boolean; top: number } {
  const lo = j.salary_min ?? 0;
  const hi = j.salary_max ?? lo;
  const top = Math.max(lo, hi);
  if (!top) return { text: "Not listed", stated: false, top: 0 };
  const predicted = String(j.salary_is_predicted ?? "0") === "1";
  const range = lo && hi && lo !== hi ? `${money(lo)} - ${money(hi)}/yr` : `${money(top)}/yr`;
  return predicted ? { text: `Not listed (Adzuna est. ${range})`, stated: false, top } : { text: range, stated: true, top };
}

export async function adzunaTopJobs(
  area: Area,
  role: string,
  limit = 10,
): Promise<{ companies: CompanyResult[]; total: number; scanned: number }> {
  const km = Math.max(1, Math.round((area.radiusMiles ?? 25) * 1.609));
  let where = expandState(area.location);
  const terms = role ? expandRole(role) : [""];
  const fetchAll = (w: string) =>
    Promise.all(terms.flatMap((t) => (t ? [1, 2] : [1]).map((n) => page(w, t, km, n).catch(() => ({ count: 0, results: [] as AdzunaJob[] })))));
  let pages = await fetchAll(where);
  if (pages.every((p) => !p.count) && where !== area.location) {
    where = area.location;
    pages = await fetchAll(where);
  }
  // Adzuna's keyword search matches anywhere in the ad; keep only postings whose TITLE matches the job type,
  // so "HR" doesn't return a dentist whose ad mentions HR.
  const titleRe = role ? new RegExp(`\\b(${terms.map((t) => t.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")).join("|")})\\b`, "i") : null;
  // Without a job type, owner-operator ads (gross freight revenue, not pay) flood the top; read deeper.
  if (!role && (pages[0].count ?? 0) > 50) {
    const more = await Promise.all([2, 3].map((n) => page(where, "", km, n).catch(() => ({ results: [] as AdzunaJob[] }))));
    pages = [...pages, ...more.map((m) => ({ count: 0, results: m.results }))];
  }
  // Pages 1 and 2 of the same term report the same count; count each term once.
  const total = role ? Math.max(...pages.map((p) => p.count ?? 0)) : pages[0].count ?? 0;
  const seenJob = new Set<string>();
  const jobs = pages
    .flatMap((p) => p.results ?? [])
    .filter((j) => !NOT_A_SALARY.test(j.title ?? ""))
    .filter((j) => !titleRe || titleRe.test(j.title ?? ""))
    .filter((j) => {
      const k = `${(j.title ?? "").toLowerCase()}|${j.location?.display_name ?? ""}|${j.salary_max ?? ""}`;
      if (seenJob.has(k)) return false;
      seenJob.add(k);
      return true;
    });

  // Stated pay ranks above Adzuna's estimates; within each group, highest top-of-range first.
  const ranked = jobs
    .filter((j) => j.title && j.redirect_url)
    .map((j) => ({ j, pay: payText(j) }))
    .sort((a, b) => Number(b.pay.stated) - Number(a.pay.stated) || b.pay.top - a.pay.top)
    .slice(0, limit);

  const groups = new Map<string, RoleRow[]>();
  for (const { j, pay } of ranked) {
    const employer = j.company?.display_name?.trim() || "Employer not named";
    const row: RoleRow = {
      title: j.title!.replace(/<[^>]+>/g, "").trim(),
      location: j.location?.display_name ?? "Not listed",
      pay: pay.text,
      url: j.redirect_url!,
      status: "open",
      employer,
    };
    groups.set(employer, [...(groups.get(employer) ?? []), row]);
  }
  // Keep the pay ranking: employers appear in the order of their best posting.
  const companies: CompanyResult[] = [...groups.entries()].map(([company, rows]) => ({ company, boardUrl: null, rows }));
  return { companies, total: total || jobs.length, scanned: jobs.length };
}
