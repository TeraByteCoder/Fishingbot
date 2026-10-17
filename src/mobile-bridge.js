import { createServer } from 'node:http';
import { randomBytes, timingSafeEqual } from 'node:crypto';
import { writeFileSync } from 'node:fs';

export async function createMobileBridge({ controller, auth = () => null, error = () => null, file, token = randomBytes(32).toString('hex') }) {
  const secret = Buffer.from(`Bearer ${token}`);
  const server = createServer(async (request, response) => {
    response.setHeader('Content-Type', 'application/json; charset=utf-8');
    response.setHeader('Cache-Control', 'no-store');
    const supplied = Buffer.from(request.headers.authorization || '');
    const send = (status, value) => { response.writeHead(status); response.end(JSON.stringify(value)); };
    if (supplied.length !== secret.length || !timingSafeEqual(supplied, secret)) return send(401, { error: 'Unauthorized' });
    const bot = controller();
    if (request.method === 'GET' && request.url === '/snapshot') {
      return send(200, {
        connected: Boolean(bot?.connected), damageLock: Boolean(bot?.store.state.damageLock),
        fishing: Boolean(bot?.wanted), status: bot?.status() || 'Starting runtime…',
        stats: bot?.stats() || '', inventory: bot?.inventory() || '',
        auth: bot?.connected ? null : auth(), error: error(),
        counts: bot?.store.state.stats || null
      });
    }
    if (request.method === 'POST' && request.url === '/command') {
      if (!bot) return send(503, { error: 'Runtime is not ready.' });
      try {
        let body = '';
        for await (const part of request) {
          body += part;
          if (body.length > 4096) return send(413, { error: 'Request too large.' });
        }
        const methods = { startfish: 'startFishing', stopfish: 'stopFishing', reconnect: 'reconnect' };
        const command = JSON.parse(body).command;
        if (!Object.hasOwn(methods, command)) return send(400, { error: 'Unknown command.' });
        return send(200, { message: bot[methods[command]]() });
      } catch { return send(400, { error: 'Invalid command request.' }); }
    }
    send(404, { error: 'Not found' });
  });
  await new Promise((resolve, reject) => { server.once('error', reject); server.listen(0, '127.0.0.1', resolve); });
  const port = server.address().port;
  if (file) writeFileSync(file, JSON.stringify({ port, token }), { mode: 0o600 });
  return { server, port, token };
}
