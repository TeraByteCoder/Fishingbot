package org.fishingbot.android;

import org.junit.Test;
import static org.junit.Assert.*;
import java.io.*;
import java.nio.charset.StandardCharsets;
import java.util.*;

public class DnsSrvPacketTest {
    private byte[] packet() throws Exception {
        ByteArrayOutputStream bytes=new ByteArrayOutputStream(); DataOutputStream out=new DataOutputStream(bytes);
        out.writeShort(1); out.writeShort(0x8180); out.writeShort(1); out.writeShort(1); out.writeShort(0); out.writeShort(0);
        for(String label:new String[]{"_minecraft","_tcp","example","test"}) { out.writeByte(label.length()); out.write(label.getBytes(StandardCharsets.US_ASCII)); }
        out.writeByte(0); out.writeShort(33); out.writeShort(1);
        out.writeShort(0xc00c); out.writeShort(33); out.writeShort(1); out.writeInt(60); out.writeShort(13);
        out.writeShort(0); out.writeShort(5); out.writeShort(25565);
        out.writeByte(4); out.writeBytes("play"); out.writeShort(0xc01c);
        return bytes.toByteArray();
    }
    @Test public void parsesCompressedSrvNames() throws Exception {
        List<DnsSrvPacket.Record> records=DnsSrvPacket.parse(packet());
        assertEquals(1,records.size()); assertEquals("play.example.test",records.get(0).name); assertEquals(25565,records.get(0).port);
    }
    @Test public void rejectsTruncatedResponses() throws Exception {
        byte[] valid=packet();
        for(int size:new int[]{0,5,12,valid.length-1}) {
            try { DnsSrvPacket.parse(Arrays.copyOf(valid,size)); fail("Accepted truncated response"); } catch(IOException expected) { }
        }
    }
    @Test public void rejectsCompressionPointerLoops() throws Exception {
        byte[] bytes=packet(); bytes[12]=(byte)0xc0; bytes[13]=12;
        try { DnsSrvPacket.parse(bytes); fail("Accepted DNS pointer loop"); } catch(IOException expected) { }
    }
}
