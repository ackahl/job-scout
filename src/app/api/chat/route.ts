// The agent loop. Claude reads the conversation, decides whether to call a tool,
// this route runs the tool, hands back the result, and repeats until Claude answers.
// Progress streams to the browser as newline-delimited JSON.

import Anthropic from "@anthropic-ai/sdk";
import { z } from "zod";
import { systemPrompt } from "@/lib/persona";
import { loadEmployers, saveEmployers, saveMessages, saveSearch } from "@/lib/store";
import { TOOL_DEFINITIONS, runFindOpenRoles, runTopContenders, runUpdateEmployerList } from "@/lib/tools";
import type { Employer, StreamEvent } from "@/lib/types";

export const runtime = "nodejs";
export const maxDuration = 120;

const PRIMARY_MODEL = process.env.CHAT_MODEL || "claude-sonnet-5-5";
const FALLBACK_MODEL = "claude-haiku-4-5-20251001";
const MAX_STEPS = 6;

const EmployerSchema = z.object({
  name: z.string().max(120),
  boardUrl: z.string().max(2000).nullable(),
  boardDomains: z.array(z.string().max(255)).max(8),
});

const BodySchema = z.object({
  sessionId: z.string().min(8).max(64),
  messages: z
    .array(z.object({ role: z.enum(["user", "assistant"]), content: z.string().max(8000) }))
    .min(1)
    .max(60),
  employers: z.array(EmployerSchema).max(10).default([]),
  homeBase: z
    .object({ location: z.string().max(120), radiusMiles: z.number().int().min(1).max(500).nullable() })
    .nullable()
    .optional(),
});

const UpdateInput = z.object({
  action: z.enum(["add", "remove", "replace"]),
  companies: z.array(z.string().max(120)).min(1).max(10),
});
const TopInput = z.object({
  location: z.string().max(120),
  radius_miles: z.number().min(0).max(500).optional(),
  role: z.string().max(200).optional(),
});
const FindInput = z.object({
  role: z.string().max(200).optional(),
  companies: z.array(z.string()).optional(),
  location: z.string().max(120).optional(),
  radius_miles: z.number().min(0).max(500).optional(),
});

function missingKeys() {
  return ["ANTHROPIC_API_KEY", "TAVILY_API_KEY", "FIRECRAWL_API_KEY"].filter((k) => !process.env[k]);
}

