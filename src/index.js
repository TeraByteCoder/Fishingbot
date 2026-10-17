import { mkdirSync, openSync, closeSync, unlinkSync } from 'node:fs';
import { dirname } from 'node:path';
import { loadConfig } from './config.js';
import { Store } from './store.js';
import { Controller } from './controller.js';
import { setupTelegram, commands, chunks } from './telegram.js';
import { Resources, MeteredTelegramAgent } from './resources.js';

// A second process could overwrite a damage lock. Permit one instance per state file.
function acquireLock(path) {
  mkdirSync(dirname(path), { recursive: true, mode: 0o700 });
  try {
    const fd = openSync(path, 'wx', 0o600);
    closeSync(fd);
  } catch (error) {
    if (error.code === 'EEXIST') throw new Error(`Instance lock exists: ${path}. Stop other instances; remove this file only if a previous process crashed.`);
    throw error;
  }
  return () => unlinkSync(path);
}

let controller;
let telegram;
let releaseLock;
let telegramAgent;
let ending = false;
function shutdown(reason, exitCode = 0) {
  if (ending) return;
  ending = true;
  console.log(`Stopping: ${reason}`);
  try { controller?.shutdown(); } catch { exitCode = 1; }
  try { telegram?.stop(reason); } catch { /* Polling may not have started. */ }
  telegramAgent?.destroy();
  try { releaseLock?.(); } catch { exitCode = 1; }
  process.exitCode = exitCode;
  setTimeout(() => process.exit(exitCode), 2000).unref();
}

try {
  const config = loadConfig();
  releaseLock = acquireLock(`${config.storage.stateFile}.lock`);
  const store = new Store(config.storage.stateFile);
  mkdirSync(config.storage.authDirectory, { recursive: true, mode: 0o700 });
  const [{ default: mineflayer }, { loader }, { Telegraf }] = await Promise.all([
    import('mineflayer'), import('mineflayer-auto-eat'), import('telegraf')
  ]);
  if (!mineflayer.testedVersions.includes('1.21.4')) throw new Error('Installed Mineflayer does not support 1.21.4.');
  const resources = new Resources();
  telegramAgent = new MeteredTelegramAgent(resources);
  telegram = new Telegraf(config.telegramToken, { handlerTimeout: 30000, telegram: { agent: telegramAgent } });
  controller = new Controller({ config, store, createBot: mineflayer.createBot, autoEatPlugin: loader, resources,
    notify: async message => {
      for (const chunk of chunks(message)) await telegram.telegram.sendMessage(config.ownerId, chunk);
    }
  });
  setupTelegram(telegram, controller, config.ownerId);
  // Verify Telegram before opening Minecraft, so a bad token cannot leave an unmonitored bot.
  await telegram.telegram.getMe();
  await telegram.telegram.setMyCommands(commands.map(([command, description]) => ({ command, description })));
  process.once('SIGINT', () => shutdown('SIGINT'));
  process.once('SIGTERM', () => shutdown('SIGTERM'));
  process.once('uncaughtException', () => shutdown('Unexpected runtime failure', 1));
  process.once('unhandledRejection', () => shutdown('Unexpected asynchronous failure', 1));
  void telegram.launch({ dropPendingUpdates: true }, () => controller.start())
    .catch(() => shutdown('Telegram polling stopped unexpectedly', 1));
} catch (error) {
  // Never log third-party error objects that could contain Telegram request URLs.
  const safe = ['Set ', 'Invalid ', 'This bot ', 'Config ', 'Port ', 'autoStart ', 'bannedFood ', 'Cannot read state', 'Instance lock', 'Installed Mineflayer'];
  console.error(safe.some(prefix => error.message?.startsWith(prefix)) ? error.message : 'Startup failed. Check config JSON, installed dependencies, writable storage, Telegram token and network connectivity.');
  shutdown('Startup failure', 1);
}
