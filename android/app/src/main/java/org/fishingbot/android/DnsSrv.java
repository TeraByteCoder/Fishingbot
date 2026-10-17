package org.fishingbot.android;

import android.content.Context;
import android.net.DnsResolver;
import android.os.CancellationSignal;
import org.json.JSONArray;
import org.json.JSONObject;
import java.util.concurrent.*;

final class DnsSrv {
    static String lookup(Context context,String host,int port) {
        if (port != 25565 || host.isBlank() || host.contains(":")) return "";
        CompletableFuture<byte[]> result = new CompletableFuture<>();
        CancellationSignal cancel = new CancellationSignal();
        try {
            DnsResolver.getInstance().rawQuery(null,DnsSrvPacket.query("_minecraft._tcp."+host),DnsResolver.FLAG_EMPTY,context.getMainExecutor(),cancel,new DnsResolver.Callback<byte[]>() {
                @Override public void onAnswer(byte[] answer,int rcode) { result.complete(answer); }
                @Override public void onError(DnsResolver.DnsException error) { result.completeExceptionally(error); }
            });
            JSONArray records = new JSONArray();
            for (DnsSrvPacket.Record record : DnsSrvPacket.parse(result.get(8,TimeUnit.SECONDS))) {
                records.put(new JSONObject().put("name",record.name).put("port",record.port));
            }
            return new JSONObject().put("source",host).put("records",records).toString();
        } catch(Exception error) { return ""; }
        finally { cancel.cancel(); }
    }
}
