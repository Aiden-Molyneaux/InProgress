import type { DB } from '../db/connection';

/*
 * The project's settings are lead_events rows of kind 'setting' (lead stage 1, #743), their text `<key> <value>`; the
 * newest row of a key wins. `lead set` writes them. Quiet hours and the Voice's daily cap live here; the lead's thread and
 * the turn way (task 12) are further keys.
 */

/** The keys `lead set` accepts, each with how its value is checked: the sentence that says what is wrong, or null when it is fine. */
export const SETTING_KEYS: Record<string, (value: string) => string | null> = {
  quiet: (v) => (parseQuiet(v) === undefined ? 'quiet hours are written HH:MM-HH:MM, for example 23:00-08:00.' : null),
  'voice-cap': (v) => (/^\d{1,3}$/.test(v) && Number(v) >= 1 ? null : 'voice-cap is a whole number of lines a day, 1 or more.'),
  'lead-thread': (v) => (v === 'on' || v === 'off' ? null : 'lead-thread is on or off.'),
  'turn-way': (v) => (v === 'thread' || v === 'headless' ? null : 'turn-way is thread or headless.'),
};

/** Quiet hours when none are set: midnight to nine in the morning, local time. */
export const DEFAULT_QUIET = '00:00-09:00';
/** The Voice's lines a day when none is set. */
export const DEFAULT_VOICE_CAP = 12;

/** `HH:MM-HH:MM` as minutes of the day (from, to), or undefined when it is not that. */
export function parseQuiet(text: string): { from: number; to: number } | undefined {
  const m = /^(\d{1,2}):(\d{2})-(\d{1,2}):(\d{2})$/.exec(text.trim());
  if (m === null) return undefined;
  const [h1, m1, h2, m2] = [Number(m[1]), Number(m[2]), Number(m[3]), Number(m[4])];
  if (h1 > 23 || h2 > 23 || m1 > 59 || m2 > 59) return undefined;
  return { from: h1 * 60 + m1, to: h2 * 60 + m2 };
}

/** The newest value of a setting of the project, or undefined when it was never set. */
export function settingOf(db: DB, projectId: number, key: string): string | undefined {
  const text = db
    .prepare("SELECT text FROM lead_events WHERE project_id = ? AND kind = 'setting' AND substr(text, 1, ?) = ? ORDER BY at DESC, id DESC LIMIT 1")
    .pluck()
    .get(projectId, key.length + 1, `${key} `) as string | undefined;
  return text === undefined ? undefined : text.slice(key.length + 1).trim();
}

/** The project's quiet hours, as minutes of the local day. */
export function quietHours(db: DB, projectId: number): { from: number; to: number } {
  return (parseQuiet(settingOf(db, projectId, 'quiet') ?? '') ?? parseQuiet(DEFAULT_QUIET))!;
}

/** The Voice's lines a day for the project. */
export function voiceCap(db: DB, projectId: number): number {
  const v = settingOf(db, projectId, 'voice-cap');
  return v !== undefined && /^\d+$/.test(v) && Number(v) >= 1 ? Number(v) : DEFAULT_VOICE_CAP;
}

/** Whether the lead's own thread in T3 Code is on for the project (task 12): `lead set <slug> lead-thread on`. */
export const leadThreadOn = (db: DB, projectId: number): boolean => settingOf(db, projectId, 'lead-thread') === 'on';

/** The way the project's desk turns run (task 12): the lead's thread when `turn-way thread` is set, else headless. */
export const turnWayOf = (db: DB, projectId: number): 'headless' | 'thread' => (settingOf(db, projectId, 'turn-way') === 'thread' ? 'thread' : 'headless');
