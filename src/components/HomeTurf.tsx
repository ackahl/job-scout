"use client";

// Where the challenger is searching from: a city/state plus a radius. Saved in this browser.

import { useState } from "react";

export type HomeBase = { location: string; radiusMiles: number | null };

const RADII: { label: string; value: number | null }[] = [
  { label: "10 mi", value: 10 },
  { label: "25 mi", value: 25 },
  { label: "50 mi", value: 50 },
  { label: "100 mi", value: 100 },
  { label: "Anywhere", value: null },
];

export function HomeTurf({
  value,
  onChange,
  onTopContenders,
  busy,
}: {
  value: HomeBase;
  onChange: (v: HomeBase) => void;
  onTopContenders: () => void;
  busy: boolean;
}) {
  const [locating, setLocating] = useState(false);
  const [error, setError] = useState("");

  function useMyLocation() {
    if (!("geolocation" in navigator)) {
      setError("This browser can't share location. Type a city instead.");
      return;
    }
    setLocating(true);
    setError("");
    navigator.geolocation.getCurrentPosition(
      async (pos) => {
        try {
          const { latitude, longitude } = pos.coords;
          const res = await fetch(
            `https://nominatim.openstreetmap.org/reverse?format=json&zoom=10&lat=${latitude}&lon=${longitude}`,
            { headers: { Accept: "application/json" } },
          );
          const data = (await res.json()) as { address?: Record<string, string> };
          const a = data.address ?? {};
          const city = a.city || a.town || a.village || a.county || "";
          const state = a.state || "";
          const place = [city, state].filter(Boolean).join(", ");
          if (!place) throw new Error("no place");
          onChange({ ...value, location: place, radiusMiles: value.radiusMiles ?? 25 });
        } catch {
          setError("Couldn't look up your city. Type it instead.");
        } finally {
          setLocating(false);
        }
      },
      () => {
        setLocating(false);
        setError("Location permission was denied. Type a city instead.");
      },
      { timeout: 10_000 },
    );
  }

  return (
    <div className="border-b border-rope bg-canvas/80">
      <div className="mx-auto flex max-w-4xl flex-wrap items-center gap-2 px-4 py-2.5">
        <label htmlFor="turf" className="shrink-0 font-poster text-sm uppercase tracking-widest text-electric">
          Home turf
        </label>
        <input
          id="turf"
          value={value.location}
          onChange={(e) => onChange({ ...value, location: e.target.value })}
          placeholder="City, ST (e.g. Yukon, OK)"
          className="min-w-0 flex-1 basis-40 border border-rope bg-arena px-2.5 py-1.5 font-cond text-base text-chalk placeholder:text-chalk-dim/60 outline-none focus:border-electric"
        />
        <select
          aria-label="Search radius"
          value={value.radiusMiles === null ? "any" : String(value.radiusMiles)}
          onChange={(e) => onChange({ ...value, radiusMiles: e.target.value === "any" ? null : Number(e.target.value) })}
          className="border border-rope bg-arena px-2 py-1.5 font-cond text-base text-chalk outline-none focus:border-electric"
        >
          {RADII.map((r) => (
            <option key={r.label} value={r.value === null ? "any" : String(r.value)}>
              {r.label}
            </option>
          ))}
        </select>
        <button
          type="button"
          onClick={useMyLocation}
          disabled={locating}
          className="electric-box shrink-0 bg-arena px-2.5 py-1.5 font-cond text-sm font-bold uppercase tracking-wider text-electric transition hover:bg-electric hover:text-arena disabled:opacity-50"
        >
          {locating ? "Locating..." : "Use my location"}
        </button>
        <button
          type="button"
          onClick={onTopContenders}
          disabled={busy}
          className="shrink-0 -skew-x-12 bg-gold px-3 py-1.5 font-poster text-sm uppercase tracking-wider text-arena transition hover:bg-neon disabled:opacity-40"
        >
          <span className="inline-block skew-x-12">Top contenders</span>
        </button>
        {error && <p className="w-full font-cond text-sm text-over">{error}</p>}
      </div>
    </div>
  );
}
