package app.infinitum.veil.browser;

import java.io.BufferedReader;
import java.io.ByteArrayOutputStream;
import java.io.DataInputStream;
import java.io.File;
import java.io.IOException;
import java.io.InputStream;
import java.io.InputStreamReader;
import java.io.OutputStream;
import java.net.InetAddress;
import java.net.InetSocketAddress;
import java.net.Socket;
import java.nio.charset.StandardCharsets;
import java.util.ArrayList;
import java.util.List;
import java.util.Map;
import javax.net.ssl.HttpsURLConnection;
import javax.net.ssl.SSLSocket;
import javax.net.ssl.SSLSocketFactory;

/**
 * Connection Assist: asks the Tor Project's bridge service (Moat) for bridges that
 * work in this country, the way Tor Browser does when its built-in bridges are blocked.
 *
 * Moat is reached by domain fronting: lyrebird's meek_lite client carries the request
 * to a reflector behind a CDN, and the network only sees a TLS connection to the front
 * domain. Inside that tunnel VEIL opens its own TLS session to bridges.torproject.org
 * and checks its certificate, so the reflector only relays ciphertext.
 * Endpoints are Tor Browser's defaults (extensions.torlauncher.bridgedb_*).
 * Protocol: https://gitlab.torproject.org/tpo/anti-censorship/rdsys/-/blob/main/doc/moat.md
 */
final class Moat {
    static final String REFLECTOR = "https://bespoke-strudel-c243cc.netlify.app";
    static final String FRONT = "vuejs.org";
    static final String HOST = "bridges.torproject.org";
    static final String PATH = "/moat/circumvention/settings";
    static final String[] TRANSPORTS = {"obfs4", "webtunnel", "snowflake", "meek_lite"};
    static final int TIMEOUT_MS = 60_000;

    private Moat() { }

    /** meek args packed into SOCKS5 username/password, as pt-spec and Tor Browser do it. */
    static String[] credentials(String reflector, String front) {
        String args = "url=" + escape(reflector) + ";front=" + escape(front);
        if (args.length() <= 255) return new String[]{args, "\0"};
        return new String[]{args.substring(0, 255), args.substring(255)};
    }

    static String escape(String v) {
        return v.replace("\\", "\\\\").replace(";", "\\;").replace("=", "\\=");
    }

    /** Request body. country is a two-letter code, or null to let Moat detect it. */
    static String body(String country) {
        StringBuilder sb = new StringBuilder("{\"transports\":[");
        for (int i = 0; i < TRANSPORTS.length; i++) sb.append(i == 0 ? "" : ",").append('"').append(TRANSPORTS[i]).append('"');
        sb.append(']');
        if (country != null && country.matches("[a-z]{2}")) sb.append(",\"country\":\"").append(country).append('"');
        return sb.append('}').toString();
    }

    /** Bridge lines from a Moat settings response; empty when Moat has none for us. */
    static List<String> parse(String json) throws org.json.JSONException, IOException {
        org.json.JSONObject o = new org.json.JSONObject(json);
        org.json.JSONArray errors = o.optJSONArray("errors");
        if (errors != null && errors.length() > 0) {
            org.json.JSONObject e = errors.getJSONObject(0);
            throw new MoatError(e.optInt("code"), e.optString("detail", "Moat error"));
        }
        List<String> out = new ArrayList<>();
        org.json.JSONArray settings = o.optJSONArray("settings");
        for (int i = 0; settings != null && i < settings.length(); i++) {
            org.json.JSONObject b = settings.getJSONObject(i).optJSONObject("bridges");
            org.json.JSONArray lines = b == null ? null : b.optJSONArray("bridge_strings");
            for (int j = 0; lines != null && j < lines.length(); j++) {
                String line = lines.getString(j).trim();
                if (line.matches("(obfs4|webtunnel|snowflake|meek_lite) \\S.*")) out.add(line);
            }
        }
        return out;
    }

    static final class MoatError extends IOException {
        final int code;
        MoatError(int code, String detail) { super(detail + " (" + code + ")"); this.code = code; }
    }

