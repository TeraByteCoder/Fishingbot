import test from 'node:test';
import assert from 'node:assert/strict';
import { EventEmitter } from 'node:events';
import { connectMobileMinecraft } from '../src/mobile-network.js';

function fixture() {
  const socket = Object.assign(new EventEmitter(), { setTimeout(value) { this.timeout = value; }, destroy() {} });
  const client = { ended: true, setSocket(value) { this.socket = value; this.ended = false; } };
  let destination;
  return { client, socket, get destination() { return destination; }, connect: value => { destination = value; return socket; } };
}

test('Android SRV errors fall back to system hostname lookup', async () => {
  const f = fixture();
  await connectMobileMinecraft(f.client, { host: 'example.test', port: 25565 }, { connect: f.connect, resolveSrv: async () => { throw new Error('No DNS server'); } });
  assert.deepEqual(f.destination, { host: 'example.test', port: 25565 });
  assert.equal(f.client.socket, f.socket);
  assert.equal(f.socket.timeout, 15000);
  f.socket.emit('connect');
  assert.equal(f.socket.timeout, 0);
});

test('Android SRV lookups have a hard deadline', async () => {
  const f = fixture();
  await connectMobileMinecraft(f.client, { host: 'example.test', port: 25565 }, {
    connect: f.connect, lookupTimeoutMs: 5, resolveSrv: () => new Promise(() => {})
  });
  assert.equal(f.destination.host, 'example.test');
});

test('Android respects SRV targets and explicit custom ports', async () => {
  const f = fixture();
  await connectMobileMinecraft(f.client, { host: 'example.test', port: 25565 }, {
    connect: f.connect, resolveSrv: async () => [{ name: 'target.example.test', port: 25566 }]
  });
  assert.deepEqual(f.destination, { host: 'target.example.test', port: 25566 });
  await connectMobileMinecraft(f.client, { host: 'example.test', port: 25567 }, {
    connect: f.connect, resolveSrv: () => { throw new Error('Must not resolve'); }
  });
  assert.deepEqual(f.destination, { host: 'example.test', port: 25567 });
});

test('Android does not open a socket after cancellation during DNS', async () => {
  const f = fixture();
  await connectMobileMinecraft(f.client, { host: 'example.test', port: 25565 }, {
    connect: f.connect, resolveSrv: async () => { f.client._endReason = 'Stopped'; return []; }
  });
  assert.equal(f.destination, undefined);
});

test('Android can use platform-resolved SRV records', async t => {
  const previous = process.env.FISHINGBOT_SRV_RECORDS;
  t.after(() => {
    if (previous === undefined) delete process.env.FISHINGBOT_SRV_RECORDS;
    else process.env.FISHINGBOT_SRV_RECORDS = previous;
  });
  process.env.FISHINGBOT_SRV_RECORDS = JSON.stringify({ source: 'example.test', records: [{ name: 'native.example.test', port: 25566 }] });
  const f = fixture();
  await connectMobileMinecraft(f.client, { host: 'example.test', port: 25565 }, {
    connect: f.connect, resolveSrv: () => { throw new Error('Native DNS already resolved'); }
  });
  assert.deepEqual(f.destination, { host: 'native.example.test', port: 25566 });
});
