export const commands = [
  ['status', 'Connection, health, hunger and uptime'],
  ['stats', 'RAM, CPU, network and lifetime fishing statistics'],
  ['inventory', 'Show inventory'],
  ['startfish', 'Enable fishing'],
  ['stopfish', 'Pause fishing'],
  ['reconnect', 'Clear damage lock and reconnect']
];

export function isAuthorized(ctx, ownerId) {
  return ctx.chat?.type === 'private' && String(ctx.from?.id) === ownerId && String(ctx.chat.id) === ownerId;
}

export function chunks(text, limit = 3500) {
  const result = [];
  for (let i = 0; i < text.length; i += limit) result.push(text.slice(i, i + limit));
  return result;
}

export function setupTelegram(telegram, controller, ownerId) {
  telegram.use((ctx, next) => isAuthorized(ctx, ownerId) ? next() : undefined);
  const methods = { status: 'status', stats: 'stats', inventory: 'inventory', startfish: 'startFishing', stopfish: 'stopFishing', reconnect: 'reconnect' };
  for (const [command, method] of Object.entries(methods)) {
    telegram.command(command, async ctx => {
      for (const chunk of chunks(controller[method]())) await ctx.reply(chunk);
    });
  }
  telegram.command(['start', 'help'], ctx => ctx.reply(commands.map(([name, description]) => `/${name} — ${description}`).join('\n')));
  telegram.catch(() => controller.alert('Telegram command failed. Check network connectivity and try again.', 'telegram-command'));
}
