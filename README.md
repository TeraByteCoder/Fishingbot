# Headless Minecraft Fishing Bot

A headless Minecraft Java **1.21.4** fishing bot for a server you configure, built with Node.js, Mineflayer, mineflayer-auto-eat, and Telegraf. Runs on Linux, VPS hosts, and Android with Termux. No Minecraft client window, browser on the host, or inbound port is required. The first Microsoft sign-in can be completed in a browser on another device.

## Features

- Microsoft device-code login with a private local authentication cache.
- Automatic reconnect with exponential backoff after ordinary disconnects.
- Hotbar fishing rod selection, fixed Minecraft yaw/pitch, repeated casting and reeling.
- Automatic eating from inventory, serialized with fishing to avoid conflicting hand actions.
- Immediate disconnect on self-damage packets, hurt events, HP loss, or death.
- Persistent damage lock: **no automatic reconnect after damage, even after restarting Node.js**. Only the authorized `/reconnect` command clears it.
- Private owner-only Telegram control, notifications, and persistent JSON statistics.
- Atomic state replacement, validation that fails closed, and a single-instance lock.

## Quick start

Requirements: Node.js **22.9+** (Node 24 LTS recommended), npm, a Microsoft account that owns Minecraft Java, and a Telegram bot token.

```bash
npm install
cp .env.example .env
cp config.example.json config.json
chmod 600 .env config.json
```

Set `minecraft.host`, `fishing.yaw`, and `fishing.pitch` in `config.json` before starting. These values have no defaults: the example contains an empty server address and `null` angles, and startup rejects them until you supply your own.

Edit `.env`:

```dotenv
MC_USERNAME=your-microsoft-account@example.com
TELEGRAM_BOT_TOKEN=your-botfather-token
TELEGRAM_OWNER_ID=your-numeric-telegram-user-id
```