    /**
     * Fetches bridges over meek. Blocking; call off the main thread.
     * Tries without a country first (Moat detects it), then with the phone's own country.
     */
    static List<String> fetch(String lyrebird, File stateDir, String fallbackCountry) throws Exception {
        Process pt = startMeek(lyrebird, stateDir);
        try {
            InetSocketAddress port = socksAddress(pt);
            try {
                return parse(post(port, body(null)));
            } catch (MoatError e) {
                if (fallbackCountry == null) throw e;
                return parse(post(port, body(fallbackCountry)));
            }
        } finally {
            pt.destroy();
        }
    }

    private static Process startMeek(String lyrebird, File stateDir) throws IOException {
        if (!stateDir.isDirectory() && !stateDir.mkdirs()) throw new IOException("can't create " + stateDir);
        ProcessBuilder pb = new ProcessBuilder(lyrebird);
        Map<String, String> env = pb.environment();
        env.put("TOR_PT_MANAGED_TRANSPORT_VER", "1");
        env.put("TOR_PT_STATE_LOCATION", stateDir.getAbsolutePath());
        env.put("TOR_PT_EXIT_ON_STDIN_CLOSE", "1");
        env.put("TOR_PT_CLIENT_TRANSPORTS", "meek_lite");
        pb.redirectErrorStream(false);
        Process p = pb.start();
        Thread drain = new Thread(() -> {
            try (BufferedReader err = new BufferedReader(new InputStreamReader(p.getErrorStream(), StandardCharsets.UTF_8))) {
                for (String line; (line = err.readLine()) != null; ) log("lyrebird: " + line);
            } catch (IOException ignored) { }
        }, "moat-stderr");
        drain.setDaemon(true);
        drain.start();
        return p;
    }

    /** Reads lyrebird's managed-proxy handshake: CMETHOD meek_lite socks5 127.0.0.1:PORT. */
    static InetSocketAddress socksAddress(Process pt) throws IOException {
        BufferedReader r = new BufferedReader(new InputStreamReader(pt.getInputStream(), StandardCharsets.UTF_8));
        InetSocketAddress port = null;
        for (String line; (line = r.readLine()) != null; ) {
            if (line.startsWith("CMETHOD meek_lite socks5 ")) {
                port = parseAddress(line.substring("CMETHOD meek_lite socks5 ".length()).trim());
            } else if (line.startsWith("CMETHOD-ERROR") || line.startsWith("ENV-ERROR") || line.startsWith("VERSION-ERROR")) {
                throw new IOException("lyrebird: " + line);
            } else if (line.startsWith("CMETHODS DONE")) {
                break;
            }
        }
        if (port == null) throw new IOException("lyrebird gave no meek_lite port");
        return port;
    }

    /** "127.0.0.1:PORT" or "[::1]:PORT"; only loopback addresses are accepted. */
    static InetSocketAddress parseAddress(String addr) throws IOException {
        int colon = addr.lastIndexOf(':');
        if (colon < 1) throw new IOException("bad proxy address " + addr);
        String host = addr.substring(0, colon).replace("[", "").replace("]", "");
        InetAddress ip = InetAddress.getByName(host);
        if (!ip.isLoopbackAddress() || !host.matches("[0-9.:a-fA-F]+")) throw new IOException("proxy is not on loopback: " + addr);
        return new InetSocketAddress(ip, Integer.parseInt(addr.substring(colon + 1)));
    }

