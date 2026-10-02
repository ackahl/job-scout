// Results of one find_open_roles call: a match card per company, each with a table of postings.

import type { RoleRow, RoleSearch } from "@/lib/types";

function StatusTag({ status }: { status: RoleRow["status"] }) {
  if (status === "open") return <span className="tag bg-live text-arena">LIVE</span>;
  if (status === "closed") return <span className="tag bg-over text-arena">OVER</span>;
  return <span className="tag bg-rope text-chalk-dim">TBD</span>;
}

function Pay({ pay }: { pay: string }) {
  if (/^not listed$/i.test(pay)) {
    return <span className="font-poster text-sm uppercase tracking-wide text-neon">Ducking it</span>;
  }
  return <span className="font-bold text-gold">{pay}</span>;
}

export function CaseFile({ search }: { search: RoleSearch }) {
  const total = search.companies.reduce((n, c) => n + c.rows.length, 0);
  return (
    <section aria-label={`Results for ${search.role}`} className="w-full">
      <div className="mb-3 flex flex-wrap items-end justify-between gap-2">
        <h2 className="font-poster text-2xl uppercase tracking-wide text-chalk">
          Match card: <span className="text-electric">{search.role}</span>
          {search.area && <span className="ml-2 font-cond text-base normal-case tracking-normal text-chalk-dim">{search.area}</span>}
        </h2>
        <span className="font-cond text-sm font-bold uppercase tracking-widest text-chalk-dim">
          {search.scanned !== undefined && <>Highest-paying of {search.scanned} postings scanned &middot; </>}
          {total} title shot{total === 1 ? "" : "s"} &middot; {search.companies.length} opponent
          {search.companies.length === 1 ? "" : "s"}
        </span>
      </div>

      <div className="space-y-4">
        {search.companies.map((c) => (
          <div key={c.company} className="neon-box overflow-hidden rounded-sm bg-canvas">
            <div className="flex items-center justify-between gap-3 bg-gradient-to-r from-neon/90 via-[#9b1d5c] to-canvas px-4 py-2">
              <div className="font-poster text-lg uppercase tracking-wide text-chalk">
                <span className="text-gold">Max</span> <span className="text-chalk/70">vs.</span> {c.company}
              </div>
              {c.boardUrl && (
                <a
                  href={c.boardUrl}
                  target="_blank"
                  rel="noopener noreferrer"
                  className="shrink-0 font-cond text-xs font-bold uppercase tracking-widest text-chalk/80 underline"
                >
                  Job board
                </a>
              )}
            </div>

            {c.rows.length === 0 ? (
              <p className="px-4 py-3 text-base text-chalk-dim">
                <span className="font-poster uppercase tracking-wide text-over">No-show.</span> {c.note ?? "Nothing turned up."}
              </p>
            ) : (
              <>
                {c.note && (
                  <p className="border-b border-rope/60 px-4 py-2 text-sm text-chalk-dim">
                    <span className="font-poster uppercase tracking-wide text-gold">Switch-up.</span> {c.note}
                  </p>
                )}
                {/* Table on wider screens */}
                <table className="hidden w-full border-collapse text-left text-base sm:table">
                  <thead>
                    <tr className="border-b border-rope font-cond text-xs font-bold uppercase tracking-[0.18em] text-chalk-dim">
                      <th className="px-4 py-2">Title shot</th>
                      <th className="px-4 py-2">Location</th>
                      <th className="px-4 py-2">Pay</th>
                      <th className="px-4 py-2">Status</th>
                    </tr>
                  </thead>
                  <tbody>
                    {c.rows.map((r) => (
                      <tr key={r.url} className="border-b border-rope/60 align-top last:border-0">
                        <td className="px-4 py-2.5">
                          <a
                            href={r.url}
                            target="_blank"
                            rel="noopener noreferrer"
                            className="font-bold text-electric underline decoration-electric/40 underline-offset-2 hover:decoration-electric"
                          >
                            {r.title}
                          </a>
                        </td>
                        <td className="px-4 py-2.5 text-chalk">{r.location}</td>
                        <td className="px-4 py-2.5">
                          <Pay pay={r.pay} />
                        </td>
                        <td className="px-4 py-2.5">
                          <StatusTag status={r.status} />
                        </td>
                      </tr>
                    ))}
                  </tbody>
                </table>

                {/* Stacked cards on phones */}
                <ul className="divide-y divide-rope/60 sm:hidden">
                  {c.rows.map((r) => (
                    <li key={r.url} className="px-4 py-3 text-base">
                      <div className="flex items-start justify-between gap-3">
                        <a href={r.url} target="_blank" rel="noopener noreferrer" className="font-bold text-electric underline">
                          {r.title}
                        </a>
                        <StatusTag status={r.status} />
                      </div>
                      <div className="mt-1 text-chalk-dim">{r.location}</div>
                      <div className="mt-0.5">
                        <Pay pay={r.pay} />
                      </div>
                    </li>
                  ))}
                </ul>
              </>
            )}
          </div>
        ))}
      </div>
    </section>
  );
}
