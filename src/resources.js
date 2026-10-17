import { Agent } from 'node:https';

const bytes = value => Number.isFinite(value) && value >= 0 ? value : 0;
export function formatBytes(value) {
  const units = ['B', 'KiB', 'MiB', 'GiB', 'TiB'];
  let size = bytes(value);
  let unit = 0;
  while (size >= 1024 && unit < units.length - 1) { size /= 1024; unit++; }
  return `${size.toFixed(unit ? 2 : 0)} ${units[unit]}`;
}

export class Resources {
  constructor({ cpuUsage = () => process.cpuUsage(), memoryUsage = () => process.memoryUsage(), now = () => performance.now() } = {}) {
    Object.assign(this, { cpuUsage, memoryUsage, now });
    this.sockets = new Set();
    this.seen = new WeakSet();
    this.closed = { received: 0, sent: 0 };
    this.previous = { cpu: cpuUsage(), time: now(), network: this.network() };
    this.cpuPercent = null;
    this.rates = null;
  }

  trackSocket(socket) {
    if (!socket || this.seen.has(socket)) return;
    this.seen.add(socket);
    if (socket.destroyed) {
      this.closed.received += bytes(socket.bytesRead);
      this.closed.sent += bytes(socket.bytesWritten);
      return;
    }
    this.sockets.add(socket);
    socket.once('close', () => {
      this.closed.received += bytes(socket.bytesRead);
      this.closed.sent += bytes(socket.bytesWritten);
      this.sockets.delete(socket);
    });
  }

  trackMinecraft(client) {
    const attach = () => this.trackSocket(client.socket);
    attach();
    client.once('connect', attach);
  }

  network() {
    const total = { ...this.closed };
    for (const socket of this.sockets) {
      total.received += bytes(socket.bytesRead);
      total.sent += bytes(socket.bytesWritten);
    }
    return total;
  }

  sample() {
    const current = { cpu: this.cpuUsage(), time: this.now(), network: this.network() };
    const elapsedMs = current.time - this.previous.time;
    if (elapsedMs <= 0) return;
    const cpuMicros = current.cpu.user + current.cpu.system - this.previous.cpu.user - this.previous.cpu.system;
    this.cpuPercent = Math.max(0, cpuMicros / (elapsedMs * 1000) * 100);
    this.rates = {
      received: Math.max(0, current.network.received - this.previous.network.received) * 1000 / elapsedMs,
      sent: Math.max(0, current.network.sent - this.previous.network.sent) * 1000 / elapsedMs
    };
    this.previous = current;
  }

  start() {
    if (!this.timer) {
      this.timer = setInterval(() => this.sample(), 5000);
      this.timer.unref();
    }
  }

  stop() { clearInterval(this.timer); this.timer = null; }

  report() {
    const memory = this.memoryUsage();
    const total = this.network();
    const cpu = this.cpuUsage();
    return [
      'Process resources (since startup)',
      `RAM (RSS): ${formatBytes(memory.rss)}`,
      `JS heap: ${formatBytes(memory.heapUsed)} / ${formatBytes(memory.heapTotal)}`,
      `CPU (5-second sample; 100% = one core): ${this.cpuPercent === null ? 'collecting samples' : `${this.cpuPercent.toFixed(1)}%`}`,
      `CPU time: ${((cpu.user + cpu.system) / 1e6).toFixed(2)} seconds`,
      '',
      'Tracked network (Minecraft + Telegram)',
      `Downloaded: ${formatBytes(total.received)}`,
      `Uploaded: ${formatBytes(total.sent)}`,
      `Total traffic: ${formatBytes(total.received + total.sent)}`,
      `Download rate (5-second sample): ${this.rates ? `${formatBytes(this.rates.received)}/s` : 'collecting samples'}`,
      `Upload rate (5-second sample): ${this.rates ? `${formatBytes(this.rates.sent)}/s` : 'collecting samples'}`,
      'Socket bytes only; excludes Microsoft login, DNS and transport overhead. Resets on process restart.'
    ].join('\n');
  }
}

export class MeteredTelegramAgent extends Agent {
  constructor(resources) {
    super({ keepAlive: true });
    this.resources = resources;
  }

  createConnection(options, callback) {
    const socket = super.createConnection(options, callback);
    this.resources.trackSocket(socket);
    return socket;
  }
}
