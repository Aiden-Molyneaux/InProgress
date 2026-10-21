import type { ResourceMeta } from '../../../src/core/types';
import { MenuButton } from '../parts/MenuButton';
import { resourceSummary } from '../panels/format';

/** A section's `▤ n`: a menu button listing its resources, each opening the resource viewer. */
export function DocsMenu({ docs, label, onOpenResource }: { docs: ResourceMeta[]; label: string; onOpenResource: (id: number) => void }) {
  return (
    <MenuButton
      variant="bare"
      className="ip-docs ip-docs-btn"
      label={`${docs.length} resource${docs.length > 1 ? 's' : ''} in ${label}`}
      menuLabel={`Resources in ${label}`}
      items={docs.map((r) => ({
        key: r.id,
        label: (
          <>
            {r.title} <span className="ip-docs-sum">{resourceSummary(r)}</span>
          </>
        ),
        onSelect: () => onOpenResource(r.id),
      }))}
    >
      {`▤ ${docs.length}`}
    </MenuButton>
  );
}
