export class CatchTracker {
  constructor(bot, store, options) {
    this.bot = bot;
    this.store = store;
    this.options = options;
    this.seen = new Set();
    this.collected = new Set();
    this.pending = new Map();
    this.until = 0;
    this.anchor = null;
    // Item metadata may arrive immediately before the fish promise resolves.
    bot.on('itemDrop', entity => this.observe(entity));
    bot.on('entityUpdate', entity => this.observe(entity));
    bot.on('playerCollect', (collector, entity) => {
      if (collector?.id !== bot.entity?.id || this.collected.has(entity.id)) return;
      const item = entity.getDroppedItem?.();
      if (!item) return;
      this.collected.add(entity.id);
      if (this.collected.size > 4096) this.collected.delete(this.collected.values().next().value);
      store.item('collectedItems', item.name, item.count);
    });
  }

  begin() {
    this.pending.clear();
    this.seen.clear();
    this.until = 0;
    this.active = true;
    this.anchor = this.bot.entity.position.clone();
  }

  observe(entity) {
    if (!this.active || !this.anchor || entity.name !== 'item' || this.seen.has(entity.id)) return;
    if (entity.position.distanceTo(this.anchor) > this.options.catchRadius) return;
    const item = entity.getDroppedItem?.();
    if (!item) return;
    const entry = { name: item.name, count: item.count, at: Date.now() };
    this.pending.set(entity.id, entry);
    if (Date.now() <= this.until) this.record(entity.id, entry);
  }

  record(id, item) {
    if (this.seen.has(id)) return;
    this.seen.add(id);
    this.store.item('observedItems', item.name, item.count);
  }

  caught() {
    this.until = Date.now() + this.options.catchWindowMs;
    for (const [id, item] of this.pending) {
      if (Date.now() - item.at <= 1000) this.record(id, item);
    }
  }

  stop() { this.active = false; this.pending.clear(); }
}
