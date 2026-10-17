package org.fishingbot.android;

import android.content.Context;
import org.json.JSONObject;
import java.io.*;
import java.nio.charset.StandardCharsets;
import java.nio.file.Files;
import java.util.*;
import java.util.zip.*;

final class RuntimeFiles {
    static File root(Context c) { return new File(c.getFilesDir(), "bot"); }
    static String read(File file) throws IOException { return new String(Files.readAllBytes(file.toPath()), StandardCharsets.UTF_8); }
    static void write(File file, String value) throws IOException {
        File parent = file.getParentFile();
        if (parent != null && !parent.exists() && !parent.mkdirs()) throw new IOException("Cannot create private storage");
        File temp = new File(file.getPath() + ".tmp");
        Files.write(temp.toPath(), value.getBytes(StandardCharsets.UTF_8));
        if (!temp.renameTo(file)) throw new IOException("Cannot update private settings");
    }
    static synchronized void install(Context context) throws IOException {
        File root = root(context);
        if (!root.exists() && !root.mkdirs()) throw new IOException("Cannot create runtime directory");
        String version;
        try (InputStream in = context.getAssets().open("bot-version.txt")) { version = new String(in.readAllBytes(), StandardCharsets.UTF_8); }
        File marker = new File(root, ".bundle-version");
        if (marker.exists() && read(marker).equals(version)) return;
        try (ZipInputStream zip = new ZipInputStream(new BufferedInputStream(context.getAssets().open("bot.zip")))) {
            ZipEntry entry;
            while ((entry = zip.getNextEntry()) != null) {
                File target = new File(root, entry.getName());
                if (!target.getCanonicalPath().startsWith(root.getCanonicalPath() + File.separator)) throw new IOException("Unsafe bundle path");
                if (entry.isDirectory()) { target.mkdirs(); continue; }
                target.getParentFile().mkdirs();
                try (OutputStream out = new BufferedOutputStream(new FileOutputStream(target))) { zip.transferTo(out); }
            }
        }
        File config = new File(root, "config.json");
        if (!config.exists()) write(config, read(new File(root, "config.example.json")));
        File env = new File(root, ".env");
        if (!env.exists()) write(env, "MC_USERNAME=\nTELEGRAM_BOT_TOKEN=\nTELEGRAM_OWNER_ID=\n");
        write(marker, version);
    }
    static Properties environment(Context c) throws IOException {
        Properties props = new Properties();
        for (String line : read(new File(root(c), ".env")).split("\\R")) {
            int equal = line.indexOf('=');
            if (equal > 0 && !line.startsWith("#")) {
                String value = line.substring(equal+1);
                if (value.length() >= 2 && value.startsWith("\"") && value.endsWith("\"")) value = value.substring(1,value.length()-1);
                props.setProperty(line.substring(0,equal), value);
            }
        }
        return props;
    }
    static JSONObject config(Context c) throws Exception { return new JSONObject(read(new File(root(c), "config.json"))); }
}
