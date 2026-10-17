import test from 'node:test';
import assert from 'node:assert/strict';
import { EventEmitter } from 'node:events';
import { mkdtempSync, readFileSync, writeFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { Store } from '../src/store.js';
import { Controller } from '../src/controller.js';
import { fishOnce, minecraftAngles } from '../src/fishing.js';
import { loadConfig } from '../src/config.js';
import { isAuthorized, setupTelegram, chunks } from '../src/telegram.js';

function fixture(t, overrides = {}) {
  const root = mkdtempSync(join(tmpdir(), 'fishingbot-'));
  t.after(() => rmSync(root, { recursive: true, force: true }));
  writeFileSync(join(root, 'config.json'), JSON.stringify({ minecraft: { host: 'localhost' }, fishing: { yaw: 180, pitch: 30 } }));
  const config = loadConfig({ MC_USERNAME: 'test@example.com', TELEGRAM_BOT_TOKEN: 'test-token', TELEGRAM_OWNER_ID: '123' }, root);
  const store = new Store(config.storage.stateFile);
  const bots = [];
  const messages = [];
  const order = [];
  const createBot = options => {
    const bot = new EventEmitter();
    bot.options = options;
    bot._client = new EventEmitter();
    bot.entity = { id: 1, position: { clone() { return this; }, distanceTo() { return 0; } } };
    bot.health = 20;
    bot.food = 20;
    bot.username = 'TestBot';
    bot.inventory = { items: () => [{ name: 'fishing_rod', slot: 36 }] };
    bot.heldItem = { name: 'fishing_rod' };
    bot.autoEat = { disableAuto() {}, setOpts() {}, eat: async () => { order.push('eat'); bot.food = 20; } };
    bot.loadPlugin = () => {};
    bot.setQuickBarSlot = slot => { bot.selectedSlot = slot; };
    bot.look = async (yaw, pitch) => { bot.angle = { yaw, pitch }; };
    bot.fish = () => new Promise((resolve, reject) => { bot.resolveFish = resolve; bot.rejectFish = reject; order.push('fish'); });
    bot.activateItem = () => { order.push('reel'); bot.rejectFish?.(new Error('Fishing cancelled')); };
    bot.end = reason => { order.push('end'); bot._client.ended = true; bot.emit('end', reason); };
    bots.push(bot);
    return bot;
  };
  const controller = new Controller({ config, store, createBot, autoEatPlugin: () => {}, notify: message => messages.push(message), logger: { log() {}, error() {} }, ...overrides });
  t.after(() => controller.shutdown());
  return { root, config, store, controller, bots, messages, order };
}

function spawn(f) {
  f.controller.connect();
  const bot = f.bots.at(-1);
  bot.emit('spawn');
  // Drive work explicitly rather than waiting for the scheduler.
  clearInterval(f.controller.session.timer);
  return bot;
}

const turn = () => new Promise(resolve => setImmediate(resolve));

test('damage closes connection before persistence and alert, locks across restart', async t => {
  const f = fixture(t);
  const bot = spawn(f);
  const originalSave = f.store.save.bind(f.store);
  f.store.save = () => { f.order.push('save'); originalSave(); };
  bot.emit('entityHurt', { id: 2 });
  assert.equal(f.store.state.damageLock, false);
  bot.emit('entityHurt', bot.entity);
  await turn();
  assert.equal(f.order[0], 'end');
  assert.equal(f.controller.connected, false);
  assert.equal(f.controller.reconnectTimer, undefined);
  assert.equal(f.store.state.stats.damageEvents, 1);
  assert.equal(new Store(f.config.storage.stateFile).state.damageLock, true);
  assert.match(f.messages.join('\n'), /DAMAGE ALERT/);
  assert.match(f.controller.startFishing(), /Damage lock active/);
  f.controller.connect();
  assert.equal(f.bots.length, 1);
  assert.match(f.controller.reconnect(), /Connecting/);
  assert.equal(f.bots.length, 2);
  assert.equal(new Store(f.config.storage.stateFile).state.damageLock, false);
});

test('health loss, raw damage packets, and death each trigger protection', async t => {
  for (const trigger of ['health', 'packet', 'death']) {
    await t.test(trigger, t => {
      const f = fixture(t);
      const bot = spawn(f);
      if (trigger === 'health') { bot.health = 19; bot.emit('health'); }
      if (trigger === 'packet') bot._client.emit('damage_event', { entityId: 1 });
      if (trigger === 'death') bot.emit('death');
      assert.equal(f.store.state.damageLock, true);
      assert.equal(bot._client.ended, true);
      assert.equal(f.store.state.stats.damageEvents, 1);
    });
  }
});

test('normal disconnect schedules reconnect, pause survives reconnect', t => {
  const f = fixture(t);
  const bot = spawn(f);
  f.controller.stopFishing();
  bot.end('network lost');
  assert.ok(f.controller.reconnectTimer);
  assert.equal(f.store.state.damageLock, false);
  f.controller.reconnect();
  assert.equal(f.bots.length, 2);
  assert.equal(f.controller.wanted, false);
  assert.equal(f.bots[1].options.auth, 'microsoft');
  assert.equal(f.bots[1].options.version, '1.21.4');
  assert.equal(f.bots[1].options.respawn, false);
});

test('paused cast is drained before eating; fishing resumes with the hotbar rod', async t => {
  const f = fixture(t);
  const bot = spawn(f);
  const work = f.controller.work(f.controller.session);
  await turn();
  assert.equal(f.order.at(-1), 'fish');
  bot.food = 10;
  bot.emit('health');
  await work;
  assert.deepEqual(f.order, ['fish', 'reel']);
  await f.controller.work(f.controller.session);
  assert.deepEqual(f.order, ['fish', 'reel', 'eat']);
  const nextCast = f.controller.work(f.controller.session);
  await turn();
  bot.resolveFish();
  await nextCast;
  assert.equal(f.store.state.stats.meals, 1);
  assert.equal(f.store.state.stats.casts, 2);
  assert.equal(f.store.state.stats.catches, 1);
  assert.equal(bot.selectedSlot, 0);
  assert.deepEqual(bot.angle, minecraftAngles(180, 30));
});

test('stopfish cancels active cast and blocks another cast', async t => {
  const f = fixture(t);
  spawn(f);
  const work = f.controller.work(f.controller.session);
  await turn();
  f.controller.stopFishing();
  await work;
  await f.controller.work(f.controller.session);
  assert.deepEqual(f.order, ['fish', 'reel']);
  assert.equal(f.store.state.stats.catches, 0);
});

test('concurrent work never overlaps fishing actions', async t => {
  const f = fixture(t);
  const bot = spawn(f);
  const work = f.controller.work(f.controller.session);
  await turn();
  await f.controller.work(f.controller.session);
  bot.resolveFish();
  await work;
  assert.equal(f.store.state.stats.casts, 1);
});

test('missing hotbar rod and unavailable food report errors without casting', async t => {
  const f = fixture(t);
  const bot = spawn(f);
  bot.inventory.items = () => [{ name: 'fishing_rod', slot: 10 }];
  await f.controller.work(f.controller.session);
  assert.equal(f.store.state.stats.casts, 0);
  bot.food = 5;
  bot.autoEat.eat = async () => { throw new Error('No food'); };
  f.controller.session.retryAt = 0;
  await f.controller.work(f.controller.session);
  assert.equal(f.store.state.stats.fishingErrors, 2);
});

test('catch observations retain items removed by hoppers and deduplicate metadata', t => {
  const f = fixture(t);
  const bot = spawn(f);
  const tracker = f.controller.session.tracker;
  tracker.begin();
  const entity = { id: 10, name: 'item', position: { distanceTo: () => 0 }, getDroppedItem: () => ({ name: 'cod', count: 1 }) };
  bot.emit('itemDrop', entity);
  bot.emit('entityGone', entity); // A hopper may remove it before the promise continuation.
  tracker.caught();
  bot.emit('entityUpdate', entity);
  assert.equal(f.store.state.stats.observedItems.cod, 1);
  bot.emit('playerCollect', { id: 99 }, entity);
  assert.equal(f.store.state.stats.collectedItems.cod, undefined);
  bot.emit('playerCollect', bot.entity, entity);
  bot.emit('playerCollect', bot.entity, entity);
  assert.equal(f.store.state.stats.collectedItems.cod, 1);
});

test('cast timeout reels in and reports failure', async t => {
  const f = fixture(t);
  const bot = spawn(f);
  await assert.rejects(fishOnce(bot, new AbortController().signal, 5), /cast timed out/);
  assert.deepEqual(f.order, ['fish', 'reel']);
});

test('unacknowledged cancellation disconnects rather than starting another hand action', async t => {
  const f = fixture(t);
  const bot = spawn(f);
  bot.activateItem = () => f.order.push('reel');
  const abort = new AbortController();
  const cast = fishOnce(bot, abort.signal, 10000);
  abort.abort();
  await assert.rejects(cast, /cancellation timed out/);
  assert.equal(bot._client.ended, true);
});

test('corrupt or malformed state fails closed', t => {
  const f = fixture(t);
  writeFileSync(f.config.storage.stateFile, '{invalid');
  assert.throws(() => new Store(f.config.storage.stateFile), /possible damage lock/);
  writeFileSync(f.config.storage.stateFile, '{"version":1,"damageLock":false,"stats":{}}');
  assert.throws(() => new Store(f.config.storage.stateFile), /possible damage lock/);
});

test('storage failure disconnects and prevents reconnect', t => {
  const f = fixture(t);
  const bot = spawn(f);
  f.store.save = () => { throw new Error('Disk full'); };
  f.controller.persist();
  assert.equal(bot._client.ended, true);
  assert.equal(f.controller.stopped, true);
  assert.match(f.controller.reconnect(), /storage failure/);
});

test('configuration validates credentials, ranges and version', t => {
  const f = fixture(t);
  const env = { MC_USERNAME: 'a', TELEGRAM_BOT_TOKEN: 'x', TELEGRAM_OWNER_ID: '123' };
  assert.throws(() => loadConfig({}, f.root), /MC_USERNAME/);
  for (const invalid of [{ minecraft: { version: '1.20' } }, { fishing: { pitch: 100 } }, { reconnect: { initialDelayMs: 0 } }]) {
    writeFileSync(join(f.root, 'config.json'), JSON.stringify({
      ...invalid,
      minecraft: { host: 'localhost', ...invalid.minecraft },
      fishing: { yaw: 180, pitch: 30, ...invalid.fishing }
    }));
    assert.throws(() => loadConfig(env, f.root));
  }
  assert.equal(JSON.parse(readFileSync(f.config.storage.stateFile)).damageLock, false);
});

test('Telegram allows only the owner in their private chat', () => {
  const owner = { chat: { id: 123, type: 'private' }, from: { id: 123 } };
  assert.equal(isAuthorized(owner, '123'), true);
  assert.equal(isAuthorized({ ...owner, from: { id: 456 } }, '123'), false);
  assert.equal(isAuthorized({ ...owner, chat: { id: -123, type: 'group' } }, '123'), false);
  assert.equal(isAuthorized({}, '123'), false);
  let middleware;
  let called = false;
  setupTelegram({ use(fn) { middleware = fn; }, command() {}, catch() {} }, {}, '123');
  middleware({ ...owner, from: { id: 456 } }, () => { called = true; });
  assert.equal(called, false);
  middleware(owner, () => { called = true; });
  assert.equal(called, true);
  const text = 'item\n'.repeat(2000);
  assert.equal(chunks(text).join(''), text);
  assert.ok(chunks(text).every(chunk => chunk.length <= 3500));
});

test('angles preserve Minecraft F3 yaw and pitch conventions', () => {
  assert.equal(minecraftAngles(180, 30).yaw, 0);
  assert.ok(Math.abs(minecraftAngles(180, 30).pitch + 30 * Math.PI / 180) < 1e-12);
});

test('server address and both fishing angles must be explicitly configured', t => {
  const f = fixture(t);
  const env = { MC_USERNAME: 'a', TELEGRAM_BOT_TOKEN: 'x', TELEGRAM_OWNER_ID: '123' };
  const path = join(f.root, 'config.json');
  for (const [config, expected] of [
    [{}, /minecraft.host/],
    [{ minecraft: { host: 'localhost' } }, /fishing.yaw/],
    [{ minecraft: { host: 'localhost' }, fishing: { yaw: 0 } }, /fishing.pitch/]
  ]) {
    writeFileSync(path, JSON.stringify(config));
    assert.throws(() => loadConfig(env, f.root), expected);
  }
  writeFileSync(path, JSON.stringify({ minecraft: { host: 'localhost' }, fishing: { yaw: 0, pitch: 0 } }));
  const config = loadConfig(env, f.root);
  assert.equal(config.fishing.yaw, 0);
  assert.equal(config.fishing.pitch, 0);
  rmSync(path);
  assert.throws(() => loadConfig(env, f.root), /minecraft.host/);
});

test('stats includes process resources alongside persistent fishing statistics', t => {
  const { controller } = fixture(t);
  const report = controller.stats();
  assert.match(report, /RAM \(RSS\):/);
  assert.match(report, /CPU \(5-second sample/);
  assert.match(report, /Tracked network \(Minecraft \+ Telegram\)/);
  assert.match(report, /Downloaded:/);
  assert.match(report, /Uploaded:/);
  assert.match(report, /Lifetime statistics\nCasts: 0/);
});
