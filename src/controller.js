import { fishOnce, minecraftAngles } from './fishing.js';
import { CatchTracker } from './catches.js';
import { Resources } from './resources.js';

export class Controller {
  constructor({ config, store, createBot, autoEatPlugin, notify = () => {}, logger = console, resources = new Resources() }) {
    Object.assign(this, { config, store, createBot, autoEatPlugin, notify, logger, resources });
    this.startedAt = Date.now();
    this.wanted = config.fishing.autoStart;
    this.connected = false;
    this.stopped = false;
    this.attempts = 0;
    this.bot = null;
    this.lastAlerts = new Map();
  }

  alert(message, key = message) {
    const now = Date.now();
    if (now - (this.lastAlerts.get(key) || 0) < 30000) return;
    this.lastAlerts.set(key, now);
    this.logger.log(message);
    Promise.resolve().then(() => this.notify(message)).catch(() => this.logger.error('Telegram notification delivery failed.'));
  }

  start() {
    this.resources.start();
    this.flushTimer = setInterval(() => this.persist(), 10000);
    if (this.store.state.damageLock) this.alert('Damage protection is locked. Inspect the fishing spot, then use /reconnect to unlock.');
    else this.connect();
  }

  persist() {
    try { this.store.save(); }
    catch {
      this.stopped = true;
      clearTimeout(this.reconnectTimer);
      this.bot?.end('State persistence failed');
      this.alert('State persistence failed. Bot stopped; repair writable storage before restarting.', 'storage');
    }
  }

  connect() {
    if (this.stopped || this.store.state.damageLock || this.bot) return;
    clearTimeout(this.reconnectTimer);
    let bot;
    try {
      bot = this.createBot({
        ...this.config.minecraft, username: this.config.username,
        auth: 'microsoft', profilesFolder: this.config.storage.authDirectory,
        respawn: false, hideErrors: true,
        onMsaCode: data => {
          // Device codes are credentials: display locally, never send to Telegram.
          this.logger.log(`Microsoft login: open ${data.verification_uri || 'https://www.microsoft.com/link'} and enter ${data.user_code}`);
          this.alert('Microsoft sign-in required. Check the local terminal for the device code.', 'auth');
        }
      });
    } catch (error) {
      this.alert(`Connection could not start: ${this.describe(error)}`, 'connection-error');
      this.scheduleReconnect();
      return;
    }
    this.bot = bot;
    this.resources.trackMinecraft(bot._client);
    const session = { bot, ready: false, busy: false, health: null, abort: null, tracker: null, closed: false };
    this.session = session;
    const current = () => this.session === session && !session.closed && !this.stopped && !this.store.state.damageLock;

    bot.on('entityHurt', entity => {
      if (entity?.id === bot.entity?.id && entity?.id !== undefined) this.damage('Server reported damage.');
    });
    // Listen directly too: damage_event can precede entity metadata.
    bot._client.on('damage_event', packet => {
      if (packet.entityId === bot.entity?.id) this.damage('Server reported a damage packet.');
    });
    bot.on('health', () => {
      if (session.health !== null && bot.health < session.health) this.damage(`HP dropped from ${session.health} to ${bot.health}.`);
      session.health = bot.health;
      if (bot.food <= this.config.autoEat.minHunger) session.abort?.abort();
    });
    bot.on('death', () => this.damage('The bot died.'));
    bot.once('spawn', () => {
      if (!current()) return;
      try {
        bot.loadPlugin(this.autoEatPlugin);
        bot.autoEat.disableAuto();
        bot.autoEat.setOpts({
          ...this.config.autoEat, priority: 'foodPoints', returnToLastItem: false,
          offhand: false, strictErrors: true, eatingTimeout: 5000
        });
        session.tracker = new CatchTracker(bot, this.store, this.config.fishing);
        session.health = bot.health;
        session.ready = true;
        this.connected = true;
        this.connectedAt = Date.now();
        this.attempts = 0;
        session.timer = setInterval(() => void this.work(session), 500);
        this.alert(`Connected to ${this.config.minecraft.host} as ${bot.username}.`, 'connected');
      } catch (error) {
        this.alert(`Initialization failed: ${this.describe(error)}`, 'init');
        bot.end('Initialization failed');
      }
    });
    bot.on('kicked', reason => this.alert(`Minecraft kick: ${this.describe(reason)}`, 'kick'));
    bot.on('error', error => {
      this.alert(`Minecraft error: ${this.describe(error)}`, 'minecraft-error');
      bot.end('Connection error');
    });
    bot.once('end', reason => {
      session.closed = true;
      clearInterval(session.timer);
      session.abort?.abort();
      session.tracker?.stop();
      if (this.session !== session) return;
      this.connected = false;
      this.bot = null;
      this.store.increment('disconnects');
      this.persist();
      this.alert(`Disconnected: ${this.describe(reason)}. ${this.store.state.damageLock ? 'Damage lock active; automatic reconnect disabled.' : this.stopped ? 'Bot stopped.' : 'Reconnect scheduled.'}`, 'disconnect');
      this.scheduleReconnect();
    });
  }

