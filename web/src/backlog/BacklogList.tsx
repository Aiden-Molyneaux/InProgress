import { useRef } from 'react';
import { Backlog } from './Backlog';
import { projectCode } from '../page/projectCode';
import type { ViewProps } from '../views/props';

/**
 * The full Backlog (a view of its own: the rail opens it, and so does "N ›" on the Board), a page like the Project view.
 * Its views, filter and quick-adds are in `Backlog`.
 */
export function BacklogList({ snapshot, now, onOpenNode, onStatus, codes }: ViewProps & { codes?: Map<number, string> }) {
  const { project } = snapshot;
  const heading = useRef<HTMLHeadingElement>(null);
  return (
    <div className="ip-backlogview">
      <div className="ip-page">
        <Backlog
          snapshot={snapshot}
          now={now}
          projectId={project.id}
          slug={project.slug}
          code={codes?.get(project.id) ?? projectCode(project.name)}
          titleRef={heading}
          onStatus={onStatus}
          onOpenNode={onOpenNode}
        />
      </div>
    </div>
  );
}
