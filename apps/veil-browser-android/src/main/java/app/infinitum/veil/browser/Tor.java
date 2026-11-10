package app.infinitum.veil.browser;

import android.content.Context;
import android.content.SharedPreferences;
import android.os.Handler;
import android.os.Looper;
import android.os.SystemClock;
import java.io.BufferedReader;
import java.io.ByteArrayOutputStream;
import java.io.File;
import java.io.FileInputStream;
import java.io.FileOutputStream;
import java.io.IOException;
import java.io.InputStream;
import java.io.InputStreamReader;
import java.io.OutputStream;
import java.net.InetAddress;
import java.net.InetSocketAddress;
import java.net.ServerSocket;
import java.net.Socket;
import java.nio.charset.StandardCharsets;
import java.util.regex.Matcher;
import java.util.regex.Pattern;
import org.json.JSONArray;
import org.json.JSONObject;

/**
 * Tor, built in. Runs the Tor Project's own Android build of tor (lib/<abi>/libTor.so,
 * from the Tor Browser expert bundle) as a child process with a SOCKS port that only
 * this app's WebViews are pointed at. Tor exits by itself if VEIL's process dies
 * (__OwningControllerProcess).
 *
 * Where Tor is blocked, VEIL switches to bridges by itself, like Tor Browser's
 * Connection Assist: if a direct start makes no progress for DIRECT_STALL_MS it
 * restarts with Tor Browser's built-in Snowflake, WebTunnel/obfs4 and meek bridges
 * (assets/tor/pt_config.json), carried by lyrebird (lib/<abi>/libLyrebird.so).
 * Once bridges connect, the next launch starts with them.
 */
final class Tor {
    interface Listener {
        /** progress 0-100 while connecting, 100 when ready; error is non-null when Tor stopped. */
        void onTorState(int progress, String summary, String error);
    }

    static final Pattern BOOTSTRAP = Pattern.compile("Bootstrapped (\\d+)%(?: \\([^)]*\\))?:? ?(.*)");
    static final long DIRECT_STALL_MS = 20_000;
    /** A bridge type that hasn't completed a handshake by now is blocked here: try the next type. */
    static final long BRIDGE_CONNECT_MS = 60_000;
    /**
     * Bridges still short of CONN_DONE (10%) by now can't be reached at all: obfs4 bridges this
     * network blocks fail within a second ("general SOCKS server failure") and keep retrying.
     */
    static final long BRIDGE_UNREACHABLE_MS = 20_000;
    /** Bootstrap % once tor reached a bridge or relay (for snowflake/meek, the transport). */
    static final int CONN_DONE = 10;
    /** After a handshake, no progress and no data for this long counts as a stall. */
    static final long BRIDGE_STALL_MS = 120_000;
    /**
     * Bridge types, tried one at a time like Tor Browser: with all of them in one torrc, tor
     * settles on whichever bridge answers first (often a blocked obfs4 one) and sits at 10%.
     */
    static final String[] TRANSPORTS = {"snowflake", "meek", "webtunnel", "obfs4"};
    /** Bootstrap % at which a relay or bridge has completed a handshake: this way works here. */
    static final int HANDSHAKE_DONE = 15;
    /** Bytes Tor must read between stall checks to count as still downloading. */
    static final long TRAFFIC_PROGRESS_BYTES = 16 * 1024;
    static final long TRAFFIC_POLL_MS = 5_000;
    static final String PREFS = "tor";

    private static Tor instance;

    static synchronized Tor get() {
        if (instance == null) instance = new Tor();
        return instance;
    }

