import test from 'node:test';
import assert from 'node:assert/strict';
import { EventEmitter, once } from 'node:events';
import { createServer, createConnection } from 'node:net';
import { Resources, formatBytes } from '../src/resources.js';

function fixture() {
  const state = { time: 0, cpu: { user: 0, system: 0 } };
  const resources = new Resources({
    cpuUsage: () => ({ ...state.cpu }), now: () => state.time,
    memoryUsage: () => ({ rss: 64 * 1024 ** 2, heapUsed: 20 * 1024 ** 2, heapTotal: 32 * 1024 ** 2 })
  });
  return { state, resources };
}

function socket(received, sent) {
  return Object.assign(new EventEmitter(), { bytesRead: received, bytesWritten: sent });
}

test('CPU samples account for elapsed time and may exceed one core', () => {
  const { resources, state } = fixture();
  assert.match(resources.report(), /CPU .*collecting samples/);
  state.time = 5000;
  state.cpu = { user: 1500000, system: 1000000 };
  resources.sample();
  assert.equal(resources.cpuPercent, 50);
  state.time = 10000;
  state.cpu = { user: 9000000, system: 1000000 };
  resources.sample();
  assert.equal(resources.cpuPercent, 150);
  resources.sample(); // A zero-duration sample does not produce NaN or infinity.
  assert.equal(resources.cpuPercent, 150);
  assert.match(resources.report(), /RAM \(RSS\): 64.00 MiB/);
  assert.match(resources.report(), /JS heap: 20.00 MiB \/ 32.00 MiB/);
  assert.match(resources.report(), /CPU time: 10.00 seconds/);
});

test('socket traffic retains closed connections and deduplicates reused sockets', () => {
  const { resources, state } = fixture();
  const first = socket(1024, 512);
  resources.trackSocket(first);
  resources.trackSocket(first);
  assert.deepEqual(resources.network(), { received: 1024, sent: 512 });
  state.time = 5000;
  resources.sample();
  assert.deepEqual(resources.rates, { received: 204.8, sent: 102.4 });
  first.bytesRead += 1024;
  first.emit('close');
  first.emit('close');
  resources.trackSocket(first);
  const second = socket(2048, 100);
  resources.trackSocket(second);
  assert.deepEqual(resources.network(), { received: 4096, sent: 612 });
  assert.equal(resources.sockets.size, 1);
  state.time = 10000;
  resources.sample();
  assert.equal(resources.rates.received, 614.4);
  second.emit('close');
  assert.equal(resources.sockets.size, 0);
  assert.equal(resources.network().received, 4096);
  assert.match(resources.report(), /excludes Microsoft login/);
});

test('Minecraft sockets can be installed after client creation', () => {
  const { resources } = fixture();
  const client = new EventEmitter();
  resources.trackMinecraft(client);
  client.socket = socket(100, 50);
  client.emit('connect');
  assert.deepEqual(resources.network(), { received: 100, sent: 50 });
  const connectedClient = Object.assign(new EventEmitter(), { socket: client.socket });
  resources.trackMinecraft(connectedClient);
  connectedClient.emit('connect');
  assert.deepEqual(resources.network(), { received: 100, sent: 50 });
});

test('already destroyed sockets are counted once without retaining them', () => {
  const { resources } = fixture();
  const closed = Object.assign(socket(123, 45), { destroyed: true });
  resources.trackSocket(closed);
  resources.trackSocket(closed);
  resources.trackSocket(undefined);
  assert.deepEqual(resources.network(), { received: 123, sent: 45 });
  assert.equal(resources.sockets.size, 0);
});

test('sampler starts once and stops cleanly', () => {
  const { resources } = fixture();
  resources.start();
  const timer = resources.timer;
  resources.start();
  assert.equal(resources.timer, timer);
  resources.stop();
  assert.equal(resources.timer, null);
});

test('byte formatting handles units, zero and missing counters', () => {
  assert.equal(formatBytes(0), '0 B');
  assert.equal(formatBytes(1024), '1.00 KiB');
  assert.equal(formatBytes(1024 ** 3), '1.00 GiB');
  assert.equal(formatBytes(undefined), '0 B');
});

test('real TCP socket accounting matches traffic across socket close', async t => {
  const resources = new Resources();
  const server = createServer(peer => peer.once('data', () => peer.end('response')));
  t.after(() => server.close());
  server.listen(0, '127.0.0.1');
  await once(server, 'listening');
  const client = createConnection(server.address().port, '127.0.0.1');
  t.after(() => client.destroy());
  resources.trackSocket(client);
  client.resume();
  const closed = once(client, 'close');
  await once(client, 'connect');
  client.write('request');
  await closed;
  assert.deepEqual(resources.network(), { received: Buffer.byteLength('response'), sent: Buffer.byteLength('request') });
  assert.equal(resources.sockets.size, 0);
});
