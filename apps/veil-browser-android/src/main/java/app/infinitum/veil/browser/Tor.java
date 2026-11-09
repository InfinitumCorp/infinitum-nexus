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
 * If those stall too (they are widely blocked in Russia), it asks the Tor Project's
 * bridge service for bridges that work in this country (Moat.java) and uses them.
 * Whatever connects is remembered, and the next launch starts with it.
 */
final class Tor {
    interface Listener {
        /** progress 0-100 while connecting, 100 when ready; error is non-null when Tor stopped. */
        void onTorState(int progress, String summary, String error);
    }

    static final Pattern BOOTSTRAP = Pattern.compile("Bootstrapped (\\d+)%(?: \\([^)]*\\))?:? ?(.*)");
    static final long DIRECT_STALL_MS = 20_000;
    static final long BRIDGE_STALL_MS = 120_000;
    static final String PREFS = "tor";
    static final int DIRECT = 0, BUILTIN = 1, ASSIST = 2;
    /** Bridges from Moat older than this are fetched again before use. */
    static final long ASSIST_MAX_AGE_MS = 7L * 24 * 3600 * 1000;

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
    /** DIRECT, BUILTIN or ASSIST (bridges from Moat). */
    volatile int mode;
    private boolean assisted;
    private volatile long lastProgressAt;
    private int attempts;

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

    /** Start Tor the way that last worked here (direct, or bridges). */
    synchronized void start(Context c) {
        app = c.getApplicationContext();
        if (process != null) return;
        attempts = 0;
        assisted = false;
        int last = prefs().getInt("mode", prefs().getBoolean("bridges", false) ? BUILTIN : DIRECT);
        if (last == ASSIST && assistBridges().isEmpty()) last = BUILTIN;
        launch(last);
    }

    /** Bridges Moat gave us, if still fresh. */
    private java.util.List<String> assistBridges() {
        java.util.List<String> out = new java.util.ArrayList<>();
        if (System.currentTimeMillis() - prefs().getLong("assistAt", 0) > ASSIST_MAX_AGE_MS) return out;
        for (String l : prefs().getString("assist", "").split("\n")) if (!l.trim().isEmpty()) out.add(l.trim());
        return out;
    }

