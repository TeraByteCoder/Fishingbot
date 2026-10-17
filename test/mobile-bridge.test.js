import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createMobileBridge } from '../src/mobile-bridge.js';
import { loadConfig } from '../src/config.js';

test('mobile bridge protects snapshots and commands with a per-process bearer token', async t => {
  const root = mkdtempSync(join(tmpdir(), 'fishingbot-bridge-'));
  t.after(() => rmSync(root, { recursive: true, force: true }));
  let starts = 0;
  const controller = {
    connected: false, wanted: false,
    store: { state: { damageLock: true, stats: { casts: 10 } } },
    status: () => 'Damage lock active', stats: () => 'RAM: test', inventory: () => 'Offline',
    startFishing: () => { starts++; return 'Damage lock active'; }
  };
  const file = join(root, 'bridge.json');
  const bridge = await createMobileBridge({ controller: () => controller, file,
    auth: () => ({ url: 'https://www.microsoft.com/link', code: 'TEST' }) });
  t.after(() => { bridge.server.closeAllConnections(); bridge.server.close(); });
  const url = `http://127.0.0.1:${bridge.port}`;
  assert.equal(bridge.server.address().address, '127.0.0.1');
  const headers = { Authorization: `Bearer ${bridge.token}` };
  assert.equal((await fetch(`${url}/snapshot`)).status, 401);
  assert.equal((await fetch(`${url}/snapshot`, { headers: { Authorization: 'Bearer incorrect' } })).status, 401);
  const snapshot = await (await fetch(`${url}/snapshot`, { headers })).json();
  assert.equal(snapshot.damageLock, true);
  assert.equal(snapshot.counts.casts, 10);
  assert.equal(snapshot.auth.code, 'TEST');
  assert.equal(JSON.parse(readFileSync(file)).token, bridge.token);
  const command = await fetch(`${url}/command`, { method: 'POST', headers, body: JSON.stringify({ command: 'startfish' }) });
  assert.equal((await command.json()).message, 'Damage lock active');
  assert.equal(starts, 1);
  assert.equal((await fetch(`${url}/command`, { method: 'POST', headers, body: JSON.stringify({ command: 'shutdown' }) })).status, 400);
  assert.equal((await fetch(`${url}/command`, { method: 'POST', headers, body: 'invalid-json' })).status, 400);
  assert.equal((await fetch(`${url}/command`, { method: 'POST', body: JSON.stringify({ command: 'startfish' }) })).status, 401);
  assert.equal(starts, 1);
  controller.connected = true;
  const online = await (await fetch(`${url}/snapshot`, { headers })).json();
  assert.equal(online.auth, null);
});

test('mobile settings may omit Telegram but validate partial credentials', t => {
  const root = mkdtempSync(join(tmpdir(), 'fishingbot-config-'));
  t.after(() => rmSync(root, { recursive: true, force: true }));
  writeFileSync(join(root, 'config.json'), JSON.stringify({ minecraft: { host: 'localhost' }, fishing: { yaw: 0, pitch: 0 } }));
  const env = { MC_USERNAME: 'test@example.com' };
  assert.equal(loadConfig(env, root, { telegramOptional: true }).username, env.MC_USERNAME);
  assert.throws(() => loadConfig(env, root), /TELEGRAM_BOT_TOKEN/);
  assert.throws(() => loadConfig({ ...env, TELEGRAM_OWNER_ID: '123' }, root, { telegramOptional: true }), /TELEGRAM_BOT_TOKEN/);
  assert.throws(() => loadConfig({ ...env, TELEGRAM_BOT_TOKEN: 'test' }, root, { telegramOptional: true }), /TELEGRAM_OWNER_ID/);
});