Create the Telegram bot with [@BotFather](https://t.me/BotFather), then open a private conversation with it and press **Start**. `TELEGRAM_OWNER_ID` is your numeric personal user ID, not a username or group ID. Commands are ignored unless both the sender ID and private chat ID match this value. Tokens and account names belong in `.env`, never in source files.

```bash
npm run smoke
npm start
```

Follow the Microsoft device-code instruction printed in the local terminal. The code is intentionally not forwarded to Telegram. Authentication tokens are cached in `auth-cache/` for later starts.

Before running unattended, position the account at the fishing spot using a normal Minecraft client, put a fishing rod in hotbar slots 1–9, place suitable food in inventory, then disconnect that client. The bot does not walk to water, solve server login menus, or bypass server challenges. Check the server's automation rules before using it.

## Telegram commands

| Command | Behavior |
| --- | --- |
| `/status` | Connection, damage lock, fishing state, HP, hunger, process and connection uptime |
| `/stats` | Lifetime casts, completed catches, item observations, pickups, meals, errors, disconnects |
| `/inventory` | Item names, stack counts, and internal inventory slot numbers |
| `/startfish` | Enable fishing; cannot clear a damage lock |
| `/stopfish` | Pause fishing and reel in an active cast; eating remains enabled |
| `/reconnect` | Clear a persisted damage lock and connect when disconnected |
| `/help` | Command list |

Notifications cover connection, disconnection, damage, Microsoft sign-in requirements, and errors. Repeated equivalent alerts are limited to one per 30 seconds. Commands queued while the process was offline are discarded on launch, preventing an old `/reconnect` from clearing a later damage lock. Telegram uses long polling; run one process per Telegram bot token.

After a damage alert, inspect the area before sending `/reconnect`. If already connected or connecting, this command reports that state. `/stopfish` survives ordinary reconnects within the same process; after a process restart, `fishing.autoStart` determines whether fishing starts.

## Configuration

Copy and edit `config.example.json` as `config.json`. A local configuration must supply your server address and both fishing angles. Other settings inherit the example defaults. Use `CONFIG_PATH` to select another JSON file. Relative storage paths resolve from the working directory.

| Setting | Default | Meaning |
| --- | --- | --- |
| `minecraft.host` / `port` | Required / `25565` | Your server address |
| `minecraft.version` | `1.21.4` | Fixed supported target version |
| `fishing.autoStart` | `true` | Begin fishing after connecting |
| `fishing.yaw` / `pitch` | Both required | Your **Minecraft F3 degrees**, converted to Mineflayer radians |
| `fishing.castTimeoutMs` | `120000` | Maximum duration of one cast |
| `fishing.retryDelayMs` | `3000` | Delay after fishing or eating errors |
| `fishing.catchWindowMs` | `2500` | Item observation window after a successful reel |
| `fishing.catchRadius` | `6` | Radius in blocks around the casting position |
| `autoEat.minHunger` | `15` | Eat at or below this hunger level, on a 0–20 scale |
| `autoEat.bannedFood` | See example | Food excluded from selection |
| `reconnect.initialDelayMs` | `5000` | First reconnect delay |
| `reconnect.maxDelayMs` | `120000` | Maximum exponential reconnect delay |
| `storage.stateFile` | `data/state.json` | Statistics and persistent damage lock |
| `storage.authDirectory` | `auth-cache` | Microsoft authentication cache |

Read the yaw and pitch from Minecraft F3 at your own fishing spot. Negative Minecraft pitch looks upward; positive pitch looks downward. Configure both angles for your farm. The bot does not move its feet.

## What the statistics mean

- **Casts:** calls to Mineflayer's fishing operation, including interrupted or unsuccessful attempts.
- **Completed catches:** successful Mineflayer bite/reel completions. This does not prove that an item entered inventory or a hopper.
- **Nearby catch-window observations:** item entities with decoded item metadata near the casting position, correlated with the reel window. Metadata received up to one second before completion is retained, even if a hopper removes the entity immediately. Each entity is counted once per cast.
- **Items picked up by the bot:** decoded items from self-collection events, from all sources. This list overlaps with observations and must not be added to it.

Vanilla server events do not identify an item's fishing owner, and hoppers do not send player pickup events. A hopper catch can be observed when the server sends its item entity and metadata first. Items hidden or removed before those packets cannot be identified. Nearby players' drops can enter the heuristic observation count. Exact hopper contents require server support or opening the container, which this MVP does not do.

## Damage protection and persistence

The controller marks the session locked, cancels pending reconnects, and ends the Minecraft connection synchronously before writing state or sending an alert. It listens to `entityHurt`, the 1.21.4 `damage_event` packet, health decreases, and death. The first health report establishes a baseline; damage before a server event reaches the client cannot be detected.

Fishing and eating share one worker. On low hunger or `/stopfish`, the bot reels in and waits for the outstanding Mineflayer fishing task to finish. If the server does not acknowledge cancellation within three seconds, it disconnects to reset the fishing task, then reconnects normally unless damage protection is locked.

`data/state.json` stores the damage lock immediately and flushes statistics every ten seconds and on shutdown. A crash can lose up to ten seconds of statistics. Invalid state refuses startup; storage write failures stop the bot. Keep the state file when moving or restarting the installation. Deleting it also deletes the damage lock. Disk failure or power loss can prevent persistence; a client-side bot cannot guarantee that a server will never damage the account during disconnect latency.

One process may use a state file at a time. After a hard crash, a stale `data/state.json.lock` can remain. Check that no instance is running before removing **only the `.lock` file**, then restart. Keep `state.json` itself.

## Linux / VPS

Run from a persistent working directory with writable `data/` and `auth-cache/`. For a systemd user service, copy `deploy/fishingbot.service.example` to `~/.config/systemd/user/fishingbot.service` and replace the working directory and Node executable path:

```bash
systemctl --user daemon-reload
systemctl --user enable --now fishingbot
journalctl --user -u fishingbot -f
```

The service intentionally does not restart automatically after an unexpected process exit, so an operator can inspect storage or stale instance-lock failures. Ordinary Minecraft disconnects are handled inside the running bot. A Minecraft damage disconnect leaves Telegram and the process running, with the damage lock active.

## Android / Termux

Install a current Termux build from its official distribution, then:

```bash
pkg update
pkg install nodejs-lts git
node --version
```

Use Node 22.9 or newer. Copy or clone the project into Termux's private home directory and follow Quick start. If a transitive dependency needs a native build, install `python`, `make`, and `clang` with `pkg install`. For longer sessions, acquire a wake lock with `termux-wake-lock` and exempt Termux from Android battery optimization. Android may still terminate background processes. Keep `.env` and the authentication cache out of shared Android storage.

## Development and validation

```bash
npm run check
npm test
npm run smoke
```

Tests use Node's built-in runner and fake Minecraft/Telegram endpoints; they do not require dependency installation or credentials. They cover damage locking and explicit unlock, reconnect, serialized eating and fishing, cast cancellation, timeouts, item observations, state corruption, storage failures, angles, and Telegram access control. `smoke` additionally checks the installed runtime dependencies and Minecraft version support without opening a connection.

The implementation follows the [Mineflayer API](https://github.com/PrismarineJS/mineflayer/blob/master/docs/api.md), [Mineflayer fishing implementation](https://github.com/PrismarineJS/mineflayer/blob/master/lib/plugins/fishing.js), [auto-eat API](https://github.com/linkle69/mineflayer-auto-eat), and [Telegraf API](https://telegraf.js.org/).

Dependency installation and live integration were not verified in the initial restricted build environment because npm/GitHub networking was unavailable. A package lock must be generated by `npm install` on a network-enabled host before reproducible deployment. CI installs the declared dependencies and runs syntax, unit, and import checks.

For live acceptance, sign in, verify all six requested commands, confirm the casting direction and repeated catches, lower hunger in a controlled environment to check resumption after eating, then trigger controlled damage on a test server. Verify immediate disconnection, the Telegram alert, no automatic reconnect after waiting and restarting, and explicit recovery using `/reconnect`. Only then validate the actual server/farm behavior on your configured server.

## Publishing

Only source, example settings, tests, and documentation belong in the public repository. `.gitignore` excludes `.env`, local config, authentication tokens, runtime data, and dependencies. On a normal writable checkout with GitHub CLI access:

```bash
git init -b main
git add .
git commit -m "Implement headless Minecraft fishing bot with Telegram control"
gh repo create Fishingbot --public --source=. --remote=origin --push
```

Review `git diff --cached` before publishing if you have added local files. Runtime credentials should never be committed.