    final int socksPort = freePort();
    final int controlPort = freePort();
    private final Handler main = new Handler(Looper.getMainLooper());
    private volatile Process process;
    private Context app;
    private File dir;
    private Listener listener;
    volatile int progress = 0;
    volatile String summary = "Starting";
    volatile String error;
    /** True while running over bridges. */
    volatile boolean bridges;
    /** The bridge type in use (one of TRANSPORTS), or null when direct. */
    volatile String transport;
    private volatile long lastProgressAt;
    /** True once this connection attempt got past a handshake: keep that way from then on. */
    private volatile boolean pathWorks;
    /** True once a direct start stalled during this attempt: the network blocks Tor, stay on bridges. */
    private boolean directBlocked;
    /** Restarts before VEIL gives up and shows "Tor ✕": two rounds of every way. */
    static final int MAX_ATTEMPTS = 8;
    private long trafficSeen;
    private int attempts;
    /** Bumped by every start, restart and stop; stale relaunches and stall checks compare against it. */
    private int gen;
    /** True between a restart's kill and its relaunch, when process is briefly null. */
    private boolean restarting;

    boolean ready() {
        return process != null && error == null && progress >= 100;
    }

    void setListener(Listener l) {
        listener = l;
        notifyListener();
    }

    private SharedPreferences prefs() {
        return app.getSharedPreferences(PREFS, Context.MODE_PRIVATE);
    }

    /** Start Tor the way that last worked here (direct, or a bridge type). */
    synchronized void start(Context c) {
        app = c.getApplicationContext();
        if (process != null || restarting) return;
        attempts = 0;
        pathWorks = false;
        directBlocked = false;
        java.util.List<String> avail = available();
        String saved = prefs().getString("transport", null);
        if (saved == null && prefs().getBoolean("bridges", false) && !avail.isEmpty()) saved = avail.get(0);
        if (saved != null && !avail.contains(saved)) saved = avail.isEmpty() ? null : avail.get(0);
        android.util.Log.i("VEIL-Tor", "VEIL: start (gen " + (gen + 1) + ")");
        launch(saved, ++gen);
    }

    /** Starts tor directly (kind == null) or over one bridge type. */
    private synchronized void launch(String kind, int g) {
        if (g != gen) return; // stopped or superseded while a restart was waiting
        restarting = false;
        android.util.Log.i("VEIL-Tor", "VEIL: launch gen " + g + (kind == null ? " direct" : " with " + kind + " bridges"));
        bridges = kind != null;
        transport = kind;
        error = null;
        progress = 0;
        summary = kind == null ? "Starting" : "Starting with " + label(kind) + " bridges";
        lastProgressAt = SystemClock.elapsedRealtime();
        trafficSeen = 0;
        notifyListener();
        try {
            dir = new File(app.getNoBackupFilesDir(), "tor");
            if (!dir.isDirectory() && !dir.mkdirs()) throw new IOException("can't create " + dir);
            String libs = app.getApplicationInfo().nativeLibraryDir;
            StringBuilder conf = new StringBuilder()
                .append("DataDirectory ").append(dir.getAbsolutePath()).append('\n')
                .append("SocksPort 127.0.0.1:").append(socksPort).append('\n')
                .append("ControlPort 127.0.0.1:").append(controlPort).append('\n')
                .append("CookieAuthentication 1\n")
                .append("CookieAuthFile ").append(new File(dir, "control_auth_cookie").getAbsolutePath()).append('\n')
                .append("__OwningControllerProcess ").append(android.os.Process.myPid()).append('\n')
                .append("ClientOnly 1\n")
                .append("AvoidDiskWrites 1\n")
                .append("Log notice stdout\n");
            if (kind != null) conf.append(bridgeConfig(new File(libs, "libLyrebird.so").getAbsolutePath(), kind));
            File torrc = new File(dir, "torrc");
            try (OutputStream o = new FileOutputStream(torrc)) {
                o.write(conf.toString().getBytes(StandardCharsets.UTF_8));
            }
            ProcessBuilder pb = new ProcessBuilder(new File(libs, "libTor.so").getAbsolutePath(),
                "-f", torrc.getAbsolutePath(), "--defaults-torrc", new File(dir, "torrc-defaults").getAbsolutePath(),
                "--ignore-missing-torrc");
            pb.directory(dir);
            pb.redirectErrorStream(true);
            Process p = pb.start();
            process = p;
            Thread t = new Thread(() -> watch(p), "tor-log");
            t.setDaemon(true);
            t.start();
            main.postDelayed(() -> checkStall(g), 2_000);
            Thread poll = new Thread(() -> pollTraffic(g), "tor-traffic");
            poll.setDaemon(true);
            poll.start();
        } catch (IOException | org.json.JSONException e) {
            process = null;
            fail("Tor couldn't start: " + e.getMessage());
        }
    }

