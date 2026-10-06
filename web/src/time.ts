export function relativeTime(iso: string, now: number = Date.now()): string {
  const seconds = Math.max(0, Math.round((now - Date.parse(iso)) / 1000));
  if (seconds < 45) return 'just now';
  const minutes = Math.round(seconds / 60);
  if (minutes < 60) return `${minutes} min ago`;
  const hours = Math.round(minutes / 60);
  if (hours < 24) return `${hours} h ago`;
  return `${Math.round(hours / 24)} d ago`;
}

const DAY_MS = 24 * 60 * 60 * 1000;

/** Whole days until `purgeAt`, a part day counting as one: 30 right after a delete, 1 on the last day, never below 0. */
export function daysLeft(purgeAt: string, now: number = Date.now()): number {
  return Math.max(0, Math.ceil((Date.parse(purgeAt) - now) / DAY_MS));
}

/** A Recently deleted row's countdown: "30 days left", "1 day left". */
export function daysLeftLabel(purgeAt: string, now: number = Date.now()): string {
  const n = daysLeft(purgeAt, now);
  return `${n} ${n === 1 ? 'day' : 'days'} left`;
}