  describe(error) {
    let text;
    try { text = typeof error === 'string' ? error : error?.message || JSON.stringify(error); }
    catch { text = 'Unknown error'; }
    return String(text || 'Unknown reason').replaceAll(this.config.telegramToken, '[redacted]').replaceAll(this.config.username, '[account]').slice(0, 700);
  }

  scheduleReconnect() {
    if (this.stopped || this.store.state.damageLock || this.bot) return;
    clearTimeout(this.reconnectTimer);
    const delay = Math.min(this.config.reconnect.initialDelayMs * 2 ** Math.min(this.attempts++, 16), this.config.reconnect.maxDelayMs);
    this.reconnectTimer = setTimeout(() => this.connect(), delay);
  }

  damage(reason) {
    if (this.store.state.damageLock || this.stopped) return;
    this.store.state.damageLock = true;
    this.store.state.lastDamage = { at: new Date().toISOString(), reason };
    this.store.increment('damageEvents');
    clearTimeout(this.reconnectTimer);
    clearInterval(this.session?.timer);
    this.connected = false;
    // Disconnect synchronously before disk I/O, Telegram, or task cancellation.
    this.bot?.end('Damage protection');
    this.persist();
    this.alert(`DAMAGE ALERT: ${reason} Disconnected immediately. Automatic reconnect is locked, including after process restart. Use /reconnect only after checking the spot.`, 'damage');
  }

  async work(session) {
    if (session !== this.session || session.closed || !session.ready || session.busy || this.stopped || this.store.state.damageLock) return;
    if (session.retryAt > Date.now()) return;
    const bot = session.bot;
    session.busy = true;
    try {
      if (bot.food <= this.config.autoEat.minHunger) {
        await bot.autoEat.eat({ equipOldItem: false });
        if (session.closed || this.store.state.damageLock || this.stopped) return;
        this.store.increment('meals');
        return;
      }
      if (!this.wanted) return;
      const rod = bot.inventory.items().find(item => item.name === 'fishing_rod' && item.slot >= 36 && item.slot <= 44);
      if (!rod) throw new Error('No fishing rod in hotbar slots 1–9.');
      bot.setQuickBarSlot(rod.slot - 36);
      const angles = minecraftAngles(this.config.fishing.yaw, this.config.fishing.pitch);
      await bot.look(angles.yaw, angles.pitch, true);
      if (session.closed || !this.wanted || this.stopped || this.store.state.damageLock) return;
      // Hunger can change while the look operation is pending.
      if (bot.food <= this.config.autoEat.minHunger) return;
      session.abort = new AbortController();
      session.tracker.begin();
      this.store.increment('casts');
      const caught = await fishOnce(bot, session.abort.signal, this.config.fishing.castTimeoutMs);
      if (caught && !session.closed && !this.store.state.damageLock) {
        this.store.increment('catches');
        session.tracker.caught();
        // Preserve an observation window for items collected by hoppers.
        session.retryAt = Date.now() + this.config.fishing.catchWindowMs;
      } else session.tracker.stop();
    } catch (error) {
      if (!session.closed && !this.store.state.damageLock && !this.stopped) {
        this.store.increment('fishingErrors');
        session.retryAt = Date.now() + this.config.fishing.retryDelayMs;
        this.alert(`Fishing/food error: ${this.describe(error)}`, 'work-error');
        // An equip failure can leave the upstream eating plugin busy.
        if (bot.autoEat.isEating) bot.end('Resetting failed eating operation');
      }
    } finally { session.abort = null; session.busy = false; }
  }

