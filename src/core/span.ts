const DAY_MS = 24 * 60 * 60 * 1000;

/** Shorter spans too: "2m", "3h", "4d"; "<1m" under a minute. */
export function spanAgo(iso: string, now: number): string {
  const age = now - Date.parse(iso);
  if (!(age >= 60_000)) return '<1m';
  if (age < 60 * 60_000) return `${Math.floor(age / 60_000)}m`;
  if (age < DAY_MS) return `${Math.floor(age / (60 * 60_000))}h`;
  return `${Math.floor(age / DAY_MS)}d`;
}

const pad = (n: number): string => String(n).padStart(2, '0');
/** Local `2026-10-10 12:15`. */
export function stamp(iso: string): string {
  const d = new Date(iso);
  return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())} ${pad(d.getHours())}:${pad(d.getMinutes())}`;
}
