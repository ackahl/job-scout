// Thin clients for the two outside services.
// Tavily finds pages (job boards, job postings). Firecrawl reads a page and returns clean text.

export type TavilyResult = { title: string; url: string; content: string; score: number };

export async function tavilySearch(
  query: string,
  opts: { includeDomains?: string[]; maxResults?: number } = {},
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
      topic: "general",
    }),
    signal: AbortSignal.timeout(20_000),
  });
  if (!res.ok) throw new Error(`Tavily returned ${res.status}: ${(await res.text()).slice(0, 200)}`);
  const data = (await res.json()) as { results?: TavilyResult[] };
  return data.results ?? [];
}

export type ScrapedPage = { url: string; markdown: string; title: string; statusCode: number };

export async function firecrawlScrape(url: string): Promise<ScrapedPage | null> {
  const key = process.env.FIRECRAWL_API_KEY;
  if (!key) throw new Error("FIRECRAWL_API_KEY is not set.");

  try {
    const res = await fetch("https://api.firecrawl.dev/v2/scrape", {
      method: "POST",
      headers: { "Content-Type": "application/json", Authorization: `Bearer ${key}` },
      body: JSON.stringify({
        url,
        formats: ["markdown"],
        onlyMainContent: true,
        timeout: 30_000,
        maxAge: 6 * 60 * 60 * 1000, // reuse a cached copy up to 6 hours old to save credits
      }),
      signal: AbortSignal.timeout(40_000),
    });
    if (!res.ok) {
      console.error("[firecrawl]", url, res.status, (await res.text()).slice(0, 200));
      return null;
    }
    const body = (await res.json()) as {
      success?: boolean;
      data?: { markdown?: string; metadata?: { title?: string | string[]; statusCode?: number } };
    };
    if (!body.success || !body.data) return null;
    const rawTitle = body.data.metadata?.title;
    return {
      url,
      markdown: body.data.markdown ?? "",
      title: Array.isArray(rawTitle) ? (rawTitle[0] ?? "") : (rawTitle ?? ""),
      statusCode: body.data.metadata?.statusCode ?? 200,
    };
  } catch (error) {
    console.error("[firecrawl]", url, error);
    return null;
  }
}
