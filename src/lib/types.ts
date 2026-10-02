// Shared shapes passed between the tools, the API route and the UI.

export type Employer = {
  name: string;
  boardUrl: string | null; // best guess at the company's job board
  boardDomains: string[]; // hosts searched when looking for postings
};

export type RoleRow = {
  title: string;
  location: string; // "Not listed" when the posting doesn't say
  pay: string; // "Not listed" when the posting doesn't say
  url: string;
  status: "open" | "closed" | "unverified";
};

export type Area = { location: string; radiusMiles: number | null }; // radiusMiles null = anywhere

export type CompanyResult = {
  company: string;
  boardUrl: string | null;
  rows: RoleRow[];
  note?: string; // why a company came back empty, or that these are fallback openings
  fallback?: boolean; // true when no postings matched the role and these are other openings
};

export type RoleSearch = {
  role: string;
  area?: string; // e.g. "within 25 mi of Yukon, OK"
  companies: CompanyResult[];
};

// One line of the NDJSON stream from /api/chat to the browser.
export type StreamEvent =
  | { type: "status"; text: string }
  | { type: "employers"; employers: Employer[] }
  | { type: "roles"; search: RoleSearch }
  | { type: "text"; text: string }
  | { type: "notes"; text: string }
  | { type: "error"; message: string }
  | { type: "done" };

export type ChatTurn = { role: "user" | "assistant"; content: string };
