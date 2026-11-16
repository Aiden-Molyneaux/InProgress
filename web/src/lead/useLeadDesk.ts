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
 * The open project's lead brief and log. Loaded only while the Lead view is open and the project's snapshot has landed
 * (`tick` is not null): when it opens, when the project changes and each time `tick` changes (the window's snapshot, which
 * it refreshes on every stream event for the project). An answer is applied when it is newer than the last one applied, as
 * the window's own snapshot load does: under steady events a newer request is nearly always in flight, and waiting for the
 * newest to land would starve the view. A failed load keeps the last desk of the same project and sets the error; a
 * request starting clears that project's error. The read is the window's: it never marks the brief as read.
 */
export function useLeadDesk(slug: string | null, open: boolean, tick: unknown): LeadDesk {
  const [desk, setDesk] = useState<{ slug: string; brief: LeadBrief; events: LeadEventOut[] } | null>(null);
  const [failed, setFailed] = useState<{ slug: string; message: string } | null>(null);
  const seq = useRef(0);
  const applied = useRef(0);
  const current = useRef<string | null>(slug);
  current.current = slug;
  useEffect(() => {
    if (!slug || !open || tick == null) return;
    const at = ++seq.current;
    setFailed((cur) => (cur && cur.slug === slug ? null : cur));
    Promise.all([api.leadBrief(slug), api.leadEvents(slug)]).then(
      ([{ brief }, { events }]) => {
        // Another project's answer is dropped; an older one than what is on screen is too.
        if (current.current !== slug || at <= applied.current) return;
        applied.current = at;
        setDesk({ slug, brief, events });
        setFailed(null);
      },
      (e: Error) => {
        if (current.current !== slug || at <= applied.current) return;
        applied.current = at;
        setFailed({ slug, message: e.message });
      },
    );
  }, [slug, open, tick]);
  const mine = desk && desk.slug === slug ? desk : null;
  return { brief: mine ? mine.brief : null, events: mine ? mine.events : null, error: failed && failed.slug === slug ? failed.message : null };
}