export async function POST(request: Request) {
  let body: z.infer<typeof BodySchema>;
  try {
    body = BodySchema.parse(await request.json());
  } catch {
    return Response.json({ error: "Bad request." }, { status: 400 });
  }

  const missing = missingKeys();
  if (missing.length) {
    return Response.json({ error: `Server is missing: ${missing.join(", ")}. Add them in Vercel env vars.` }, { status: 500 });
  }

  const { sessionId } = body;
  const encoder = new TextEncoder();

  const stream = new ReadableStream({
    async start(controller) {
      const send = (e: StreamEvent) => controller.enqueue(encoder.encode(JSON.stringify(e) + "\n"));
      const status = (text: string) => send({ type: "status", text });

      try {
        const stored = await loadEmployers(sessionId, body.employers);
        let employers: Employer[] = stored.length ? stored : body.employers;
        send({ type: "employers", employers });

        // Alternate user/assistant turns; Claude requires the first turn to be the user's.
        const history = body.messages.slice(-30);
        while (history.length && history[0].role !== "user") history.shift();
        const messages: Anthropic.MessageParam[] = history.map((m) => ({ role: m.role, content: m.content }));

        const client = new Anthropic();
        let model = PRIMARY_MODEL;
        const notes: string[] = [];
        let finalText = "";

        for (let step = 0; step < MAX_STEPS; step++) {
          status(step === 0 ? "Max is lacing up his boots..." : "Max is studying the tape...");

          let response: Anthropic.Message;
          try {
            response = await client.messages.create({
              model,
              max_tokens: 1500,
              system: systemPrompt(employers.map((e) => e.name), body.homeBase ?? null),
              tools: TOOL_DEFINITIONS,
              messages,
            });
          } catch (error) {
            // If the configured model isn't available on this API key, drop to a model that is.
            if (model !== FALLBACK_MODEL && error instanceof Anthropic.NotFoundError) {
              console.warn(`[chat] ${model} unavailable, falling back to ${FALLBACK_MODEL}`);
              model = FALLBACK_MODEL;
              step--;
              continue;
            }
            throw error;
          }

          const text = response.content
            .filter((b): b is Anthropic.TextBlock => b.type === "text")
            .map((b) => b.text)
            .join("\n")
            .trim();
          if (text) {
            send({ type: "text", text });
            finalText += (finalText ? "\n\n" : "") + text;
          }

          const toolCalls = response.content.filter((b): b is Anthropic.ToolUseBlock => b.type === "tool_use");
          if (response.stop_reason !== "tool_use" || toolCalls.length === 0) break;

          messages.push({ role: "assistant", content: response.content });
          const results: Anthropic.ToolResultBlockParam[] = [];

          for (const call of toolCalls) {
            let content: string;
            let isError = false;
            try {
              if (call.name === "update_employer_list") {
                const input = UpdateInput.parse(call.input);
                const out = await runUpdateEmployerList(input, employers, status);
                employers = out.employers;
                await saveEmployers(sessionId, employers);
                send({ type: "employers", employers });
                notes.push(`Employer list now: ${employers.map((e) => e.name).join(", ") || "empty"}.`);
                content = out.forModel;
              } else if (call.name === "find_open_roles") {
                const input = FindInput.parse(call.input);
                const out = await runFindOpenRoles(input, employers, status);
                if (JSON.stringify(out.employers) !== JSON.stringify(employers)) {
                  employers = out.employers;
                  await saveEmployers(sessionId, employers);
                  send({ type: "employers", employers });
                }
                if (out.search) {
                  send({ type: "roles", search: out.search });
                  await saveSearch(sessionId, out.search);
                  notes.push(
                    `Searched "${out.search.role}": ` +
                      out.search.companies
                        .map((c) => `${c.company} ${c.rows.length ? c.rows.map((r) => `${r.title} (${r.pay}, ${r.status})`).join("; ") : "none"}`)
                        .join(" | "),
                  );
                }
                content = out.forModel;
              } else if (call.name === "find_top_contenders") {
                const input = TopInput.parse(call.input);
                const out = await runTopContenders(input, status);
                if (out.search) {
                  send({ type: "roles", search: out.search });
                  await saveSearch(sessionId, out.search);
                  notes.push(
                    `Top contenders ${out.search.area ?? ""}: ` +
                      out.search.companies.map((c) => `${c.company}: ${c.rows.map((r) => `${r.title} (${r.pay})`).join("; ")}`).join(" | "),
                  );
                }
                content = out.forModel;
              } else {
                content = `Unknown tool: ${call.name}`;
                isError = true;
              }
            } catch (error) {
              console.error(`[chat] tool ${call.name}`, error);
              content = `Tool failed: ${error instanceof Error ? error.message : "unknown error"}`;
              isError = true;
            }
            results.push({ type: "tool_result", tool_use_id: call.id, content, is_error: isError });
          }
          messages.push({ role: "user", content: results });
        }

        // Compact record of what the tools found, so the next turn has context without re-running them.
        if (notes.length) send({ type: "notes", text: notes.join("\n") });

        const lastUser = history[history.length - 1];
        await saveMessages(sessionId, [
          ...(lastUser?.role === "user" ? [lastUser] : []),
          ...(finalText ? [{ role: "assistant" as const, content: finalText }] : []),
        ]);
      } catch (error) {
        console.error("[chat]", error);
        let message = "Something went wrong. Try again.";
        if (error instanceof Anthropic.AuthenticationError) message = "The Anthropic API key was rejected.";
        else if (error instanceof Anthropic.RateLimitError) message = "Rate limited. Wait a moment and try again.";
        else if (error instanceof Anthropic.APIError && (error.status ?? 0) >= 500) message = "The AI service is busy. Try again in a few seconds.";
        send({ type: "error", message });
      } finally {
        send({ type: "done" });
        controller.close();
      }
    },
  });

  return new Response(stream, {
    headers: { "Content-Type": "application/x-ndjson; charset=utf-8", "Cache-Control": "no-store" },
  });
}
