import { useEffect, useRef, useState } from 'react';
import type { LeadBrief, LeadEventOut } from '../../../src/core/lead';
import { api } from '../api';

export interface LeadDesk {
  /** The project's brief, or null until it has loaded for this slug. */
  brief: LeadBrief | null;
  /** The lead's log, newest first, or null until it has loaded for this slug. */
  events: LeadEventOut[] | null;
  error: string | null;
}

/**
 * The open project's lead brief and log. Loaded only while the Lead view is open: when it opens, when the project changes
 * and each time `tick` changes (the window's snapshot, which it refreshes on every stream event for the project). A
 * sequence number keeps an older answer from landing over a newer one, and a failed load keeps the last desk of the same
 * project and sets the error. The read is the window's: it never marks the brief as read.
 */
export function useLeadDesk(slug: string | null, open: boolean, tick: unknown): LeadDesk {
  const [desk, setDesk] = useState<{ slug: string; brief: LeadBrief; events: LeadEventOut[] } | null>(null);
  const [failed, setFailed] = useState<{ slug: string; message: string } | null>(null);
  const seq = useRef(0);
  useEffect(() => {
    if (!slug || !open) return;
    const at = ++seq.current;
    Promise.all([api.leadBrief(slug), api.leadEvents(slug)]).then(
      ([{ brief }, { events }]) => {
        if (at !== seq.current) return;
        setDesk({ slug, brief, events });
        setFailed(null);
      },
      (e: Error) => at === seq.current && setFailed({ slug, message: e.message }),
    );
  }, [slug, open, tick]);
  const mine = desk && desk.slug === slug ? desk : null;
  return { brief: mine ? mine.brief : null, events: mine ? mine.events : null, error: failed && failed.slug === slug ? failed.message : null };
}
