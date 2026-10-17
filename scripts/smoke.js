import mineflayer from 'mineflayer';
import { loader } from 'mineflayer-auto-eat';
import { Telegraf } from 'telegraf';

if (!mineflayer.testedVersions.includes('1.21.4')) throw new Error('Minecraft 1.21.4 is not supported.');
if (typeof loader !== 'function' || typeof Telegraf !== 'function') throw new Error('Dependency API mismatch.');
console.log('Runtime dependencies loaded; Minecraft Java 1.21.4 is supported. No network connection was opened.');
