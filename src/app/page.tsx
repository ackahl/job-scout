"use client";

import { useEffect, useRef, useState } from "react";
import ReactMarkdown from "react-markdown";
import remarkGfm from "remark-gfm";
import { CaseFile } from "@/components/CaseFile";
import { SuspectBoard } from "@/components/SuspectBoard";
import { HomeTurf, type HomeBase } from "@/components/HomeTurf";
import { AGENT_NAME, AGENT_TITLE, OPENING_LINE } from "@/lib/persona";
import type { ChatTurn, Employer, RoleSearch, StreamEvent } from "@/lib/types";

type Item =
  | { kind: "user"; text: string }
  | { kind: "max"; text: string; notes?: string }
  | { kind: "roles"; search: RoleSearch }
  | { kind: "error"; text: string };

const SUGGESTIONS = [
  "Show me the top contenders near me",
  "Find me HR generalist jobs",
  "How should I answer 'tell me about yourself'?",
];

const SESSION_KEY = "job-scout:session";
const EMPLOYERS_KEY = "job-scout:employers";
const TURF_KEY = "job-scout:home-turf";

function newSessionId() {
  return typeof crypto !== "undefined" && "randomUUID" in crypto
    ? crypto.randomUUID()
    : `s-${Date.now()}-${Math.random().toString(36).slice(2)}`;
}

function store(key: string, value: string | null) {
  try {
    if (value === null) localStorage.removeItem(key);
    else localStorage.setItem(key, value);
  } catch {
    /* storage unavailable: keep going in memory */
  }
}

// Turn the visible conversation into alternating user/assistant turns for the API.
function toHistory(items: Item[]): ChatTurn[] {
  const turns: ChatTurn[] = [];
  for (const it of items) {
    let turn: ChatTurn | null = null;
    if (it.kind === "user") turn = { role: "user", content: it.text };
    if (it.kind === "max") turn = { role: "assistant", content: it.notes ? `${it.text}\n\n[Case notes: ${it.notes}]` : it.text };
    if (!turn) continue;
    const last = turns[turns.length - 1];
    if (last && last.role === turn.role) last.content += `\n\n${turn.content}`;
    else turns.push(turn);
  }
  return turns;
}

