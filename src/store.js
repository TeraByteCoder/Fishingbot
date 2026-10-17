import { mkdirSync, readFileSync, renameSync, writeFileSync } from 'node:fs';
import { dirname } from 'node:path';

const counters = ['casts', 'catches', 'fishingErrors', 'meals', 'disconnects', 'damageEvents'];
export class Store {
  constructor(path) {
    this.path = path;
    this.state = {
      version: 1, damageLock: false, lastDamage: null,
      stats: { ...Object.fromEntries(counters.map(key => [key, 0])), observedItems: {}, collectedItems: {} }
    };
    try { this.state = JSON.parse(readFileSync(path, 'utf8')); }
    catch (error) { if (error.code !== 'ENOENT') throw new Error(`Cannot read state; refusing to bypass a possible damage lock: ${error.message}`); }
    const s = this.state;
    if (s.version !== 1 || typeof s.damageLock !== 'boolean' || !s.stats ||
      counters.some(key => !Number.isSafeInteger(s.stats[key]) || s.stats[key] < 0) ||
      ['observedItems', 'collectedItems'].some(key => !s.stats[key] || typeof s.stats[key] !== 'object' ||
        Array.isArray(s.stats[key]) || Object.values(s.stats[key]).some(n => !Number.isSafeInteger(n) || n < 0))) {
      throw new Error('Invalid state file; refusing to bypass a possible damage lock.');
    }
    this.save();
  }

  save() {
    mkdirSync(dirname(this.path), { recursive: true, mode: 0o700 });
    const temp = `${this.path}.tmp`;
    writeFileSync(temp, `${JSON.stringify(this.state, null, 2)}\n`, { mode: 0o600, flush: true });
    renameSync(temp, this.path);
  }

  increment(key, amount = 1) { this.state.stats[key] += amount; }
  item(group, name, count) {
    // Item names come from the Minecraft registry, never from chat.
    if (!/^[a-z0-9_]+$/.test(name) || !Number.isSafeInteger(count) || count <= 0) return;
    const map = this.state.stats[group];
    map[name] = (Object.hasOwn(map, name) ? map[name] : 0) + count;
  }
}
