package org.fishingbot.android;

import android.content.Context;
import org.json.JSONObject;
import java.io.*;
import java.net.*;
import java.nio.charset.StandardCharsets;

final class BridgeClient {
    static JSONObject request(Context c, String command) throws Exception {
        JSONObject address = new JSONObject(RuntimeFiles.read(new File(RuntimeFiles.root(c), "mobile-bridge.json")));
        int port = address.getInt("port");
        if (port < 1 || port > 65535) throw new IOException("Invalid local port");
        URL url = new URL("http://127.0.0.1:" + port + (command == null ? "/snapshot" : "/command"));
        HttpURLConnection connection = (HttpURLConnection)url.openConnection();
        connection.setConnectTimeout(1500);
        connection.setReadTimeout(2500);
        connection.setRequestProperty("Authorization", "Bearer " + address.getString("token"));
        try {
            if (command != null) {
                connection.setRequestMethod("POST"); connection.setDoOutput(true);
                connection.setRequestProperty("Content-Type", "application/json");
                byte[] body = new JSONObject().put("command",command).toString().getBytes(StandardCharsets.UTF_8);
                try (OutputStream out = connection.getOutputStream()) { out.write(body); }
            }
            if (connection.getResponseCode() != 200) throw new IOException("Local command rejected");
            try (InputStream in = connection.getInputStream()) { return new JSONObject(new String(in.readAllBytes(), StandardCharsets.UTF_8)); }
        } finally { connection.disconnect(); }
    }
}
