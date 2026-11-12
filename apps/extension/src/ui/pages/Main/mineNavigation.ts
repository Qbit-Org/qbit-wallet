import { openEcosystemEntry } from './ecosystemNavigation';

// The Mine tab opens the same catalog entry that the App Center lists, so the
// URL (with its UTM source) is defined once in the ecosystem catalog.
export function openQbitMine(): Promise<unknown> {
  return openEcosystemEntry('qbit-mine');
}
