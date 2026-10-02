import { useEffect, useState } from 'react';

/** The time (ms), refreshed every `intervalMs`: for labels such as "2 min ago" that age while nothing else changes. */
export function useNow(intervalMs: number): number {
  const [now, setNow] = useState(Date.now());
  useEffect(() => {
    const t = window.setInterval(() => setNow(Date.now()), intervalMs);
    return () => window.clearInterval(t);
  }, [intervalMs]);
  return now;
}
