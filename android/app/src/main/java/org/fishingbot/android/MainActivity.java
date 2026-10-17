package org.fishingbot.android;

import android.Manifest;
import android.app.*;
import android.content.*;
import android.content.pm.PackageManager;
import android.graphics.Color;
import android.graphics.Typeface;
import android.net.Uri;
import android.os.*;
import android.provider.Settings;
import android.text.InputType;
import android.view.*;
import android.widget.*;
import org.json.JSONObject;
import java.io.File;
import java.util.*;
import java.util.concurrent.*;

public final class MainActivity extends Activity {
    private final ExecutorService io = Executors.newSingleThreadExecutor();
    private final Handler handler = new Handler(Looper.getMainLooper());
    private final Map<String,EditText> fields = new LinkedHashMap<>();
    private LinearLayout content;
    private TextView serviceState, status, stats, inventory, authText, runtimeLog;
    private Button start, stop, signIn;
    private CheckBox autoStart;
    private String tab = "Overview";
    private JSONObject snapshot;
    private boolean ready, polling;
    private int generation;
    private static final int TEXT = Color.rgb(36,36,32), MUTED = Color.rgb(100,100,92), ACCENT = Color.rgb(20,125,100);
    private final Runnable refresh = new Runnable() {
        @Override public void run() { poll(); handler.postDelayed(this,2000); }
    };