    private synchronized void launch(int useMode) {
        mode = useMode;
        boolean useBridges = useMode != DIRECT;
        bridges = useBridges;
        error = null;
        progress = 0;
        summary = useMode == ASSIST ? "Starting with bridges for this network" : useBridges ? "Starting with bridges" : "Starting";
        lastProgressAt = SystemClock.elapsedRealtime();
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
            if (useBridges) conf.append(bridgeConfig(new File(libs, "libLyrebird.so").getAbsolutePath(),
                useMode == ASSIST ? assistBridges() : null));
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
            main.postDelayed(this::checkStall, 2_000);
        } catch (IOException | org.json.JSONException e) {
            process = null;
            fail("Tor couldn't start: " + e.getMessage());
        }
    }

    /**
     * Bridge lines for torrc: the given ones (from Moat), or Tor Browser's built-in
     * bridges: Snowflake first, then WebTunnel/obfs4, then meek.
     */
    private String bridgeConfig(String lyrebird, java.util.List<String> given) throws IOException, org.json.JSONException {
        StringBuilder sb = new StringBuilder("UseBridges 1\n")
            .append("ClientTransportPlugin meek_lite,obfs4,webtunnel,snowflake exec ").append(lyrebird).append('\n');
        if (given != null && !given.isEmpty()) {
            for (String line : given) sb.append("Bridge ").append(line).append('\n');
            return sb.toString();
        }
        JSONObject pt;
        try (InputStream in = app.getAssets().open("tor/pt_config.json")) {
            ByteArrayOutputStream b = new ByteArrayOutputStream();
            byte[] buf = new byte[8192];
            for (int n; (n = in.read(buf)) > 0; ) b.write(buf, 0, n);
            pt = new JSONObject(b.toString("UTF-8"));
        }
        JSONObject all = pt.getJSONObject("bridges");
        for (String kind : new String[]{"snowflake", "webtunnel", "obfs4", "meek"}) {
            JSONArray lines = all.optJSONArray(kind);
            if (lines == null) continue;
            for (int i = 0; i < lines.length(); i++) sb.append("Bridge ").append(lines.getString(i)).append('\n');
        }
        return sb.toString();
    }

    /** No bootstrap progress for a while: switch between direct and bridges. */
    private void checkStall() {
        if (process == null || error != null || progress >= 100) return;
        long limit = bridges ? BRIDGE_STALL_MS : DIRECT_STALL_MS;
        if (SystemClock.elapsedRealtime() - lastProgressAt < limit) {
            main.postDelayed(this::checkStall, 2_000);
            return;
        }
        if (++attempts > 4) {
            stop();
            fail(bridges ? "Tor couldn't connect, even over bridges. This network may block Tor." : "Tor couldn't connect.");
            return;
        }
        if (mode == DIRECT) {
            restart(assistBridges().isEmpty() ? BUILTIN : ASSIST);
        } else if (!assisted) {
            assist();
        } else {
            stop();
            fail("Tor couldn't connect, even over bridges from the Tor Project. This network may block Tor.");
        }
    }

    /** Connection Assist: fetch bridges for this country from Moat, then restart with them. */
    private void assist() {
        assisted = true;
        Process old;
        synchronized (this) { old = process; process = null; }
        if (old != null) old.destroy();
        summary = "Asking the Tor Project for bridges that work here";
        lastProgressAt = SystemClock.elapsedRealtime();
        notifyListener();
        Thread t = new Thread(() -> {
            String lyrebird = new File(app.getApplicationInfo().nativeLibraryDir, "libLyrebird.so").getAbsolutePath();
            try {
                java.util.List<String> got = Moat.fetch(lyrebird, new File(app.getNoBackupFilesDir(), "moat"), country());
                if (got.isEmpty()) throw new IOException("the Tor Project has no bridges for this network");
                prefs().edit().putString("assist", String.join("\n", got)).putLong("assistAt", System.currentTimeMillis()).apply();
                android.util.Log.i("VEIL-Tor", "Connection Assist: " + got.size() + " bridges (" + transports(got) + ")");
                main.post(() -> launch(ASSIST));
            } catch (Exception e) {
                android.util.Log.i("VEIL-Tor", "Connection Assist failed: " + e);
                main.post(() -> {
                    stop();
                    fail("Tor couldn't connect, even over bridges, and VEIL couldn't get new bridges (" + e.getMessage() + ").");
                });
            }
        }, "tor-assist");
        t.setDaemon(true);
        t.start();
    }

    /** Two-letter country of the mobile network or SIM, or null. */
    private String country() {
        try {
            android.telephony.TelephonyManager tm = (android.telephony.TelephonyManager) app.getSystemService(Context.TELEPHONY_SERVICE);
            String c = tm == null ? "" : tm.getNetworkCountryIso();
            if ((c == null || c.isEmpty()) && tm != null) c = tm.getSimCountryIso();
            return c != null && c.matches("[A-Za-z]{2}") ? c.toLowerCase(java.util.Locale.ROOT) : null;
        } catch (RuntimeException e) {
            return null;
        }
    }

    static String transports(java.util.List<String> lines) {
        java.util.TreeSet<String> kinds = new java.util.TreeSet<>();
        for (String l : lines) kinds.add(l.split(" ", 2)[0]);
        return String.join(", ", kinds);
    }

    /** Restart Tor in the given mode. */
    void restart(int useMode) {
        Thread t = new Thread(() -> {
            Process old;
            synchronized (this) { old = process; process = null; }
            if (old != null) {
                old.destroy();
                try { old.waitFor(); } catch (InterruptedException ignored) { }
            }
            main.post(() -> launch(useMode));
        }, "tor-restart");
        t.setDaemon(true);
        t.start();
    }

    private void watch(Process p) {
        try (BufferedReader r = new BufferedReader(new InputStreamReader(p.getInputStream(), StandardCharsets.UTF_8))) {
            String line;
            while ((line = r.readLine()) != null) {
                android.util.Log.i("VEIL-Tor", line); // notice level, SafeLogging on: no destinations
                Matcher m = BOOTSTRAP.matcher(line);
                if (m.find()) {
                    int pct = Integer.parseInt(m.group(1));
                    if (pct > progress) lastProgressAt = SystemClock.elapsedRealtime();
                    progress = pct;
                    summary = m.group(2).trim().isEmpty() ? "Connecting" : m.group(2).trim();
                    if (pct >= 100) prefs().edit().putBoolean("bridges", bridges).putInt("mode", mode).apply();
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

    /** New circuits for new connections (SIGNAL NEWNYM over the cookie-authenticated control port). */
    void newIdentity() {
        if (!ready()) return;
        Thread t = new Thread(() -> {
            try (Socket s = new Socket()) {
                s.connect(new InetSocketAddress(InetAddress.getLoopbackAddress(), controlPort), 3000);
                s.setSoTimeout(5000);
                byte[] cookie = readAll(new File(dir, "control_auth_cookie"));
                OutputStream o = s.getOutputStream();
                o.write(("AUTHENTICATE " + hex(cookie) + "\r\nSIGNAL NEWNYM\r\nQUIT\r\n").getBytes(StandardCharsets.US_ASCII));
                o.flush();
                BufferedReader r = new BufferedReader(new InputStreamReader(s.getInputStream(), StandardCharsets.US_ASCII));
                while (r.readLine() != null) { /* 250 OK x3 */ }
            } catch (IOException ignored) {
                // Tor rate-limits NEWNYM; a missed one only means circuits are reused a little longer.
            }
        }, "tor-newnym");
        t.setDaemon(true);
        t.start();
    }

    synchronized void stop() {
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
