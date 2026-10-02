// The saved employer list, shown as tonight's opponents.

import type { Employer } from "@/lib/types";

export function SuspectBoard({ employers }: { employers: Employer[] }) {
  return (
    <div className="border-y border-rope bg-apron/90">
      <div className="mx-auto flex max-w-4xl items-center gap-3 overflow-x-auto px-4 py-3">
        <span className="shrink-0 font-poster text-sm uppercase tracking-widest text-neon">Tonight&apos;s opponents</span>
        {employers.length === 0 ? (
          <span className="font-cond text-base text-chalk-dim">Nobody in the ring. Call somebody out.</span>
        ) : (
          employers.map((e) => (
            <div key={e.name} className="electric-box shrink-0 -skew-x-6 bg-canvas px-3 py-1.5">
              <div className="skew-x-6">
                <div className="font-poster text-base uppercase tracking-wide text-chalk">{e.name}</div>
                {e.boardUrl ? (
                  <a
                    href={e.boardUrl}
                    target="_blank"
                    rel="noopener noreferrer"
                    className="block max-w-[11rem] truncate font-cond text-xs text-electric underline"
                  >
                    {e.boardUrl.replace(/^https?:\/\/(www\.)?/, "")}
                  </a>
                ) : (
                  <div className="font-cond text-xs font-bold uppercase text-over">Board not found</div>
                )}
              </div>
            </div>
          ))
        )}
      </div>
    </div>
  );
}