    private JSONObject ptConfig;

    /** Tor Browser's built-in bridges (assets/tor/pt_config.json). */
    private synchronized JSONObject ptConfig() throws IOException, org.json.JSONException {
        if (ptConfig == null) {
            try (InputStream in = app.getAssets().open("tor/pt_config.json")) {
                ByteArrayOutputStream b = new ByteArrayOutputStream();
                byte[] buf = new byte[8192];
                for (int n; (n = in.read(buf)) > 0; ) b.write(buf, 0, n);
                ptConfig = new JSONObject(b.toString("UTF-8"));
            }
        }
        return ptConfig;
    }

    /** The bridge types this build has bridges for, in TRANSPORTS order. */
    java.util.List<String> available() {
        java.util.List<String> out = new java.util.ArrayList<>();
        try {
            JSONObject all = ptConfig().getJSONObject("bridges");
            for (String kind : TRANSPORTS) {
                JSONArray lines = all.optJSONArray(kind);
                if (lines != null && lines.length() > 0) out.add(kind);
            }
        } catch (IOException | org.json.JSONException ignored) {
            // no bridges in this build: direct only
        }
        return out;
    }

    /** torrc lines for one bridge type, carried by lyrebird. */
    private String bridgeConfig(String lyrebird, String kind) throws IOException, org.json.JSONException {
        StringBuilder sb = new StringBuilder("UseBridges 1\n")
            .append("ClientTransportPlugin meek_lite,obfs4,webtunnel,snowflake exec ").append(lyrebird).append('\n');
        JSONArray lines = ptConfig().getJSONObject("bridges").getJSONArray(kind);
        for (int i = 0; i < lines.length(); i++) sb.append("Bridge ").append(lines.getString(i)).append('\n');
        return sb.toString();
    }

    static String label(String kind) {
        switch (kind) {
            case "snowflake": return "Snowflake";
            case "webtunnel": return "WebTunnel";
            default: return kind;
        }
    }

    /** How long the current way may go without progress before VEIL tries the next one. */
    static long stallLimit(boolean pathWorks, boolean bridges, int progress) {
        if (pathWorks) return BRIDGE_STALL_MS;
        if (!bridges) return DIRECT_STALL_MS;
        return progress < CONN_DONE ? BRIDGE_UNREACHABLE_MS : BRIDGE_CONNECT_MS;
    }

    /**
     * No progress for a while: try the next way. Progress means a higher bootstrap % or data
     * still arriving (see pollTraffic): over meek the consensus download sits at 25% for
     * minutes while bytes flow, and must not be cut off.
     */
    private synchronized void checkStall(int g) {
        if (g != gen || process == null || error != null || progress >= 100) return;
        long limit = stallLimit(pathWorks, bridges, progress);
        if (SystemClock.elapsedRealtime() - lastProgressAt < limit) {
            main.postDelayed(() -> checkStall(g), 2_000);
            return;
        }
        android.util.Log.i("VEIL-Tor", "VEIL: no progress for " + (limit / 1000) + " s " + (bridges ? "over " + transport + " bridges" : "direct") + " at " + progress + "%, attempt " + (attempts + 1));
        if (++attempts > MAX_ATTEMPTS) {
            stop();
            fail(bridges ? "Tor couldn't connect, even over bridges. This network may block Tor." : "Tor couldn't connect.");
            return;
        }
        java.util.List<String> avail = available();
        if (!bridges && !pathWorks) {
            // A direct start that stalls (typically at 10%) means this network blocks Tor:
            // don't try direct again this time, and start with bridges next time.
            directBlocked = true;
            if (!avail.isEmpty()) prefs().edit().putBoolean("bridges", true).putString("transport", avail.get(0)).apply();
        }
        restart(next(transport, pathWorks, directBlocked, avail));
    }

