import { useEffect, useState } from 'react';

/** The time, renewed at each local minute boundary, so a clock that shows minutes changes the moment the minute does. */
export function useMinute(): Date {
  const [now, setNow] = useState(() => new Date());
  useEffect(() => {
    let timer = 0;
    const arm = () => {
      const t = new Date();
      timer = window.setTimeout(() => {
        setNow(new Date());
        arm();
      }, 60_000 - (t.getSeconds() * 1000 + t.getMilliseconds()) + 5);
    };
    // The page may have sat unrendered since the state was made.
    setNow(new Date());
    arm();
    return () => window.clearTimeout(timer);
  }, []);
  return now;
}
