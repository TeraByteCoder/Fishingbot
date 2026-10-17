package org.fishingbot.android;

import java.io.IOException;
import java.io.ByteArrayOutputStream;
import java.io.DataOutputStream;
import java.nio.charset.StandardCharsets;
import java.util.*;

final class DnsSrvPacket {
    static byte[] query(String domain) throws IOException {
        ByteArrayOutputStream bytes=new ByteArrayOutputStream(); DataOutputStream out=new DataOutputStream(bytes);
        out.writeShort(new java.security.SecureRandom().nextInt(65536)); out.writeShort(0x0100);
        out.writeShort(1); out.writeShort(0); out.writeShort(0); out.writeShort(0);
        for(String label:domain.split("\\.")) {
            byte[] text=label.getBytes(StandardCharsets.US_ASCII);
            if(text.length<1 || text.length>63) throw new IOException("Invalid DNS label");
            out.writeByte(text.length); out.write(text);
        }
        out.writeByte(0); out.writeShort(33); out.writeShort(1); return bytes.toByteArray();
    }
    static final class Record {
        final String name; final int port, priority;
        Record(String name,int port,int priority) { this.name=name; this.port=port; this.priority=priority; }
    }
    private static int u16(byte[] data,int offset) throws IOException {
        if(offset<0 || offset+2>data.length) throw new IOException("Truncated DNS response");
        return ((data[offset]&255)<<8) | (data[offset+1]&255);
    }
    private static String name(byte[] data,int[] offset) throws IOException {
        int at=offset[0],next=-1,steps=0;
        StringBuilder result=new StringBuilder();
        while(true) {
            if(at<0 || at>=data.length || ++steps>128) throw new IOException("Invalid DNS name");
            int length=data[at++]&255;
            if(length==0) { if(next<0) next=at; break; }
            if((length&192)==192) {
                if(at>=data.length) throw new IOException("Invalid DNS pointer");
                if(next<0) next=at+1;
                at=((length&63)<<8) | (data[at]&255); continue;
            }
            if(length>63 || at+length>data.length) throw new IOException("Invalid DNS label");
            if(result.length()>0) result.append('.');
            result.append(new String(data,at,length,StandardCharsets.US_ASCII)); at+=length;
            if(result.length()>253) throw new IOException("DNS name too long");
        }
        offset[0]=next; return result.toString();
    }
    static List<Record> parse(byte[] data) throws IOException {
        if(data.length<12 || (u16(data,2)&0x820f)!=0x8000) throw new IOException("Invalid DNS response");
        int questions=u16(data,4),answers=u16(data,6); int[] at={12};
        for(int i=0;i<questions;i++) { name(data,at); at[0]+=4; }
        List<Record> records=new ArrayList<>();
        for(int i=0;i<answers;i++) {
            name(data,at); int type=u16(data,at[0]),cls=u16(data,at[0]+2),size=u16(data,at[0]+8); at[0]+=10;
            int end=at[0]+size;
            if(end>data.length) throw new IOException("Truncated DNS record");
            if(type==33 && cls==1 && size>=7) {
                int priority=u16(data,at[0]),port=u16(data,at[0]+4); int[] target={at[0]+6};
                String host=name(data,target);
                if(target[0]>end) throw new IOException("Invalid SRV target");
                if(!host.isBlank() && port>0) records.add(new Record(host,port,priority));
            }
            at[0]=end;
        }
        records.sort(Comparator.comparingInt(record -> record.priority)); return records;
    }
}
