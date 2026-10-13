import { useEffect, useState } from 'react';

const QUERY = '(min-width: 960px)';

/** Whether the window is 960 px wide or more: the Board's wide layout (spec 2.2). Follows a resize. */
export function useWide(): boolean {
  const [wide, setWide] = useState(() => window.matchMedia(QUERY).matches);
  useEffect(() => {
    const query = window.matchMedia(QUERY);
    const onChange = () => setWide(query.matches);
    onChange();
    query.addEventListener('change', onChange);
    return () => query.removeEventListener('change', onChange);
  }, []);
  return wide;
}
