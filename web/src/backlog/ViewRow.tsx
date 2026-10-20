import type { KeyboardEvent, MouseEvent, ReactNode } from 'react';
import { LABEL_GLYPHS, type NodeLabel } from '../../../src/core/types';
import { Chip } from '../parts/Chip';
import type { CursorItemProps } from '../parts/ListCursor';

/**
 * One row of the full Backlog, open or parked: `#id`, the title, then the extras (the parent's name, BLOCKED, how many
 * steps are open inside, the label, the age) and the actions, which show on hover and on focus. `children` is a
 * full-width block under that line: an open Park form or Confirm, or a parked row's reason.
 */
export function ViewRow({ id, title, cursor, phase, blocked, inside, label, age, acts, pending, confirming, parked, onOpen, onMouseDown, onKeyDown, children }: {
  id: number;
  title: string;
  cursor: CursorItemProps;
  /** The parent's name, in mono dim: under the ID and Age sorts, and on a parked row. */
  phase?: string | null;
  blocked?: boolean;
  /** Steps open below this one; none shown at 0. */
  inside: number;
  label: NodeLabel | null;
  /** Already worded ("3d"); null when the step has none. */
  age: string | null;
  /** The action buttons; they carry `data-act`. */
  acts: ReactNode;
  pending?: boolean;
  confirming?: boolean;
  parked?: boolean;
  onOpen: (event: MouseEvent<HTMLLIElement>) => void;
  onMouseDown?: (event: MouseEvent<HTMLLIElement>) => void;
  onKeyDown?: (event: KeyboardEvent<HTMLLIElement>) => void;
  children?: ReactNode;
}) {
  const { onKeyDown: cursorKeys, ...rest } = cursor;
  return (
    <li
      {...rest}
      className={`ip-bl-row${parked ? ' ip-bl-parkedrow' : ''}${pending ? ' pending' : ''}${confirming ? ' confirming' : ''}`}
      data-node={id}
      aria-busy={pending || undefined}
      onClick={onOpen}
      onMouseDown={onMouseDown}
      onKeyDown={(e) => {
        cursorKeys(e);
        onKeyDown?.(e);
      }}
    >
      <span className="ip-bl-id">#{id}</span>
      <span className="ip-row-title ip-bl-title" title={title}>{title}</span>
      <span className="ip-bl-extras">
        {phase !== undefined && phase !== null && <span className="ip-bl-phase" title={phase}>{phase}</span>}
        {blocked && <Chip tone="blocked">BLOCKED</Chip>}
        {inside > 0 && <Chip tone="quiet">{`${inside} open inside`}</Chip>}
        {label && <Chip tone="label" glyph={LABEL_GLYPHS[label]}>{label}</Chip>}
        {age && <span className="ip-bl-age">{age}</span>}
        {!pending && !confirming && <span className="ip-bl-acts" data-act>{acts}</span>}
      </span>
      {children}
    </li>
  );
}
