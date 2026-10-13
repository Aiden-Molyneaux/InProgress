import { buildIndex, dfsOrder } from '../../../src/core/tree';
import type { ViewProps } from '../views/props';

/**
 * The Project view, as a skeleton: the project's name and its steps in tree order, one button each. The state note,
 * the outline and the resources come in a later task.
 */
export function ProjectView({ snapshot, onOpenNode }: ViewProps) {
  const index = buildIndex(snapshot.nodes);
  const order = [...dfsOrder(index).entries()].sort((a, b) => a[1] - b[1]);
  return (
    <div className="ip-project">
      <h2 className="ip-view-name">{snapshot.project.name}</h2>
      <section aria-label="Steps">
        <h3>Steps</h3>
        {order.flatMap(([id]) => {
          const node = index.byId.get(id);
          if (!node || node.id === index.root?.id) return [];
          return [
            <button key={node.id} className="ip-step-row" onClick={() => onOpenNode(node.id)}>
              {node.title}
            </button>,
          ];
        })}
      </section>
    </div>
  );
}
