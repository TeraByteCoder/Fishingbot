import { Resolver } from 'node:dns/promises';
import { connect, isIP } from 'node:net';

// Standalone Android Node processes do not inherit Android's DNS servers for
// c-ares. Use the active network's DNS for SRV, with a bounded direct fallback.
export async function connectMobileMinecraft(client, options, dependencies = {}) {
  let host = options.host;
  let port = options.port || 25565;
  try {
    const native = JSON.parse(process.env.FISHINGBOT_SRV_RECORDS || 'null');
    if (port === 25565 && native?.source === host && native.records?.length) {
      const target = native.records[0];
      if (typeof target.name === 'string' && target.name && Number.isInteger(target.port) && target.port > 0 && target.port <= 65535) {
        host = target.name; port = target.port;
      }
    }
  } catch { /* Continue with the bounded Node resolver if native DNS is unavailable. */ }
  const resolver = new Resolver({ timeout: 1500, tries: 1 });
  try {
    const servers = (process.env.FISHINGBOT_DNS_SERVERS || '').split(',').filter(Boolean);
    if (servers.length) resolver.setServers(servers);
  } catch { /* Fall back to Android's system hostname lookup below. */ }
  if (host === options.host && port === 25565 && !isIP(host) && host !== 'localhost') {
    let timer;
    try {
      const resolveSrv = dependencies.resolveSrv || (name => resolver.resolveSrv(name));
      const records = await Promise.race([
        resolveSrv(`_minecraft._tcp.${host}`),
        new Promise((resolve, reject) => {
          timer = setTimeout(() => { resolver.cancel(); reject(new Error('SRV lookup timed out')); }, dependencies.lookupTimeoutMs || 2000);
        })
      ]);
      if (records.length) { host = records[0].name; port = records[0].port; }
    } catch { /* Missing, refused, or unavailable SRV must not block connecting. */ }
    finally { clearTimeout(timer); }
  }
  // minecraft-protocol initializes ended=true before its first setSocket().
  // A requested end is recorded separately, so initial clients must still connect.
  if (client._endReason !== undefined || client.serializer?.writableEnded) return;
  const socket = (dependencies.connect || connect)({ host, port });
  client.setSocket(socket);
  socket.setTimeout(15000, () => socket.destroy(new Error('Minecraft TCP connection timed out.')));
  socket.once('connect', () => socket.setTimeout(0));
}
