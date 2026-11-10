import type { TickTickApi } from './_ticktickTrips.js';

const failure = () => new Error('地点标签读取失败');
const normalize = (value: string) => value.normalize('NFKC').trim().toLowerCase();

// Undefined is only for legacy in-process API adapters without tag support.
// A successful empty directory is authoritative and must remain distinct.
export async function readTickTickLocationTags(api: TickTickApi): Promise<string[] | undefined> {
  const listTags = api.listTags;
  if (listTags === undefined) return undefined;
  try {
    if (typeof listTags !== 'function') throw failure();
    const raw: unknown = await listTags.call(api);
    if (!Array.isArray(raw)) throw failure();
    const parents = new Map<string, string>();
    const roots: string[] = [];
    for (const item of raw) {
      if (!item || typeof item !== 'object' || Array.isArray(item)) throw failure();
      const tag = item as Record<string, unknown>;
      if (typeof tag.name !== 'string' || !normalize(tag.name)
        || tag.label != null && typeof tag.label !== 'string'
        || tag.parent != null && typeof tag.parent !== 'string') throw failure();
      const name = normalize(tag.name), parent = typeof tag.parent === 'string' ? normalize(tag.parent) : '';
      if (parents.has(name)) throw failure();
      parents.set(name, parent);
      if (name === '地点' || typeof tag.label === 'string' && normalize(tag.label) === '地点') roots.push(name);
    }
    if (roots.length > 1) throw failure();
    for (const parent of parents.values()) if (parent && !parents.has(parent)) throw failure();
    // Validate all chains iteratively, including unrelated branches. A partial
    // or cyclic directory cannot establish which tasks have location rules.
    const checked = new Set<string>();
    for (const name of parents.keys()) {
      const chain = new Set<string>();
      let current = name;
      while (current && !checked.has(current)) {
        if (chain.has(current)) throw failure();
        chain.add(current);
        current = parents.get(current)!;
      }
      for (const entry of chain) checked.add(entry);
    }
    if (!roots.length) return [];
    const children = new Map<string, string[]>();
    for (const [name, parent] of parents) {
      const entries = children.get(parent) ?? [];
      entries.push(name); children.set(parent, entries);
    }
    const descendants = new Set<string>();
    const queue = [...children.get(roots[0]) ?? []];
    for (let index = 0; index < queue.length; index++) {
      const name = queue[index];
      descendants.add(name);
      queue.push(...children.get(name) ?? []);
    }
    // Return canonical names only: labels do not imply aliases for cities.
    return [...parents.keys()].filter(name => descendants.has(name));
  } catch {
    // Never expose provider responses, authentication details, or tag content.
    throw failure();
  }
}
