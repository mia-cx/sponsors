/* Booking and rotation rules. Pure functions, so tests can run them without a database. */
const DAY = 86_400_000;

export const toDb = (ms: number) => new Date(ms).toISOString().slice(0, 19).replace('T', ' ');
export const fromDb = (s: string) => Date.parse(s.replace(' ', 'T') + (/[zZ]|[+-]\d\d:?\d\d$/.test(s) ? '' : 'Z'));

export interface Window { starts: number; ends: number }

/** Most windows that overlap at any moment within [starts, ends). */
export function peakLoad(windows: Window[], starts: number, ends: number): number {
  const events: [number, number][] = [];
  for (const w of windows) {
    if (w.ends <= starts || w.starts >= ends) continue;
    events.push([Math.max(w.starts, starts), 1], [w.ends, -1]);
  }
  // Ends sort before starts at the same instant, so back-to-back campaigns don't count as overlapping.
  events.sort((a, b) => a[0] - b[0] || a[1] - b[1]);
  let load = 0, peak = 0;
  for (const [, d] of events) { load += d; peak = Math.max(peak, load); }
  return peak;
}

/** Earliest start at or after `desired` where a campaign of `days` fits under the cap. */
export function nextFreeStart(windows: Window[], cap: number, desired: number, days: number): number {
  const length = days * DAY;
  const candidates = [desired, ...windows.map(w => w.ends).filter(e => e > desired)].sort((a, b) => a - b);
  for (const start of candidates) if (peakLoad(windows, start, start + length) < cap) return start;
  // Unreachable: after the last booking ends the placement is empty.
  return candidates.at(-1)!;
}

export interface AdRow {
  id: number; sponsor: string; placement: string; creative_hash: string;
  starts_at: string; ends_at: string;
}

/**
 * Collapses mirrored campaigns: the same sponsor, placement and creative running at the same time.
 * The first row stands for the group and is marked mirrored, so the page shows it on both sides at once.
 */
export function collapseMirrored<T extends AdRow>(rows: T[]): (T & {mirrored: boolean})[] {
  const groups = new Map<string, T[]>();
  for (const r of rows) {
    const key = `${r.sponsor}\u0000${r.placement}\u0000${r.creative_hash}`;
    groups.set(key, [...(groups.get(key) ?? []), r]);
  }
  return [...groups.values()].map(g => ({...g[0], mirrored: g.length > 1})).sort((a, b) => a.id - b.id);
}

/** Days a custom one-time amount buys, or 0 when it's under the minimum. */
export function customDays(dollars: number, daysPerDollar: number, minDays: number): number {
  const days = Math.floor(dollars * daysPerDollar);
  return days >= minDays ? days : 0;
}