    /**
     * The way to try after a stall. A way that got past a handshake works on this network,
     * so retry it. Otherwise go down the bridge types; after the last, direct again unless
     * direct already stalled, in which case start the bridge types over.
     */
    static String next(String current, boolean pathWorks, boolean directBlocked, java.util.List<String> available) {
        if (pathWorks) return current;
        if (available.isEmpty()) return null;
        if (current == null) return available.get(0);
        int i = available.indexOf(current);
        if (i >= 0 && i + 1 < available.size()) return available.get(i + 1);
        return directBlocked ? available.get(0) : null;
    }

    /** Counts bytes Tor reads (GETINFO traffic/read); steady downloading counts as progress. */
    private void pollTraffic(int g) {
        while (true) {
            try { Thread.sleep(TRAFFIC_POLL_MS); } catch (InterruptedException e) { return; }
            synchronized (this) {
                if (g != gen || process == null || progress >= 100) return;
            }
            String v = control("GETINFO traffic/read", "250-traffic/read=");
            if (v == null) continue;
            long read;
            try { read = Long.parseLong(v.trim()); } catch (NumberFormatException e) { continue; }
            synchronized (this) {
                if (g != gen) return;
                if (read - trafficSeen >= TRAFFIC_PROGRESS_BYTES) {
                    trafficSeen = read;
                    lastProgressAt = SystemClock.elapsedRealtime();
                }
            }
        }
    }

    /**
     * Sends one command over the cookie-authenticated control port and returns the rest of
     * the first reply line that starts with prefix, or null.
     */
    private String control(String command, String prefix) {
        try (Socket s = new Socket()) {
            s.connect(new InetSocketAddress(InetAddress.getLoopbackAddress(), controlPort), 3000);
            s.setSoTimeout(5000);
            byte[] cookie = readAll(new File(dir, "control_auth_cookie"));
            OutputStream o = s.getOutputStream();
            o.write(("AUTHENTICATE " + hex(cookie) + "\r\n" + command + "\r\nQUIT\r\n").getBytes(StandardCharsets.US_ASCII));
            o.flush();
            BufferedReader r = new BufferedReader(new InputStreamReader(s.getInputStream(), StandardCharsets.US_ASCII));
            String found = null;
            for (String line; (line = r.readLine()) != null; ) {
                if (found == null && line.startsWith(prefix)) found = line.substring(prefix.length());
            }
            return found;
        } catch (IOException e) {
            return null; // control port not up yet, or tor restarting
        }
    }

    /**
     * Restart Tor, over bridges or direct. The old tor must be gone before the new one
     * binds the same SOCKS and control ports, so the wait happens off the main thread.
     */
    private synchronized void restart(String kind) {
        int g = ++gen;
        Process old = process;
        process = null;
        restarting = true;
        progress = 0;
        summary = kind == null ? "Trying a direct connection" : "Trying " + label(kind) + " bridges";
        notifyListener();
        Thread t = new Thread(() -> {
            if (old != null) {
                old.destroy();
                try { old.waitFor(); } catch (InterruptedException ignored) { }
            }
            main.post(() -> launch(kind, g));
        }, "tor-restart");
        t.setDaemon(true);
        t.start();
    }

    private void watch(Process p) {
        try (BufferedReader r = new BufferedReader(new InputStreamReader(p.getInputStream(), StandardCharsets.UTF_8))) {
            String line;
            while ((line = r.readLine()) != null) {
                android.util.Log.i("VEIL-Tor", line); // notice level, SafeLogging on: no destinations
                if (process != p) continue; // a replaced tor still flushing its log: don't touch the new one's state
                Matcher m = BOOTSTRAP.matcher(line);
                if (m.find()) {
                    int pct = Integer.parseInt(m.group(1));
                    if (pct > progress) lastProgressAt = SystemClock.elapsedRealtime();
                    progress = pct;
                    summary = m.group(2).trim().isEmpty() ? "Connecting" : m.group(2).trim();
                    if (pct >= HANDSHAKE_DONE && !pathWorks) {
                        // Remember the way that reached a relay now, not only at 100%, so the
                        // next launch skips a direct start that stalls at 10% here.
                        pathWorks = true;
                        prefs().edit().putBoolean("bridges", bridges).putString("transport", transport).apply();
                    }
                    notifyListener();
                } else if (line.contains("[err]")) {
                    summary = line.substring(line.indexOf("[err]") + 5).trim();
                }
            }
        } catch (IOException ignored) {
            // stream closed: the process is gone
        }
        int code;
        try { code = p.waitFor(); } catch (InterruptedException e) { code = -1; }
        synchronized (this) {
            if (process == p) {
                process = null;
                fail("Tor stopped (" + code + "): " + summary);
            }
        }
    }

