import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';

export function loadConfig(env = process.env, root = process.cwd()) {
  const defaults = JSON.parse(readFileSync(new URL('../config.example.json', import.meta.url), 'utf8'));
  let custom = {};
  try {
    custom = JSON.parse(readFileSync(resolve(root, env.CONFIG_PATH || 'config.json'), 'utf8'));
  } catch (error) {
    if (error.code !== 'ENOENT' || env.CONFIG_PATH) throw error;
  }
  if (!custom || typeof custom !== 'object' || Array.isArray(custom)) throw new Error('Config must be a JSON object.');
  const config = {};
  for (const key of Object.keys(defaults)) {
    if (custom[key] !== undefined && (!custom[key] || typeof custom[key] !== 'object' || Array.isArray(custom[key]))) {
      throw new Error(`Invalid config section: ${key}`);
    }
    config[key] = { ...defaults[key], ...custom[key] };
  }
  if (config.minecraft.version !== '1.21.4') throw new Error('This bot requires Minecraft Java 1.21.4.');
  if (typeof config.minecraft.host !== 'string' || !config.minecraft.host.trim()) throw new Error('Invalid Minecraft host: set minecraft.host in config.json.');
  const number = (value, min, max, name) => {
    if (!Number.isFinite(value) || value < min || value > max) throw new Error(`Invalid ${name}.`);
  };
  number(config.minecraft.port, 1, 65535, 'port');
  if (!Number.isInteger(config.minecraft.port)) throw new Error('Port must be an integer.');
  number(config.fishing.yaw, -360, 360, 'fishing.yaw: set your own angle in config.json');
  number(config.fishing.pitch, -90, 90, 'fishing.pitch: set your own angle in config.json');
  if (typeof config.fishing.autoStart !== 'boolean') throw new Error('autoStart must be a boolean.');
  for (const [name, value] of Object.entries(config.fishing)) {
    if (name.endsWith('Ms')) number(value, 100, 3600000, name);
  }
  number(config.fishing.catchRadius, 0.1, 32, 'catchRadius');
  number(config.autoEat.minHunger, 0, 19, 'minHunger');
  if (!Array.isArray(config.autoEat.bannedFood) || config.autoEat.bannedFood.some(x => typeof x !== 'string')) {
    throw new Error('bannedFood must be an array of item names.');
  }
  number(config.reconnect.initialDelayMs, 1000, 3600000, 'initialDelayMs');
  number(config.reconnect.maxDelayMs, config.reconnect.initialDelayMs, 3600000, 'maxDelayMs');
  for (const key of ['stateFile', 'authDirectory']) {
    if (typeof config.storage[key] !== 'string' || !config.storage[key]) throw new Error(`Invalid ${key}.`);
    config.storage[key] = resolve(root, config.storage[key]);
  }
  if (!env.MC_USERNAME?.trim()) throw new Error('Set MC_USERNAME in .env.');
  if (!env.TELEGRAM_BOT_TOKEN || env.TELEGRAM_BOT_TOKEN.startsWith('replace-')) throw new Error('Set TELEGRAM_BOT_TOKEN in .env.');
  if (!/^[1-9]\d*$/.test(env.TELEGRAM_OWNER_ID || '')) throw new Error('Set TELEGRAM_OWNER_ID to your private Telegram user ID.');
  return { ...config, username: env.MC_USERNAME.trim(), telegramToken: env.TELEGRAM_BOT_TOKEN, ownerId: env.TELEGRAM_OWNER_ID };
}
