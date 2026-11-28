package app.infinitum.veil;

import android.app.Activity;
import android.content.ComponentName;
import android.content.Context;
import android.content.Intent;
import android.content.ServiceConnection;
import android.net.VpnService;
import android.os.Bundle;
import android.os.IBinder;
import android.widget.Button;
import android.widget.EditText;
import android.widget.TextView;

/**
 * Operator peer entry. The private key stays in the field until connect and is
 * not written to preferences, logs, or saved instance state. Nothing connects
 * until the system VPN consent returns.
 */
public final class MainActivity extends Activity {
    private static final int CONSENT = 1;
    private TextView statusView;
    private EditText endpointView;
    private EditText publicView;
    private EditText privateView;
    VeilVpnService service;
    private Runnable pending;
    private final ServiceConnection connection = new ServiceConnection() {
        @Override
        public void onServiceConnected(ComponentName name, IBinder binder) {
            service = ((VeilVpnService.LocalBinder) binder).getService();
            showPhase();
        }

        @Override
        public void onServiceDisconnected(ComponentName name) {
            service = null;
        }
    };

    @Override
    protected void onCreate(Bundle savedInstanceState) {
        super.onCreate(savedInstanceState);
        Analytics.start(this);
        setContentView(R.layout.activity_main);
        statusView = findViewById(R.id.status);
        endpointView = findViewById(R.id.endpoint);
        publicView = findViewById(R.id.peer_public);
        privateView = findViewById(R.id.private_key);
        statusView.setText(describe("down"));
        Button connect = findViewById(R.id.connect);
        connect.setOnClickListener(v -> requestConsent(this::connectOperator));
        Button disconnect = findViewById(R.id.disconnect);
        disconnect.setOnClickListener(v -> {
            if (service != null) {
                service.disconnect();
            }
            showPhase();
        });
        DebugHooks.attach(this, findViewById(R.id.debug_slot));
    }

    @Override
    protected void onStart() {
        super.onStart();
        bindService(new Intent(this, VeilVpnService.class), connection, Context.BIND_AUTO_CREATE);
    }

    @Override
    protected void onStop() {
        super.onStop();
        unbindService(connection);
        service = null;
    }

    @Override
    protected void onActivityResult(int requestCode, int resultCode, Intent data) {
        super.onActivityResult(requestCode, resultCode, data);
        if (requestCode != CONSENT) {
            return;
        }
        Runnable next = pending;
        pending = null;
        if (resultCode == RESULT_OK && next != null) {
            next.run();
        } else {
            statusView.setText(describe("consent-not-granted"));
        }
    }

    void requestConsent(Runnable action) {
        pending = action;
        Intent prepare = VpnService.prepare(this);
        if (prepare == null) {
            pending = null;
            action.run();
        } else {
            startActivityForResult(prepare, CONSENT);
        }
    }

    private void connectOperator() {
        String endpoint = text(endpointView);
        String pub = text(publicView);
        String priv = text(privateView);
        privateView.setText("");
        if (!pub.matches("[0-9a-fA-F]{64}") || !priv.matches("[0-9a-fA-F]{64}")) {
            statusView.setText(describe("bad-key"));
            return;
        }
        if (service == null) {
            statusView.setText(describe("service-unavailable"));
            return;
        }
        String code = service.connect(new VeilVpnService.PeerConfig(
                priv, pub, endpoint, "10.77.0.2/32", 0, false, 0, false));
        showCode(code);
    }

    void showCode(String code) {
        statusView.setText(describe(code));
    }

    private void showPhase() {
        if (service == null) {
            statusView.setText(describe("down"));
            return;
        }
        String tunnel = service.status();
        String last = service.code();
        if ("down".equals(tunnel) && last != null && !"down".equals(last)) {
            statusView.setText(describe(last) + "\nTunnel state: down.");
        } else {
            statusView.setText(describe(tunnel));
        }
    }

    private static String text(EditText view) {
        return view.getText() == null ? "" : view.getText().toString().trim();
    }

    String describe(String code) {
        String detail;
        if ("down".equals(code)) {
            detail = "Down. The tunnel is off. Other traffic is not blocked.";
        } else if ("interface-up".equals(code)) {
            detail = "TUN is up. Handshake has not completed. This is not internet access.";
        } else if ("handshake-complete".equals(code)) {
            detail = "Handshake completed with the configured peer. No DNS is installed, and this does not show that the public internet works.";
        } else if ("protect-failed".equals(code)) {
            detail = "Protect failed. The TUN was closed. Traffic was not left on a cleartext fallback inside the tunnel.";
        } else if ("establish-failed".equals(code)) {
            detail = "The system did not create a TUN. Nothing is up.";
        } else if ("domain-is-not-an-endpoint".equals(code)) {
            detail = "infinitumveilvpn.app is the product name, not a peer. Nothing was started.";
        } else if ("bad-endpoint".equals(code)) {
            detail = "The peer must be an IPv4 address and port. Nothing was started.";
        } else if ("bad-key".equals(code)) {
            detail = "Each key must be 64 hex characters. Nothing was started.";
        } else if ("consent-not-granted".equals(code)) {
            detail = "OS VPN consent was not granted. Nothing was started.";
        } else if ("handshake-failed".equals(code)) {
            detail = "Handshake did not finish. The TUN was closed.";
        } else if ("already-up".equals(code)) {
            detail = "The interface is already up. Disconnect before starting another peer.";
        } else if ("failed:dup".equals(code)) {
            detail = "The tunnel file could not be duplicated. The TUN was closed.";
        } else if ("failed:key".equals(code)) {
            detail = "The native key check failed. The TUN was closed.";
        } else if ("failed:listen".equals(code)) {
            detail = "The tunnel socket did not open. The TUN was closed.";
        } else if ("failed:port".equals(code)) {
            detail = "The tunnel socket did not report a listen port. The TUN was closed.";
        } else if ("failed:config".equals(code)) {
            detail = "The native peer configuration was refused. The TUN was closed.";
        } else if ("failed:tun".equals(code)) {
            detail = "The native TUN was missing. Nothing was left up.";
        } else if ("failed:up".equals(code)) {
            detail = "The native device did not come up. The TUN was closed.";
        } else if ("failed:cidr".equals(code)) {
            detail = "A local address is required. Nothing was started.";
        } else if ("failed:unlisted".equals(code)) {
            detail = "The tunnel did not stay up (failed:unlisted).";
        } else if (code != null && code.length() <= 32 && code.matches("[a-z0-9]+(:[a-z0-9]+)?")) {
            detail = "The tunnel did not stay up (" + code + ").";
        } else {
            detail = "The tunnel did not stay up (failed:unlisted).";
        }
        return detail;
    }
}