    private void fail(String why) {
        error = why;
        notifyListener();
    }

    private void notifyListener() {
        main.post(() -> {
            if (listener != null) listener.onTorState(progress, summary, error);
        });
    }

    /** The Tor Project's check API: answers whether a request arrived from a Tor exit. */
    static final String CHECK_API = "https://check.torproject.org/api/ip";

    interface CheckResult {
        /** isTor is null when the check couldn't be completed. */
        void onResult(Boolean isTor, String ip);
    }

    /**
     * Confirms in the background that traffic leaves through Tor, without opening a page:
     * asks CHECK_API over this tor's SOCKS port (the host name resolves inside Tor too).
     */
    void verify(CheckResult cb) {
        Thread t = new Thread(() -> {
            Boolean isTor = null;
            String ip = null;
            java.net.HttpURLConnection c = null;
            try {
                java.net.Proxy socks = new java.net.Proxy(java.net.Proxy.Type.SOCKS,
                    InetSocketAddress.createUnresolved("127.0.0.1", socksPort));
                c = (java.net.HttpURLConnection) new java.net.URL(CHECK_API).openConnection(socks);
                c.setConnectTimeout(30_000);
                c.setReadTimeout(30_000);
                c.setUseCaches(false);
                c.setRequestProperty("Accept", "application/json");
                try (InputStream in = c.getInputStream()) {
                    ByteArrayOutputStream b = new ByteArrayOutputStream();
                    byte[] buf = new byte[4096];
                    for (int n; (n = in.read(buf)) > 0; ) b.write(buf, 0, n);
                    JSONObject o = new JSONObject(b.toString("UTF-8"));
                    isTor = o.optBoolean("IsTor", false);
                    ip = o.optString("IP", null);
                }
            } catch (IOException | org.json.JSONException e) {
                android.util.Log.i("VEIL-Tor", "VEIL: Tor check failed: " + e.getClass().getSimpleName());
            } finally {
                if (c != null) c.disconnect();
            }
            Boolean r = isTor;
            String a = ip;
            main.post(() -> cb.onResult(r, a));
        }, "tor-check");
        t.setDaemon(true);
        t.start();
    }

    /** New circuits for new connections (SIGNAL NEWNYM over the cookie-authenticated control port). */
    void newIdentity() {
        if (!ready()) return;
        // Tor rate-limits NEWNYM; a missed one only means circuits are reused a little longer.
        Thread t = new Thread(() -> control("SIGNAL NEWNYM", "250"), "tor-newnym");
        t.setDaemon(true);
        t.start();
    }

    synchronized void stop() {
        gen++;
        restarting = false;
        if (process != null) {
            Process p = process;
            process = null;
            p.destroy();
        }
    }

    static int freePort() {
        try (ServerSocket s = new ServerSocket(0, 1, InetAddress.getLoopbackAddress())) {
            return s.getLocalPort();
        } catch (IOException e) {
            return 9150;
        }
    }

    static byte[] readAll(File f) throws IOException {
        try (InputStream in = new FileInputStream(f)) {
            byte[] b = new byte[(int) f.length()];
            int n = 0;
            while (n < b.length) {
                int k = in.read(b, n, b.length - n);
                if (k < 0) break;
                n += k;
            }
            return b;
        }
    }

    static String hex(byte[] b) {
        StringBuilder sb = new StringBuilder(b.length * 2);
        for (byte x : b) sb.append(String.format("%02x", x & 0xff));
        return sb.toString();
    }
}
