import { forwardRef, type CSSProperties, type HTMLAttributes, type ReactNode } from 'react';
import { cx } from './classes';
import { Frame } from './Frame';

export interface TileProps extends Omit<HTMLAttributes<HTMLElement>, 'title' | 'id'> {
  /** The stored hue index 0 to 6: the tile's top rule. Ignored by done and parked tiles. */
  hue?: number | null;
  tone?: 'default' | 'ask' | 'done' | 'parked';
  id?: ReactNode;
  chips?: ReactNode;
  title: string;
  /** A class for the title button, for a surface that finds it by name. */
  titleClassName?: string;
  /** -1 takes the title button out of the Tab order: a tile that holds a confirm. */
  titleTabIndex?: number;
  onOpen?: () => void;
  body?: ReactNode;
  foot?: ReactNode;
  actions?: ReactNode;
  selected?: boolean;
  dragging?: boolean;
  /** Draws the drop line above the tile. */
  dropBefore?: boolean;
  pending?: boolean;
  /** The tile rises in. The number is its place in the stagger (12 steps at most). */
  rise?: number;
}

/** A step's tile: hue rule, id and chips, a title that opens it, a body, and a foot with actions. */
export const Tile = forwardRef<HTMLElement, TileProps>(function Tile(
  { hue, tone = 'default', id, chips, title, titleClassName, titleTabIndex, onOpen, body, foot, actions, selected, dragging, dropBefore, pending, rise, className, style, children, ...rest },
  ref,
) {
  const vars = { '--p-hue': hue == null ? undefined : `var(--hue-${hue})`, '--p-i': rise } as CSSProperties;
  return (
    <article
      ref={ref}
      className={cx('p-tile', className)}
      data-tone={tone}
      data-hue={hue ?? undefined}
      data-selected={selected || undefined}
      data-dragging={dragging || undefined}
      data-drop={dropBefore || undefined}
      data-pending={pending || undefined}
      data-entering={rise !== undefined || undefined}
      style={{ ...vars, ...style }}
      {...rest}
    >
      <Frame />
      {(id !== undefined || chips !== undefined) && (
        <div className="p-tile-top">
          <span className="p-tile-id">{id}</span>
          <span className="p-tile-chips">{chips}</span>
        </div>
      )}
      <h3 className="p-tile-title">
        <button type="button" className={titleClassName} tabIndex={titleTabIndex} onClick={onOpen}>
          {title}
        </button>
      </h3>
      {body && <div className="p-tile-body">{body}</div>}
      {children}
      {(foot || actions) && (
        <div className="p-tile-foot">
          {foot}
          {actions && <span className="p-tile-actions">{actions}</span>}
        </div>
      )}
    </article>
  );
});
