# Job Scout: Max Payroll

A chat agent that finds open jobs at the companies you choose and compares them in a table, grouped by company, with a link to each posting. It talks like Max Payroll, "The Salary Cap Crusher," an original 80s-style wrestling character who cuts a promo on every search.

Built for MBA 14563, Sprint 7 (Agent Building).

## How it works

The LLM (Claude) gets two custom tools and decides on its own when to call them.

| Tool | Claude calls it when | Input | Returns |
|---|---|---|---|
| `update_employer_list` | the user names companies to watch | company names | each company and a link to its job board |
| `find_open_roles` | the user asks about a type of job | a job title, e.g. "data analyst" | each matching job: title, company, location, pay, status, link |

Questions that aren't about job listings (interview prep, resumes) get a normal answer with no tool call.

Tool pipeline:

1. **Tavily** searches the web for each company's job board (Tool 1), then for postings on that board (Tool 2).
2. **Firecrawl** opens each posting and returns clean text.
3. **Claude Haiku** reads that text and pulls out title, location, pay and whether the posting is still open. Pay and location appear only if the posting states them, otherwise "Not listed." Links always come from the URL that was actually read.
4. The table is drawn by the app from the tool's data, not typed by the LLM, so links can't be invented.

Code map:

- `src/app/api/chat/route.ts`: agent loop (Claude, then tool calls, then tool results, repeated until Claude answers)
- `src/lib/tools.ts`: tool definitions and code
- `src/lib/persona.ts`: system prompt (personality and rules)
- `src/lib/search.ts`: Tavily and Firecrawl clients
- `src/lib/extract.ts`: posting-field extraction
- `src/lib/store.ts`: Supabase storage (employer lists, searches, chat transcripts)
- `supabase/schema.sql`: database tables

## Environment variables

See `.env.example`. Required: `ANTHROPIC_API_KEY`, `TAVILY_API_KEY`, `FIRECRAWL_API_KEY`. Optional: `SUPABASE_URL`, `SUPABASE_SERVICE_ROLE_KEY` (the app runs without storage if these are blank).

## Run locally

```
npm install
copy .env.example .env.local   (then fill in the keys)
npm run dev
```

Stack: Next.js, Tailwind CSS, Supabase, Vercel, Claude Code.
