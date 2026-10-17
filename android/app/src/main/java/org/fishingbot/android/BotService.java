package org.fishingbot.android;

import android.app.*;
import android.content.*;
import android.content.pm.ServiceInfo;
import android.os.*;
import android.net.ConnectivityManager;
import android.net.LinkProperties;
import java.io.*;
import java.util.concurrent.*;

public final class BotService extends Service {
    public static final String STOP = "org.fishingbot.android.STOP";
    static volatile boolean running;
    static volatile String state = "Stopped";
    private volatile java.lang.Process child;
    private volatile boolean stopping;
    private PowerManager.WakeLock wakeLock;
    private final ExecutorService worker = Executors.newSingleThreadExecutor();
    private static final int NOTIFICATION = 41;

    @Override public void onCreate() {
        super.onCreate();
        NotificationManager manager = getSystemService(NotificationManager.class);
        manager.createNotificationChannel(new NotificationChannel("bot", "Running fishing bot", NotificationManager.IMPORTANCE_LOW));
    }
    private Notification notification(String text) {
        PendingIntent open = PendingIntent.getActivity(this,0,new Intent(this,MainActivity.class),PendingIntent.FLAG_IMMUTABLE | PendingIntent.FLAG_UPDATE_CURRENT);
        PendingIntent stop = PendingIntent.getService(this,1,new Intent(this,BotService.class).setAction(STOP),PendingIntent.FLAG_IMMUTABLE | PendingIntent.FLAG_UPDATE_CURRENT);
        return new Notification.Builder(this,"bot").setSmallIcon(org.fishingbot.android.R.drawable.ic_fishing)
            .setContentTitle("Fishing Bot is running").setContentText(text).setOngoing(true).setOnlyAlertOnce(true)
            .setContentIntent(open).addAction(new Notification.Action.Builder(null,"Stop bot",stop).build()).build();
    }
    @Override public int onStartCommand(Intent intent,int flags,int startId) {
        if (intent != null && STOP.equals(intent.getAction())) { stopBot(); return START_NOT_STICKY; }
        if (running) return START_STICKY;
        if (intent == null && !getSharedPreferences("service",0).getBoolean("wanted",false)) { stopSelf(); return START_NOT_STICKY; }
        stopping = false; running = true; state = "Starting…";
        getSharedPreferences("service",0).edit().putBoolean("wanted",true).apply();
        if (Build.VERSION.SDK_INT >= 34) startForeground(NOTIFICATION, notification("Open the app for status and controls"),ServiceInfo.FOREGROUND_SERVICE_TYPE_SPECIAL_USE);
        else startForeground(NOTIFICATION,notification("Open the app for status and controls"));
        PowerManager power = getSystemService(PowerManager.class);
        wakeLock = power.newWakeLock(PowerManager.PARTIAL_WAKE_LOCK,getPackageName()+":bot");
        wakeLock.acquire();
        worker.execute(() -> {
            try {
                RuntimeFiles.install(this);
                if (stopping) return;
                File root = RuntimeFiles.root(this);
                stopOrphan(root);
                new File(root,"data/state.json.lock").delete();
                new File(root,"mobile-bridge.json").delete();
                File log = new File(root,"runtime.log");
                if (log.length() > 2 * 1024 * 1024) log.delete();
                String libraries = getApplicationInfo().nativeLibraryDir;
                ProcessBuilder builder = new ProcessBuilder(libraries+"/libfishingnode.so","--env-file=.env","src/mobile.js");
                builder.directory(root).redirectErrorStream(true).redirectOutput(ProcessBuilder.Redirect.appendTo(log));
                builder.environment().put("LD_LIBRARY_PATH",libraries);
                builder.environment().put("NODE_EXTRA_CA_CERTS",new File(root,"cert.pem").getPath());
                builder.environment().put("SSL_CERT_FILE",new File(root,"cert.pem").getPath());
                builder.environment().put("TMPDIR",getCacheDir().getPath());
                ConnectivityManager network = getSystemService(ConnectivityManager.class);
                LinkProperties properties = network.getLinkProperties(network.getActiveNetwork());
                if (properties != null) {
                    String dns = properties.getDnsServers().stream().map(java.net.InetAddress::getHostAddress).collect(java.util.stream.Collectors.joining(","));
                    builder.environment().put("FISHINGBOT_DNS_SERVERS",dns);
                }
                org.json.JSONObject minecraft = RuntimeFiles.config(this).getJSONObject("minecraft");
                String srv = DnsSrv.lookup(this,minecraft.optString("host"),minecraft.optInt("port",25565));
                if (!srv.isEmpty()) builder.environment().put("FISHINGBOT_SRV_RECORDS",srv);
                synchronized(this) {
                    if (stopping) return;
                    child = builder.start();
                }
                state = "Running";
                int exit = child.waitFor();
                state = stopping ? "Stopped" : "Runtime exited ("+exit+"). Open the app to restart.";
            } catch (Exception error) { state = "Unable to start. Check settings and runtime log."; }
            finally {
                running = false;
                if (!stopping) getSharedPreferences("service",0).edit().putBoolean("wanted",false).apply();
                if (wakeLock != null && wakeLock.isHeld()) wakeLock.release();
                stopForeground(STOP_FOREGROUND_REMOVE);
                stopSelf();
            }
        });
        return START_STICKY;
    }
    private void stopOrphan(File root) throws Exception {
        File pidFile = new File(root,"runtime.pid");
        if (!pidFile.exists()) return;
        int pid = Integer.parseInt(RuntimeFiles.read(pidFile).trim());
        File command = new File("/proc/"+pid+"/cmdline");
        if (command.exists()) {
            String text = RuntimeFiles.read(command);
            if (text.contains(getPackageName()+"-") && text.contains("/lib/arm64/libfishingnode.so") && text.contains("src/mobile.js")) {
                android.os.Process.sendSignal(pid,15);
                for (int i=0;i<30 && command.exists();i++) Thread.sleep(100);
                if (command.exists()) android.os.Process.killProcess(pid);
            }
        }
        pidFile.delete();
    }
    private synchronized void stopBot() {
        stopping = true; state = "Stopping…";
        getSharedPreferences("service",0).edit().putBoolean("wanted",false).apply();
        java.lang.Process process = child;
        if (process != null) {
            process.destroy();
            new Thread(() -> { try { if (!process.waitFor(5,TimeUnit.SECONDS)) process.destroyForcibly(); } catch (InterruptedException e) { Thread.currentThread().interrupt(); } },"bot-stop").start();
        } else { stopForeground(STOP_FOREGROUND_REMOVE); stopSelf(); }
    }
    @Override public void onDestroy() { if (running) stopBot(); worker.shutdown(); super.onDestroy(); }
    @Override public IBinder onBind(Intent intent) { return null; }
}
