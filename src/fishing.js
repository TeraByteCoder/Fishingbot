// Mineflayer has no public cancelFish method. Reel in and drain the outstanding
// fish() promise before another hand action. If the server does not acknowledge
// cancellation, close the connection instead of leaving a live fishing task.
export async function fishOnce(bot, signal, timeoutMs) {
  if (signal.aborted) return false;
  let abortHandler;
  let timeout;
  const operation = bot.fish().then(() => ({ caught: true }), error => ({ error }));
  const interrupted = new Promise(resolve => {
    abortHandler = () => resolve({ interrupted: true });
    signal.addEventListener('abort', abortHandler, { once: true });
    timeout = setTimeout(() => resolve({ timedOut: true }), timeoutMs);
  });
  try {
    const result = await Promise.race([operation, interrupted]);
    if (result.caught) return !signal.aborted;
    if (result.error) throw result.error;
    if (!bot._client.ended && bot.heldItem?.name === 'fishing_rod') bot.activateItem();
    let drainTimer;
    try {
      const drained = await Promise.race([
        operation.then(() => true),
        new Promise(resolve => { drainTimer = setTimeout(() => resolve(false), 3000); })
      ]);
      if (!drained) {
        bot.end('Fishing cancellation was not acknowledged');
        throw new Error('Fishing cancellation timed out; disconnected to reset fishing state.');
      }
    } finally { clearTimeout(drainTimer); }
    if (result.timedOut) throw new Error('Fishing cast timed out; check water, angle and server particles.');
    return false;
  } finally {
    clearTimeout(timeout);
    signal.removeEventListener('abort', abortHandler);
  }
}

export function minecraftAngles(yaw, pitch) {
  return { yaw: Math.PI - yaw * Math.PI / 180, pitch: -pitch * Math.PI / 180 };
}
