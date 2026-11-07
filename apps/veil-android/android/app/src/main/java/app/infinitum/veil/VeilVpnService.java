package app.infinitum.veil;

import android.app.Notification;
import android.app.NotificationChannel;
import android.app.NotificationManager;
import android.content.Intent;
import android.net.VpnService;
import android.os.Binder;
import android.os.Build;
import android.os.Handler;
import android.os.IBinder;
import android.os.Looper;
import android.os.ParcelFileDescriptor;

import java.util.Locale;

import app.infinitum.veil.mobile.Mobile;
import app.infinitum.veil.mobile.Protector;

/**
 * Device-wide tunnel. establish() is necessary and not sufficient: wireguard-go
 * must own the TUN fd, and protect() must accept the UDP socket. Failure closes
 * the interface. This service does not install a DNS server and does not enable
 * always-on lockdown.
 */
public final class VeilVpnService extends VpnService {
    public static final class PeerConfig {
        public final String privateKeyHex;
        public final String peerPublicHex;
        public final String endpoint;
        public final String localCidr;
        public final int keepaliveSeconds;
        public final boolean failIfNoHandshake;
        public final int handshakeWaitMs;
        public final boolean forceProtectFailure;

        public PeerConfig(
                String privateKeyHex,
                String peerPublicHex,
                String endpoint,
                String localCidr,
                int keepaliveSeconds,
                boolean failIfNoHandshake,
                int handshakeWaitMs,
                boolean forceProtectFailure) {
            this.privateKeyHex = privateKeyHex;
            this.peerPublicHex = peerPublicHex;
            this.endpoint = endpoint;
            this.localCidr = localCidr;
            this.keepaliveSeconds = keepaliveSeconds;
            this.failIfNoHandshake = failIfNoHandshake;
            this.handshakeWaitMs = handshakeWaitMs;
            this.forceProtectFailure = forceProtectFailure;
        }
    }

    public final class LocalBinder extends Binder {
        public VeilVpnService getService() {
            return VeilVpnService.this;
        }
    }

    private final IBinder binder = new LocalBinder();
    private final Handler main = new Handler(Looper.getMainLooper());
    private ParcelFileDescriptor tun;
    private String status = "down";
    private String code = "down";
    private int generation;
    private int listenPort;

    @Override
    public IBinder onBind(Intent intent) {
        return binder;
    }

    @Override
    public void onRevoke() {
        disconnect();
        super.onRevoke();
    }

    @Override
    public void onDestroy() {
        disconnect();
        super.onDestroy();
    }

    public String status() {
        return status;
    }

    public String code() {
        return code;
    }

    /** Always false. A public resolver is not installed. */
    public boolean dnsInstalled() {
        return false;
    }

    public int listenPort() {
        return listenPort;
    }

    public synchronized String connect(PeerConfig cfg) {
        if (cfg == null || cfg.endpoint == null || cfg.localCidr == null) {
            code = "bad-endpoint";
            return code;
        }
        String endpoint = cfg.endpoint.trim();
        if (endpoint.toLowerCase(Locale.US).contains("infinitumveilvpn.app")
                || endpoint.contains("://")
                || !endpoint.matches("[0-9]+\\.[0-9]+\\.[0-9]+\\.[0-9]+:[0-9]+")) {
            code = endpoint.toLowerCase(Locale.US).contains("infinitumveilvpn.app")
                    ? "domain-is-not-an-endpoint"
                    : "bad-endpoint";
            return code;
        }
        if ("up".equals(status)) {
            code = "already-up";
            return code;
        }
        String[] cidr = cfg.localCidr.split("/");
        if (cidr.length != 2) {
            code = "bad-endpoint";
            return code;
        }
        int prefix;
        try {
            prefix = Integer.parseInt(cidr[1]);
        } catch (NumberFormatException ex) {
            code = "bad-endpoint";
            return code;
        }
        ensureForeground();
        Builder builder = new Builder();
        builder.setSession("VEIL");
        builder.setMtu(1280);
        builder.setBlocking(true);
        builder.addAddress(cidr[0], prefix);
        builder.addRoute("0.0.0.0", 0);
        builder.addRoute("::", 0);
        ParcelFileDescriptor established = builder.establish();
        if (established == null) {
            code = "establish-failed";
            status = "down";
            return code;
        }
        tun = established;
        final int gen = ++generation;
        try {
            Protector protector = fd -> !cfg.forceProtectFailure && protect((int) fd);
            listenPort = Mobile.start(
                    established.getFd(),
                    cfg.privateKeyHex,
                    cfg.peerPublicHex,
                    endpoint,
                    cfg.localCidr,
                    cfg.keepaliveSeconds,
                    protector);
        } catch (Exception ex) {
            closeTun();
            Mobile.stopClient();
            status = "down";
            String message = ex.getMessage() == null ? "" : ex.getMessage().toLowerCase(Locale.US);
            code = message.contains("protect") ? "protect-failed" : "failed";
            return code;
        }
        status = "up";
        code = "up";
        if (cfg.failIfNoHandshake) {
            int wait = Math.max(cfg.handshakeWaitMs, 1000);
            main.postDelayed(() -> {
                if (gen != generation) {
                    return;
                }
                if (Mobile.clientHandshakeUnix() == 0L) {
                    disconnect();
                    code = "handshake-failed";
                }
            }, wait);
        }
        return code;
    }

    public synchronized void disconnect() {
        generation++;
        Mobile.stopClient();
        closeTun();
        status = "down";
        if (!"handshake-failed".equals(code)) {
            code = "down";
        }
        stopForeground(STOP_FOREGROUND_REMOVE);
    }

    private void closeTun() {
        if (tun != null) {
            try {
                tun.close();
            } catch (Exception ignored) {
                // The descriptor is already closed on teardown.
            }
            tun = null;
        }
    }

    private void ensureForeground() {
        if (Build.VERSION.SDK_INT >= 26) {
            NotificationChannel channel = new NotificationChannel("veil", "VEIL", NotificationManager.IMPORTANCE_LOW);
            NotificationManager manager = getSystemService(NotificationManager.class);
            if (manager != null) {
                manager.createNotificationChannel(channel);
            }
        }
        Notification notification = new Notification.Builder(this, "veil")
                .setContentTitle("VEIL")
                .setContentText("Lab tunnel is up. Not a production kill switch.")
                .setSmallIcon(android.R.drawable.ic_lock_lock)
                .build();
        if (Build.VERSION.SDK_INT >= 34) {
            startForeground(1, notification, android.content.pm.ServiceInfo.FOREGROUND_SERVICE_TYPE_SPECIAL_USE);
        } else {
            startForeground(1, notification);
        }
    }
}
