import { mkdirSync, openSync, closeSync, unlinkSync, writeFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { loadConfig } from './config.js';
import { Store } from './store.js';
import { Controller } from './controller.js';
import { Resources, MeteredTelegramAgent } from './resources.js';
import { setupTelegram, commands, chunks } from './telegram.js';
import { createMobileBridge } from './mobile-bridge.js';
import { connectMobileMinecraft } from './mobile-network.js';

let controller, telegram, agent, lockPath, bridge, auth = null, failure = null;
let ending = false;
writeFileSync(resolve('runtime.pid'), String(process.pid), { mode: 0o600 });
function stop(reason, code = 0) {
  if (ending) return;
  ending = true;
  try { controller?.shutdown(); } catch { code = 1; }
  try { telegram?.stop(reason); } catch { /* Not launched yet. */ }
  agent?.destroy();
  bridge?.server.close();
  if (lockPath) { try { unlinkSync(lockPath); } catch { /* Retain state on disk. */ } }
  try { unlinkSync(resolve('mobile-bridge.json')); } catch { /* Startup may have failed. */ }
  process.exitCode = code;
  setTimeout(() => process.exit(code), 1500).unref();
}
process.once('SIGINT', () => stop('App stopped'));
process.once('SIGTERM', () => stop('App stopped'));
process.once('uncaughtException', () => stop('Runtime error', 1));
process.once('unhandledRejection', () => stop('Runtime error', 1));

try {
  bridge = await createMobileBridge({ controller: () => controller, auth: () => auth, error: () => failure, file: resolve('mobile-bridge.json') });
  const config = loadConfig(process.env, process.cwd(), { telegramOptional: true });
  mkdirSync(dirname(config.storage.stateFile), { recursive: true, mode: 0o700 });
  // The Android service starts exactly one child. A stale lock from a killed child
  // may be removed by that service only after verifying the child has exited.
  const candidate = `${config.storage.stateFile}.lock`;
  const fd = openSync(candidate, 'wx', 0o600);
  closeSync(fd);
  lockPath = candidate;
  const store = new Store(config.storage.stateFile);
  mkdirSync(config.storage.authDirectory, { recursive: true, mode: 0o700 });
  const [{ default: mineflayer }, { loader }] = await Promise.all([import('mineflayer'), import('mineflayer-auto-eat')]);
  const resources = new Resources();
  if (config.telegramToken) {
    const { Telegraf } = await import('telegraf');
    agent = new MeteredTelegramAgent(resources);
    telegram = new Telegraf(config.telegramToken, { handlerTimeout: 30000, telegram: { agent } });
  }
  controller = new Controller({ config, store, resources, createBot: options => {
    const bot = mineflayer.createBot({ ...options, connect: client => {
      void connectMobileMinecraft(client, options).catch(() => client.emit('error', new Error('Minecraft connection failed.')));
    } });
    bot._client.on('session', () => console.log('Microsoft session ready.'));
    bot._client.on('connect', () => console.log('Minecraft TCP connected.'));
    return bot;
  }, autoEatPlugin: loader,
    onAuthCode: value => { auth = value; },
    notify: async message => {
      if (telegram) for (const chunk of chunks(message)) await telegram.telegram.sendMessage(config.ownerId, chunk);
    }
  });
  if (telegram) {
    setupTelegram(telegram, controller, config.ownerId);
    telegram.botInfo = await telegram.telegram.getMe();
    await telegram.telegram.setMyCommands(commands.map(([command, description]) => ({ command, description })));
    void telegram.launch({ dropPendingUpdates: true }, () => controller.start())
      .catch(() => { failure = 'Telegram polling failed. Check credentials and connectivity, then restart the bot.'; controller.shutdown(); });
  } else controller.start();
} catch {
  failure = 'Could not start the bot. Check settings, network access and the local runtime log.';
  console.error(failure);
  // Keep the authenticated bridge alive so the app can display the failure.
  if (!bridge) stop('Bridge could not start', 1);
}
