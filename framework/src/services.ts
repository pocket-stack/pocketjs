// Framework-neutral per-tick service pumps. UI lifecycle hooks are component
// scoped and differ between Solid, Vue Vapor and Octane; module Promise
// delivery is realm scoped and must not depend on any of them.
//
// The set is normally empty. A module registers only while it has pending
// work, so the idle frame cost is one empty-set iteration and no native op.

type ServicePump = () => void;

const pumps = new Set<ServicePump>();

export function registerServicePump(pump: ServicePump): () => void {
  pumps.add(pump);
  return () => pumps.delete(pump);
}

export function runServicePumps(): void {
  if (pumps.size === 0) return;
  // A pump may remove itself while running; Set iteration safely advances to
  // the next entry without a snapshot allocation on this per-frame path.
  for (const pump of pumps) pump();
}
