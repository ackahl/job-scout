// Thin clients for the two outside services.
// Tavily finds pages (job boards, job postings). Firecrawl opens a page, runs its JavaScript,
// and returns clean text plus the links on it.

export type TavilyResult = { title: string; url: string; content: string; score: number };

export async function tavilySearch(
  query: string,
  opts: { includeDomains?: string[]; excludeDomains?: string[]; maxResults?: number } = {},
): Promise<TavilyResult[]> {
  const key = process.env.TAVILY_API_KEY;
  if (!key) throw new Error("TAVILY_API_KEY is not set.");

  const res = await fetch("https://api.tavily.com/search", {
    method: "POST",
    headers: { "Content-Type": "application/json", Authorization: `Bearer ${key}` },
    body: JSON.stringify({
      query,
      search_depth: "basic",
      max_results: opts.maxResults ?? 10,
      include_domains: opts.includeDomains ?? [],
      exclude_domains: opts.excludeDomains ?? [],
      topic: "general",
    }),
    signal: AbortSignal.timeout(20_000),
  });
  if (!res.ok) throw new Error(`Tavily returned ${res.status}: ${(await res.text()).slice(0, 200)}`);
  const data = (await res.json()) as { results?: TavilyResult[] };
  return data.results ?? [];
}

export type ScrapedPage = {
  url: string; // the URL we asked for
  finalUrl: string; // where the page ended up after redirects
  markdown: string;
  title: string;
  statusCode: number;
};

export async function firecrawlScrape(
  url: string,
  opts: { waitForMs?: number; mainContentOnly?: boolean } = {},
): Promise<ScrapedPage | null> {
  const key = process.env.FIRECRAWL_API_KEY;
  if (!key) throw new Error("FIRECRAWL_API_KEY is not set.");

  try {
    const res = await fetch("https://api.firecrawl.dev/v2/scrape", {
      method: "POST",
      headers: { "Content-Type": "application/json", Authorization: `Bearer ${key}` },
      body: JSON.stringify({
        url,
        formats: ["markdown"],
        onlyMainContent: opts.mainContentOnly ?? true,
        waitFor: opts.waitForMs ?? 0,
        timeout: 45_000,
        maxAge: 6 * 60 * 60 * 1000, // reuse a cached copy up to 6 hours old to save credits
      }),
      signal: AbortSignal.timeout(55_000),
    });
    if (!res.ok) {
      console.error("[firecrawl]", url, res.status, (await res.text()).slice(0, 200));
      return null;
    }
    const body = (await res.json()) as {
      success?: boolean;
      data?: {
        markdown?: string;
        metadata?: { title?: string | string[]; statusCode?: number; url?: string; sourceURL?: string };
      };
    };
    if (!body.success || !body.data) return null;
    const meta = body.data.metadata ?? {};
    const rawTitle = meta.title;
    return {
      url,
      finalUrl: meta.url || url,
      markdown: body.data.markdown ?? "",
      title: Array.isArray(rawTitle) ? (rawTitle[0] ?? "") : (rawTitle ?? ""),
      statusCode: meta.statusCode ?? 200,
    };
  } catch (error) {
    console.error("[firecrawl]", url, error);
    return null;
  }
}

// Pull [text](url) links out of Firecrawl markdown. Job boards put each posting's title in the link text.
export function markdownLinks(markdown: string): { text: string; url: string }[] {
  const out: { text: string; url: string }[] = [];
  const seen = new Set<string>();
  const re = /\[((?:[^\[\]]|\[[^\]]*\])*)\]\((https?:\/\/[^)\s]+)\)/g;
  let m: RegExpExecArray | null;
  while ((m = re.exec(markdown))) {
    const url = m[2];
    const text = m[1]
      .replace(/\\+n/g, "\n")
      .replace(/\\/g, "")
      .replace(/\*\*/g, "")
      .split("\n")
      .map((s) => s.trim())
      .filter(Boolean)
      .slice(0, 3)
      .join(" | ")
      .slice(0, 160);
    if (!text || text.startsWith("!") || seen.has(url)) continue;
    seen.add(url);
    out.push({ text, url });
  }
  return out;
}