    private static String post(InetSocketAddress socks, String body) throws IOException {
        Socket raw = new Socket();
        raw.connect(socks, 10_000);
        raw.setSoTimeout(TIMEOUT_MS);
        try {
            log("Moat: meek tunnel via " + FRONT);
            socks5Connect(raw, credentials(REFLECTOR, FRONT), HOST, 443);
            log("Moat: tunnel open, TLS to " + HOST);
            SSLSocket tls = (SSLSocket) ((SSLSocketFactory) SSLSocketFactory.getDefault()).createSocket(raw, HOST, 443, true);
            tls.startHandshake();
            log("Moat: TLS ok, sending request");
            if (!HttpsURLConnection.getDefaultHostnameVerifier().verify(HOST, tls.getSession())) {
                throw new IOException("Moat certificate is not for " + HOST);
            }
            byte[] payload = body.getBytes(StandardCharsets.UTF_8);
            OutputStream o = tls.getOutputStream();
            o.write(("POST " + PATH + " HTTP/1.0\r\nHost: " + HOST + "\r\nContent-Type: application/vnd.api+json\r\n"
                + "Content-Length: " + payload.length + "\r\nConnection: close\r\n\r\n").getBytes(StandardCharsets.US_ASCII));
            o.write(payload);
            o.flush();
            String response = readAll(tls.getInputStream());
            int split = response.indexOf("\r\n\r\n");
            if (!response.startsWith("HTTP/1.") || split < 0) throw new IOException("Moat sent no HTTP response");
            String status = response.substring(0, response.indexOf("\r\n"));
            String json = response.substring(split + 4);
            if (!status.matches("HTTP/1\\.[01] 200.*") && !json.trim().startsWith("{")) throw new IOException("Moat: " + status);
            return json;
        } finally {
            raw.close();
        }
    }

    /** SOCKS5 CONNECT with username/password auth (RFC 1928, RFC 1929), host name resolved by the proxy. */
    static void socks5Connect(Socket s, String[] userPass, String host, int port) throws IOException {
        OutputStream o = s.getOutputStream();
        DataInputStream in = new DataInputStream(s.getInputStream());
        o.write(new byte[]{5, 1, 2});
        o.flush();
        if (in.readUnsignedByte() != 5 || in.readUnsignedByte() != 2) throw new IOException("SOCKS: auth refused");
        byte[] u = userPass[0].getBytes(StandardCharsets.UTF_8);
        byte[] p = userPass[1].getBytes(StandardCharsets.UTF_8);
        ByteArrayOutputStream auth = new ByteArrayOutputStream();
        auth.write(1);
        auth.write(u.length);
        auth.write(u, 0, u.length);
        auth.write(p.length);
        auth.write(p, 0, p.length);
        o.write(auth.toByteArray());
        o.flush();
        in.readUnsignedByte();
        if (in.readUnsignedByte() != 0) throw new IOException("SOCKS: login refused");
        byte[] h = host.getBytes(StandardCharsets.US_ASCII);
        ByteArrayOutputStream req = new ByteArrayOutputStream();
        req.write(new byte[]{5, 1, 0, 3, (byte) h.length}, 0, 5);
        req.write(h, 0, h.length);
        req.write(port >> 8);
        req.write(port & 0xff);
        o.write(req.toByteArray());
        o.flush();
        if (in.readUnsignedByte() != 5) throw new IOException("SOCKS: bad reply");
        int rep = in.readUnsignedByte();
        if (rep != 0) throw new IOException("SOCKS: connect failed (" + rep + ")");
        in.readUnsignedByte();
        int atyp = in.readUnsignedByte();
        int skip = atyp == 1 ? 4 : atyp == 4 ? 16 : atyp == 3 ? in.readUnsignedByte() : -1;
        if (skip < 0) throw new IOException("SOCKS: bad address type");
        in.readFully(new byte[skip + 2]);
    }

    /** Progress lines in logcat under VEIL-Tor (no addresses beyond the fixed Moat endpoints). */
    static void log(String line) {
        try {
            android.util.Log.i("VEIL-Tor", line);
        } catch (RuntimeException | LinkageError ignored) {
            // JVM unit tests: no android.util.Log
        }
    }

    private static String readAll(InputStream in) throws IOException {
        ByteArrayOutputStream b = new ByteArrayOutputStream();
        byte[] buf = new byte[8192];
        for (int n; (n = in.read(buf)) > 0; ) {
            b.write(buf, 0, n);
            if (b.size() > 1_000_000) throw new IOException("Moat response too large");
        }
        return b.toString("UTF-8");
    }
}
