# Fishing Bot for Android

A native Android app that runs the Minecraft bot **on the phone**, using an embedded ARM64 Node.js 24 runtime. It does not depend on a PC, Termux installation, WebView, or remote server. Android 13 or newer and an ARM64 device are required.

## App controls

- **Overview:** connection, HP, hunger, uptime, damage lock, Microsoft device-code sign-in, fishing controls, and runtime log.
- **Statistics:** the same RAM, CPU, network, catch and item statistics as Telegram `/stats`. Process resources describe the Node bot child, not the Android UI process.
- **Inventory:** the bot's current inventory.
- **Settings:** server, port, Minecraft F3 yaw/pitch, Microsoft email, auto-fishing, optional Telegram token and numeric owner ID. Stop the bot before saving changes.
- **Start bot / Stop bot:** manage the whole runtime. Pausing fishing keeps the connection, damage monitoring, eating and Telegram active.

If Telegram is configured, its commands remain available even when the app is not visible. Telegram may also be left completely unconfigured for app-only use. Do not run two instances with the same Minecraft account or Telegram bot token simultaneously.

The APK contains **no account credentials, server address, personal fishing angles, or Microsoft tokens**. Settings and the authentication cache are held in app-private storage with cloud backup and device-transfer backup disabled. Microsoft passwords are never stored; a device-code login is offered inside the app when necessary.

## Background operation

The user starts a `specialUse` foreground service from the visible app. It keeps a partial wake lock while the Node child runs, and displays an ongoing notification with **Stop bot**. Closing or swiping away the activity does not stop this service. Stopping from the app or notification terminates Node, saves statistics and disconnects Minecraft. Android may recreate a killed service while it is still wanted; a user stop disables that restart. Device reboot does not automatically start the bot: open the app and press Start bot.

Use **Allow unrestricted battery use** in Overview, and allow notifications. Some manufacturers also offer an additional background/auto-launch setting in system App info. Android force-stop, exhausted battery, reboot, or manufacturer task killers can still interrupt any app. Continuous background networking uses battery.

The service is declared as a user-started persistent game client and damage monitor, rather than a finite data-sync job. See [Android foreground service types](https://developer.android.com/develop/background-work/services/fgs/service-types#special-use). This repository provides a sideloadable build; it does not claim Google Play approval.

The persistent damage lock is the same as on desktop: app restart and service restart **do not unlock it**. Inspect the fishing spot before using the explicit Reconnect action. Runtime recovery removes stale instance-lock files only after terminating a matching orphan child; it never deletes the persistent state file. Provisioning preserves an already-existing phone state file.

## Build

Requirements: Linux, JDK 17, Python 3.12+, `ar`, `patchelf`, Node.js 22.9+, Android SDK platform 35 and build tools, and network access on the first build.

From the repository root:

```bash
npm ci
python3 android/tools/prepare.py
# Set ANDROID_HOME or create ignored android/local.properties with sdk.dir=...
JAVA_HOME=/path/to/jdk17 android/gradlew -p android testDebugUnitTest assembleDebug lintDebug
```

The APK is `android/app/build/outputs/apk/debug/app-debug.apk`. This is a debug-signed sideload build, allowing explicit ADB provisioning with `run-as`; keep USB debugging access restricted to trusted computers. APKs, native binaries, dependency archives, local settings and auth caches are excluded from Git. The Gradle wrapper and downloaded runtime archives are checksum-pinned.

`prepare.py` downloads the pinned Android packages in `runtime-packages.json`, verifies SHA-256 hashes, and builds an allowlisted JavaScript bundle. It adapts versioned shared-library names/SONAMEs to names Android APK packaging accepts. Node is packaged as an extracted native executable in the APK's native library directory, so executable app-data files or an obsolete Android target SDK are not needed. Node uses the included CA bundle for HTTPS.

Build tools may install `patchelf` through the OS package manager, or set the `PATCHELF` environment variable to its executable. No NDK compilation is required. The runtime is currently ARM64 only.

## Install and configure

Connect a trusted, unlocked phone with authorized ADB debugging:

```bash
python3 android/tools/install_device.py --serial YOUR_DEVICE_SERIAL
```

The first app launch extracts dependencies into private storage. Enter your settings in the app, save them, and tap **Start bot**. Complete Microsoft sign-in through the app if requested.

To reuse the ignored local settings and Microsoft cache from an existing desktop installation:

```bash
python3 android/tools/install_device.py --serial YOUR_DEVICE_SERIAL --provision --stop-desktop
```

This explicitly stops the desktop systemd service before copying credentials, authentication-cache JSON files and initial statistics through ADB stdin. No credentials appear in command arguments, APK assets or logs. It also grants notifications and adds a device battery exemption. The first phone start keeps fishing paused so the connection can be checked; use **Start fishing** afterward. Microsoft may still require fresh sign-in if cached tokens cannot be reused on the new device.

On upgrades, omit `--provision` to keep the phone's own settings and tokens. Uninstalling the app deletes its private settings, damage lock and statistics.

## Local bridge and validation

The native UI talks to Node through a random-port HTTP server bound strictly to `127.0.0.1`. Every request requires a random 256-bit bearer token stored only inside the app's private directory. The bridge exposes read-only snapshots and a whitelist of fishing/reconnect actions; it does not expose settings, tokens or arbitrary command execution. Microsoft device codes are available only to this authenticated local UI and are cleared from snapshots once connected.

```bash
npm test
npm run check
npm run smoke
JAVA_HOME=/path/to/jdk17 android/gradlew -p android testDebugUnitTest assembleDebug lintDebug
```

Android DNS records are resolved through the platform resolver at service start, so Minecraft SRV records work with Android VPN/private-DNS settings. Node also has a bounded SRV fallback and TCP connection timeout.

The native unit tests cover compressed SRV answers, truncated packets and compression loops. The JavaScript tests cover authorization, command whitelisting, damaged-state reporting and optional Telegram configuration in addition to the existing bot tests. Verify the notification stop action, foreground/background transition, Microsoft cache reuse, commands and fishing on a real ARM64 device before unattended use. The generic Android CI artifact never contains local provisioning data.

## Third-party runtime

The embedded runtime uses checksum-pinned packages built by [Termux](https://github.com/termux/termux-packages), distributed from the official Termux package repository. Source recipes are available there under `packages/nodejs-lts`, `libc++`, `openssl`, `c-ares`, `libicu`, `libsqlite`, `zlib`, and `ca-certificates`. Package copyright/license files and the Node.js third-party notices are included inside the runtime bundle under `runtime-notices/`; the libc++ license is also in this directory's `third-party` folder. The JavaScript dependencies retain their own bundled license files.
