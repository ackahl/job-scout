// Persistence. With Supabase configured, the employer list, every role search and the
// chat transcript are saved per browser session. Without it, the browser holds the list
// and sends it back with each message, so the app still works.

import { createClient, type SupabaseClient } from "@supabase/supabase-js";
import type { Employer, RoleSearch } from "./types";

let client: SupabaseClient | null | undefined;

function db(): SupabaseClient | null {
  if (client !== undefined) return client;
  const url = process.env.SUPABASE_URL;
  const key = process.env.SUPABASE_SERVICE_ROLE_KEY;
  client = url && key ? createClient(url, key, { auth: { persistSession: false } }) : null;
  return client;
}

export const storageEnabled = () => db() !== null;

export async function loadEmployers(sessionId: string, fallback: Employer[]): Promise<Employer[]> {
  const supabase = db();
  if (!supabase) return fallback;
  const { data, error } = await supabase
    .from("employers")
    .select("name, board_url, board_domains")
    .eq("session_id", sessionId)
    .order("created_at", { ascending: true });
  if (error) {
    console.error("[store] loadEmployers", error.message);
    return fallback;
  }
  return (data ?? []).map((r) => ({ name: r.name, boardUrl: r.board_url, boardDomains: r.board_domains ?? [] }));
}

export async function saveEmployers(sessionId: string, employers: Employer[]): Promise<void> {
  const supabase = db();
  if (!supabase) return;
  // Replace the session's list with the current one.
  const del = await supabase.from("employers").delete().eq("session_id", sessionId);
  if (del.error) console.error("[store] saveEmployers delete", del.error.message);
  if (employers.length === 0) return;
  const { error } = await supabase.from("employers").insert(
    employers.map((e) => ({
      session_id: sessionId,
      name: e.name,
      board_url: e.boardUrl,
      board_domains: e.boardDomains,
    })),
  );
  if (error) console.error("[store] saveEmployers insert", error.message);
}

export async function saveSearch(sessionId: string, search: RoleSearch): Promise<void> {
  const supabase = db();
  if (!supabase) return;
  const { error } = await supabase
    .from("role_searches")
    .insert({ session_id: sessionId, role: search.role, results: search.companies });
  if (error) console.error("[store] saveSearch", error.message);
}

export async function saveMessages(
  sessionId: string,
  messages: { role: "user" | "assistant"; content: string }[],
): Promise<void> {
  const supabase = db();
  if (!supabase || messages.length === 0) return;
  const { error } = await supabase
    .from("chat_messages")
    .insert(messages.map((m) => ({ session_id: sessionId, role: m.role, content: m.content })));
  if (error) console.error("[store] saveMessages", error.message);
}