export default function Home() {
  const [items, setItems] = useState<Item[]>([]);
  const [employers, setEmployers] = useState<Employer[]>([]);
  const [turf, setTurf] = useState<HomeBase>({ location: "", radiusMiles: 25 });
  function updateTurf(v: HomeBase) {
    setTurf(v);
    store(TURF_KEY, JSON.stringify(v));
  }
  const [sessionId, setSessionId] = useState<string>("");
  const [input, setInput] = useState("");
  const [busy, setBusy] = useState(false);
  const [status, setStatus] = useState("");
  const bottomRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    let id = "";
    try {
      id = localStorage.getItem(SESSION_KEY) ?? "";
      const saved = localStorage.getItem(EMPLOYERS_KEY);
      if (saved) setEmployers(JSON.parse(saved) as Employer[]);
      const savedTurf = localStorage.getItem(TURF_KEY);
      if (savedTurf) setTurf(JSON.parse(savedTurf) as HomeBase);
    } catch {
      /* ignore */
    }
    if (!id) {
      id = newSessionId();
      store(SESSION_KEY, id);
    }
    setSessionId(id);
  }, []);

  useEffect(() => {
    bottomRef.current?.scrollIntoView({ behavior: "smooth", block: "end" });
  }, [items, status]);

  function newCase() {
    const id = newSessionId();
    store(SESSION_KEY, id);
    store(EMPLOYERS_KEY, null);
    setSessionId(id);
    setEmployers([]);
    setItems([]);
    setStatus("");
  }

  async function send(text: string) {
    const message = text.trim();
    if (!message || busy || !sessionId) return;
    const next: Item[] = [...items, { kind: "user", text: message }];
    setItems(next);
    setInput("");
    setBusy(true);
    setStatus("Max is lacing up his boots...");

    try {
      const res = await fetch("/api/chat", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          sessionId,
          messages: toHistory(next),
          employers,
          homeBase: turf.location.trim() ? { location: turf.location.trim(), radiusMiles: turf.radiusMiles } : null,
          jobType: turf.jobType?.trim() || null,
        }),
      });
      if (!res.ok || !res.body) {
        const err = (await res.json().catch(() => null)) as { error?: string } | null;
        throw new Error(err?.error ?? `Request failed (${res.status}).`);
      }

      const reader = res.body.getReader();
      const decoder = new TextDecoder();
      let buffer = "";
      for (;;) {
        const { value, done } = await reader.read();
        if (done) break;
        buffer += decoder.decode(value, { stream: true });
        const lines = buffer.split("\n");
        buffer = lines.pop() ?? "";
        for (const line of lines) {
          if (!line.trim()) continue;
          const event = JSON.parse(line) as StreamEvent;
          switch (event.type) {
            case "status":
              setStatus(event.text);
              break;
            case "employers":
              setEmployers(event.employers);
              store(EMPLOYERS_KEY, JSON.stringify(event.employers));
              break;
            case "roles":
              setItems((cur) => [...cur, { kind: "roles", search: event.search }]);
              break;
            case "text":
              setItems((cur) => [...cur, { kind: "max", text: event.text }]);
              break;
            case "notes":
              setItems((cur) => {
                const copy = [...cur];
                for (let i = copy.length - 1; i >= 0; i--) {
                  const it = copy[i];
                  if (it.kind === "max") {
                    copy[i] = { ...it, notes: event.text };
                    return copy;
                  }
                  if (it.kind === "user") break;
                }
                // No reply text this turn; keep the notes on an empty assistant entry so context survives.
                return [...copy, { kind: "max", text: "", notes: event.text }];
              });
              break;
            case "error":
              setItems((cur) => [...cur, { kind: "error", text: event.message }]);
              break;
          }
        }
      }
    } catch (error) {
      setItems((cur) => [
        ...cur,
        { kind: "error", text: error instanceof Error ? error.message : "Something went wrong." },
      ]);
    } finally {
      setBusy(false);
      setStatus("");
    }
  }

  return (
    <div className="arena flex min-h-dvh flex-col">
      <header className="border-b border-rope bg-arena/80 backdrop-blur">
        <div className="mx-auto flex max-w-4xl items-center justify-between gap-4 px-4 py-4">
          <div>
            <p className="font-cond text-xs font-bold uppercase tracking-[0.3em] text-electric">Job Scout Championship</p>
            <h1 className="gold-text font-poster text-4xl uppercase italic leading-none tracking-wide sm:text-5xl">{AGENT_NAME}</h1>
            <p className="mt-1 inline-block -skew-x-12 bg-neon px-2 font-poster text-xs uppercase tracking-widest text-arena sm:text-sm">
              <span className="inline-block skew-x-12">{AGENT_TITLE}</span>
            </p>
          </div>
          <button
            onClick={newCase}
            disabled={busy}
            className="shrink-0 -skew-x-12 border-2 border-gold px-3 py-1.5 font-poster text-sm uppercase tracking-wider text-gold transition hover:bg-gold hover:text-arena disabled:opacity-40"
          >
            <span className="inline-block skew-x-12">New match</span>
          </button>
        </div>
      </header>

      <SuspectBoard employers={employers} />
      <HomeTurf value={turf} onChange={updateTurf} onTopContenders={() => send("Show me the top contenders near me")} busy={busy || !sessionId} />

      <main className="mx-auto w-full max-w-4xl flex-1 space-y-5 px-4 py-6">
        <MaxPromo text={OPENING_LINE} />

        {items.length === 0 && (
          <div className="flex flex-wrap gap-2">
            {SUGGESTIONS.map((s) => (
              <button
                key={s}
                onClick={() => send(s)}
                disabled={busy || !sessionId}
                className="electric-box bg-canvas px-3 py-1.5 text-left font-cond text-base font-medium text-chalk transition hover:bg-electric hover:text-arena disabled:opacity-40"
              >
                {s}
              </button>
            ))}
          </div>
        )}

        {items.map((it, i) => {
          if (it.kind === "user") {
            return (
              <div key={i} className="flex justify-end">
                <div className="electric-box max-w-[85%] bg-apron px-4 py-2.5">
                  <div className="mb-0.5 text-right font-cond text-[11px] font-bold uppercase tracking-[0.25em] text-electric">The challenger</div>
                  <div className="font-cond text-lg font-medium leading-snug text-chalk">{it.text}</div>
                </div>
              </div>
            );
          }
          if (it.kind === "max") return it.text ? <MaxPromo key={i} text={it.text} /> : null;
          if (it.kind === "roles") return <CaseFile key={i} search={it.search} />;
          return (
            <div key={i} className="border border-over/70 bg-over/10 px-4 py-2 font-cond text-base font-bold text-[#ffb3b3]">
              {it.text}
            </div>
          );
        })}

        {busy && status && (
          <div className="pulse font-poster text-base uppercase tracking-wide text-gold" role="status" aria-live="polite">
            {status.replace(/\.\.\.$/, "")}
          </div>
        )}
        <div ref={bottomRef} />
      </main>

      <footer className="sticky bottom-0 border-t border-rope bg-arena/95 backdrop-blur">
        <form
          onSubmit={(e) => {
            e.preventDefault();
            send(input);
          }}
          className="mx-auto flex max-w-4xl gap-2 px-4 py-3"
        >
          <label htmlFor="msg" className="sr-only">
            Message {AGENT_NAME}
          </label>
          <input
            id="msg"
            value={input}
            onChange={(e) => setInput(e.target.value)}
            placeholder="Call out the companies, name the job..."
            autoComplete="off"
            className="min-w-0 flex-1 border border-rope bg-canvas px-3 py-2.5 font-cond text-lg text-chalk placeholder:text-chalk-dim/70 outline-none focus:border-electric"
          />
          <button
            type="submit"
            disabled={busy || !input.trim()}
            className="shrink-0 -skew-x-12 bg-neon px-4 py-2.5 font-poster text-base uppercase tracking-wider text-arena transition hover:bg-gold disabled:opacity-40"
          >
            <span className="inline-block skew-x-12">Ring the bell</span>
          </button>
        </form>
      </footer>
    </div>
  );
}

function MaxPromo({ text }: { text: string }) {
  return (
    <div className="flex">
      <div className="neon-box max-w-[92%] bg-canvas/95 px-5 py-4">
        <div className="mb-1.5 flex items-center gap-2">
          <span className="font-poster text-sm uppercase tracking-widest text-gold">{AGENT_NAME}</span>
          <span className="h-px flex-1 bg-gradient-to-r from-neon/70 to-transparent" />
        </div>
        <div className="max-text font-cond text-lg font-medium leading-snug text-chalk">
          <ReactMarkdown
            remarkPlugins={[remarkGfm]}
            components={{
              a: (props) => <a {...props} target="_blank" rel="noopener noreferrer" />,
            }}
          >
            {text}
          </ReactMarkdown>
        </div>
      </div>
    </div>
  );
}