    @Override public void onCreate(Bundle state) {
        super.onCreate(state);
        getWindow().setSoftInputMode(WindowManager.LayoutParams.SOFT_INPUT_ADJUST_RESIZE);
        LinearLayout root = new LinearLayout(this); root.setOrientation(LinearLayout.VERTICAL); root.setBackgroundColor(Color.rgb(245,245,244));
        root.setPadding(dp(16),dp(12),dp(16),dp(8));
        root.setOnApplyWindowInsetsListener((view,insets) -> {
            android.graphics.Insets bars = insets.getInsets(WindowInsets.Type.systemBars());
            view.setPadding(dp(16)+bars.left,dp(12)+bars.top,dp(16)+bars.right,dp(8)+bars.bottom); return insets;
        });
        TextView title = label("Fishing Bot",24,TEXT); title.setTypeface(null,Typeface.BOLD); root.addView(title);
        serviceState = label("Preparing the local runtime…",13,MUTED); root.addView(serviceState);
        LinearLayout tabs = row();
        for (String name : new String[]{"Overview","Statistics","Inventory","Settings"}) {
            Button button = button(name,() -> { tab=name; showTab(); }); button.setTextSize(11);
            tabs.addView(button,new LinearLayout.LayoutParams(0,dp(48),1));
        }
        root.addView(tabs);
        ScrollView scroll = new ScrollView(this); scroll.setFillViewport(true);
        content = new LinearLayout(this); content.setOrientation(LinearLayout.VERTICAL); content.setPadding(0,dp(12),0,dp(24));
        scroll.addView(content); root.addView(scroll,new LinearLayout.LayoutParams(-1,0,1));
        LinearLayout actions = row();
        start = button("Start bot",this::startBot); stop = button("Stop bot",() -> startService(new Intent(this,BotService.class).setAction(BotService.STOP)));
        actions.addView(start,new LinearLayout.LayoutParams(0,dp(52),1)); actions.addView(stop,new LinearLayout.LayoutParams(0,dp(52),1)); root.addView(actions);
        setContentView(root); showTab();
        io.execute(() -> {
            try { RuntimeFiles.install(this); ready=true; runOnUiThread(this::showTab); }
            catch (Exception error) { runOnUiThread(() -> toast("Runtime preparation failed. Check free storage.")); }
        });
    }
    @Override protected void onResume() { super.onResume(); handler.post(refresh); }
    @Override protected void onPause() { handler.removeCallbacks(refresh); super.onPause(); }
    @Override protected void onDestroy() { handler.removeCallbacks(refresh); io.shutdown(); super.onDestroy(); }
    private int dp(int value) { return Math.round(value*getResources().getDisplayMetrics().density); }
    private LinearLayout row() { LinearLayout view = new LinearLayout(this); view.setOrientation(LinearLayout.HORIZONTAL); return view; }
    private TextView label(String text,int size,int color) {
        TextView view=new TextView(this); view.setText(text); view.setTextSize(size); view.setTextColor(color); view.setPadding(0,dp(5),0,dp(7)); view.setTextIsSelectable(true); return view;
    }
    private Button button(String text,Runnable action) {
        Button view=new Button(this); view.setText(text); view.setAllCaps(false); view.setTextColor(ACCENT); view.setOnClickListener(v -> action.run()); return view;
    }
    private void heading(String text) { TextView view=label(text,18,TEXT); view.setTypeface(null,Typeface.BOLD); content.addView(view); }
    private void divider() { View line=new View(this); line.setBackgroundColor(0xFFDADAD5); LinearLayout.LayoutParams params=new LinearLayout.LayoutParams(-1,dp(1)); params.setMargins(0,dp(16),0,dp(16)); content.addView(line,params); }
    private void toast(String text) { Toast.makeText(this,text,Toast.LENGTH_LONG).show(); }
    private void showTab() {
        generation++; content.removeAllViews(); fields.clear(); status=null; stats=null; inventory=null; authText=null; signIn=null; runtimeLog=null;
        if (!ready) { content.addView(label("Installing the bundled runtime on first launch. This can take a minute.",15,MUTED)); return; }
        switch(tab) {
            case "Statistics": heading("Statistics"); stats=label("Start the bot to view live resource and fishing statistics.",14,TEXT); content.addView(stats); break;
            case "Inventory": heading("Inventory"); inventory=label("Start the bot to inspect its inventory.",15,TEXT); content.addView(inventory); break;
            case "Settings": settings(); break;
            default:
                heading("Connection"); status=label("Bot is stopped.",15,TEXT); content.addView(status);
                authText=label("",16,ACCENT); content.addView(authText);
                signIn=button("Open Microsoft sign-in",() -> {
                    startActivity(new Intent(Intent.ACTION_VIEW,Uri.parse("https://www.microsoft.com/link")));
                }); signIn.setVisibility(View.GONE); content.addView(signIn);
                divider(); heading("Fishing controls");
                content.addView(button("Start fishing",() -> command("startfish")));
                content.addView(button("Pause fishing",() -> command("stopfish")));
                content.addView(button("Reconnect / clear damage lock",() -> new AlertDialog.Builder(this).setTitle("Reconnect?")
                    .setMessage("This clears the damage lock. Check that your fishing spot is safe first.")
                    .setPositiveButton("Reconnect",(dialog,which) -> command("reconnect")).setNegativeButton("Cancel",null).show()));
                divider(); heading("Background operation");
                content.addView(label("While running, the bot keeps a foreground notification with a Stop bot action. Swiping away this screen keeps the bot running.",14,MUTED));
                content.addView(button("Allow unrestricted battery use",this::batterySettings));
                content.addView(button("Open notification settings",() -> startActivity(new Intent(Settings.ACTION_APP_NOTIFICATION_SETTINGS).putExtra(Settings.EXTRA_APP_PACKAGE,getPackageName()))));
                divider(); heading("Runtime log"); runtimeLog=label("",12,MUTED); content.addView(runtimeLog);
                break;
        }
        render();
    }
    private void input(String key,String name,String value,int type) {
        content.addView(label(name,13,MUTED));
        EditText edit=new EditText(this); edit.setSingleLine(true); edit.setTextSize(15); edit.setTextColor(TEXT); edit.setInputType(type); edit.setText(value);
        content.addView(edit,new LinearLayout.LayoutParams(-1,dp(50))); fields.put(key,edit);
    }
    private void settings() {
        heading("Connection settings");
        content.addView(label("Stop the bot before saving changes. Settings and Microsoft tokens stay in this app's private storage.",14,MUTED));
        try {
            JSONObject config=RuntimeFiles.config(this), mc=config.getJSONObject("minecraft"), fishing=config.getJSONObject("fishing");
            Properties env=RuntimeFiles.environment(this);
            input("host","Server address",mc.optString("host",""),InputType.TYPE_CLASS_TEXT | InputType.TYPE_TEXT_VARIATION_URI);
            input("port","Server port",String.valueOf(mc.optInt("port",25565)),InputType.TYPE_CLASS_NUMBER);
            input("yaw","Yaw (Minecraft F3 degrees)",fishing.isNull("yaw") ? "" : fishing.optString("yaw"),InputType.TYPE_CLASS_NUMBER | InputType.TYPE_NUMBER_FLAG_DECIMAL | InputType.TYPE_NUMBER_FLAG_SIGNED);
            input("pitch","Pitch (Minecraft F3 degrees)",fishing.isNull("pitch") ? "" : fishing.optString("pitch"),InputType.TYPE_CLASS_NUMBER | InputType.TYPE_NUMBER_FLAG_DECIMAL | InputType.TYPE_NUMBER_FLAG_SIGNED);
            input("username","Microsoft account email",env.getProperty("MC_USERNAME",""),InputType.TYPE_CLASS_TEXT | InputType.TYPE_TEXT_VARIATION_EMAIL_ADDRESS);
            autoStart=new CheckBox(this); autoStart.setText("Start fishing when connected"); autoStart.setTextColor(TEXT); autoStart.setChecked(fishing.optBoolean("autoStart",true)); content.addView(autoStart);
            divider(); heading("Telegram (optional)");
            input("token","Bot token",env.getProperty("TELEGRAM_BOT_TOKEN",""),InputType.TYPE_CLASS_TEXT | InputType.TYPE_TEXT_VARIATION_PASSWORD);
            input("owner","Owner numeric user ID",env.getProperty("TELEGRAM_OWNER_ID",""),InputType.TYPE_CLASS_NUMBER);
            content.addView(button("Save settings",this::saveSettings));
        } catch(Exception error) { content.addView(label("Cannot read settings. Restart the app to prepare the runtime.",15,TEXT)); }
    }
    private String value(String key) { return fields.get(key).getText().toString().trim(); }
    private void saveSettings() {
        if (BotService.running) { toast("Stop the bot before saving settings."); return; }
        try {
            String host=value("host"), username=value("username"), token=value("token"), owner=value("owner");
            if (host.isBlank() || username.isBlank()) throw new Exception();
            int port=Integer.parseInt(value("port")); double yaw=Double.parseDouble(value("yaw")),pitch=Double.parseDouble(value("pitch"));
            if (port<1 || port>65535 || !Double.isFinite(yaw) || !Double.isFinite(pitch) || Math.abs(yaw)>360 || Math.abs(pitch)>90) throw new Exception();
            if ((!token.isEmpty() || !owner.isEmpty()) && (token.isEmpty() || !owner.matches("[1-9][0-9]*"))) throw new Exception();
            for (String s:new String[]{host,username,token,owner}) if (s.contains("\n") || s.contains("\r") || s.contains("\"")) throw new Exception();
            JSONObject config=RuntimeFiles.config(this);
            config.getJSONObject("minecraft").put("host",host).put("port",port);
            config.getJSONObject("fishing").put("yaw",yaw).put("pitch",pitch).put("autoStart",autoStart.isChecked());
            RuntimeFiles.write(new File(RuntimeFiles.root(this),"config.json"),config.toString(2));
            RuntimeFiles.write(new File(RuntimeFiles.root(this),".env"),"MC_USERNAME=\""+username+"\"\nTELEGRAM_BOT_TOKEN=\""+token+"\"\nTELEGRAM_OWNER_ID=\""+owner+"\"\n");
            toast("Settings saved privately.");
        } catch(Exception error) { toast("Enter a server, port, valid yaw/pitch and account email. Telegram requires both a token and a numeric owner ID."); }
    }
    private void startBot() {
        if (!ready) { toast("Runtime is still being prepared."); return; }
        if (checkSelfPermission(Manifest.permission.POST_NOTIFICATIONS)!=PackageManager.PERMISSION_GRANTED) {
            requestPermissions(new String[]{Manifest.permission.POST_NOTIFICATIONS},10); return;
        }
        startForegroundService(new Intent(this,BotService.class));
    }
    @Override public void onRequestPermissionsResult(int code,String[] permissions,int[] results) {
        super.onRequestPermissionsResult(code,permissions,results);
        if(code==10 && results.length>0 && results[0]==PackageManager.PERMISSION_GRANTED) startBot();
        else if(code==10) toast("Allow notifications so the background bot has a visible stop action.");
    }
    private void batterySettings() {
        PowerManager manager=getSystemService(PowerManager.class);
        if(manager.isIgnoringBatteryOptimizations(getPackageName())) { toast("Battery optimization is already disabled for this app."); return; }
        startActivity(new Intent(Settings.ACTION_REQUEST_IGNORE_BATTERY_OPTIMIZATIONS,Uri.parse("package:"+getPackageName())));
    }
    private void command(String command) {
        if (!BotService.running) { toast("Start the bot first."); return; }
        io.execute(() -> {
            try { String message=BridgeClient.request(this,command).optString("message"); runOnUiThread(() -> toast(message)); }
            catch(Exception error) { runOnUiThread(() -> toast("Bot is not ready yet. Check the connection status.")); }
        });
    }
    private void poll() {
        start.setEnabled(ready && !BotService.running); stop.setEnabled(BotService.running);
        serviceState.setText(BotService.running ? "Background service active" : BotService.state);
        if (!ready || polling || io.isShutdown()) return;
        polling=true;
        int current=generation;
        io.execute(() -> {
            JSONObject result=null; String log="";
            try { if(BotService.running) result=BridgeClient.request(this,null); } catch(Exception ignored) { }
            if("Overview".equals(tab)) try {
                File file=new File(RuntimeFiles.root(this),"runtime.log");
                if(file.exists()) { String text=RuntimeFiles.read(file); log=text.substring(Math.max(0,text.length()-3000)); }
            } catch(Exception ignored) { }
            JSONObject finalResult=result; String finalLog=log;
            runOnUiThread(() -> {
                polling=false; snapshot=finalResult;
                if(current==generation) { render(); if(runtimeLog!=null) runtimeLog.setText(finalLog); }
            });
        });
    }
    private void render() {
        if(snapshot==null) {
            if(status!=null) status.setText(BotService.running ? "Starting or reconnecting…" : BotService.state);
            if(authText!=null) authText.setText(""); if(signIn!=null) signIn.setVisibility(View.GONE); return;
        }
        if(status!=null) status.setText(snapshot.optString("status")+(snapshot.isNull("error") ? "" : "\n"+snapshot.optString("error")));
        if(stats!=null) stats.setText(snapshot.optString("stats"));
        if(inventory!=null) inventory.setText(snapshot.optString("inventory"));
        JSONObject auth=snapshot.optJSONObject("auth");
        if(authText!=null) authText.setText(auth==null ? "" : "Microsoft sign-in code: "+auth.optString("code"));
        if(signIn!=null) signIn.setVisibility(auth==null ? View.GONE : View.VISIBLE);
    }
}