  startFishing() {
    if (this.store.state.damageLock) return 'Damage lock active. Inspect the spot and use /reconnect first.';
    this.wanted = true;
    return this.connected ? 'Fishing enabled.' : 'Fishing enabled; waiting for connection.';
  }

  stopFishing() {
    this.wanted = false;
    this.session?.abort?.abort();
    return 'Fishing paused. Any active cast is being reeled in. Auto-eat remains enabled.';
  }

  reconnect() {
    if (this.stopped) return 'Bot stopped because of shutdown or storage failure. Restart the process after resolving the cause.';
    if (this.bot) return 'Already connected or connecting.';
    this.store.state.damageLock = false;
    this.persist();
    if (this.stopped) return 'Cannot unlock: state persistence failed.';
    this.attempts = 0;
    this.connect();
    return 'Damage lock cleared. Connecting to Minecraft.';
  }

  status() {
    return [
      `Connection: ${this.connected ? 'connected' : this.bot ? 'connecting' : 'disconnected'}`,
      `Damage lock: ${this.store.state.damageLock ? 'ACTIVE' : 'off'}`,
      `Fishing: ${this.wanted ? 'enabled' : 'paused'}`,
      `HP: ${this.connected ? this.bot.health : 'unknown'} / 20`,
      `Hunger: ${this.connected ? this.bot.food : 'unknown'} / 20`,
      `Process uptime: ${Math.floor((Date.now() - this.startedAt) / 1000)} seconds`,
      `Connection uptime: ${this.connected ? Math.floor((Date.now() - this.connectedAt) / 1000) : 0} seconds`,
      ...(this.store.state.lastDamage ? [`Last damage: ${this.store.state.lastDamage.at} — ${this.store.state.lastDamage.reason}`] : [])
    ].join('\n');
  }

  stats() {
    const s = this.store.state.stats;
    const items = map => Object.entries(map).sort((a, b) => b[1] - a[1]).map(([name, n]) => `${name}: ${n}`).join('\n') || 'None';
    return `${this.resources.report()}\n\nLifetime statistics\nCasts: ${s.casts}\nCompleted catches: ${s.catches}\nFishing/food errors: ${s.fishingErrors}\nMeals: ${s.meals}\nDisconnects: ${s.disconnects}\nDamage events: ${s.damageEvents}\n\nNearby catch-window observations (heuristic):\n${items(s.observedItems)}\n\nItems picked up by the bot (all sources):\n${items(s.collectedItems)}\n\nThese item lists overlap. Hopper contents and exact catch ownership are not visible.`;
  }

  inventory() {
    if (!this.connected) return 'Minecraft is not connected.';
    return this.bot.inventory.items().map(item => `Slot ${item.slot}: ${item.name} × ${item.count}`).join('\n') || 'Inventory is empty.';
  }

  shutdown() {
    this.stopped = true;
    this.resources.stop();
    clearInterval(this.flushTimer);
    clearTimeout(this.reconnectTimer);
    clearInterval(this.session?.timer);
    this.bot?.end('Process shutdown');
    this.persist();
  }
}
