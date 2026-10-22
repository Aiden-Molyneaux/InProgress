import type { SyncFile } from '../../../src/core/types';

/** One adopted template as the Docs index lists it. */
export interface AdaptationRow {
  /** The template path: the pick's key. */
  template: string;
  /** AGT for `agents/`, SKL for `skills/`, else KIT. */
  kind: 'AGT' | 'SKL' | 'KIT';
  name: string;
  /** What the state column says, and whether it is plain, the behind colour or the alarm one. */
  state: { text: string; tone: 'plain' | 'behind' | 'alarm' };
  /** `N file fill(s)`, or null when the file has none. */
  fills: string | null;
}

/** A template's name: a skill's folder, an agent's file stem, else the file name. */
export function adaptationName(template: string): string {
  const parts = template.split('/');
  if (parts[0] === 'skills' && parts.length > 2) return parts[1];
  const file = parts[parts.length - 1];
  return parts[0] === 'agents' ? file.replace(/\.[^.]+$/, '') : file;
}

export function adaptationRow(file: SyncFile): AdaptationRow {
  const top = file.template.split('/')[0];
  const fills = Object.keys(file.fills).length;
  return {
    template: file.template,
    kind: top === 'agents' ? 'AGT' : top === 'skills' ? 'SKL' : 'KIT',
    name: adaptationName(file.template),
    state:
      file.state === 'current'
        ? { text: 'current', tone: 'plain' }
        : file.state === 'behind'
          ? { text: `${file.behind} behind`, tone: 'behind' }
          : { text: file.state, tone: 'alarm' },
    fills: fills > 0 ? `${fills} file fill${fills === 1 ? '' : 's'}` : null,
  };
}
