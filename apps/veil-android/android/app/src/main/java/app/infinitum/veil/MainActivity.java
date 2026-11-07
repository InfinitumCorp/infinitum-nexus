package app.infinitum.veil;

import android.app.Activity;
import android.content.ComponentName;
import android.content.Context;
import android.content.Intent;
import android.content.ServiceConnection;
import android.net.VpnService;
import android.os.Bundle;
import android.os.IBinder;
import android.text.InputType;
import android.view.View;
import android.widget.Button;
import android.widget.EditText;
import android.widget.LinearLayout;
import android.widget.ScrollView;
import android.widget.TextView;

/**
 * Operator peer entry. The private key stays in the field until connect and is
 * not written to preferences, logs, or saved instance state. Nothing connects
 * until the system VPN consent returns.
 */
public final class MainActivity extends Activity {
    private static final int CONSENT = 1;
    private static final String LIMITS =
            "Full-device IPv4 route 0.0.0.0/0. IPv6 route ::/0 is captured and dropped, not tunneled. "
                    + "No DNS server is installed. No kill switch: when the tunnel is down, other traffic is not blocked. "
                    + "Product name infinitumveilvpn.app is not a server.";

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
        LinearLayout column = new LinearLayout(this);
        column.setOrientation(LinearLayout.VERTICAL);
        int pad = 48;
        column.setPadding(pad, pad, pad, pad);

        TextView title = new TextView(this);
        title.setText("VEIL");
        column.addView(title);

        TextView limits = new TextView(this);
        limits.setText(LIMITS);
        column.addView(limits);

        statusView = new TextView(this);
        statusView.setText(describe("down"));
        column.addView(statusView);

        TextView operator = new TextView(this);
        operator.setText("Operator-provided peer. This is not a local test and not a built-in server.");
        column.addView(operator);

        endpointView = field("IPv4:port", InputType.TYPE_CLASS_TEXT);
        publicView = field("Peer public key, 64 hex characters", InputType.TYPE_TEXT_VARIATION_VISIBLE_PASSWORD);
        privateView = field("Private key, 64 hex characters, not saved", InputType.TYPE_CLASS_TEXT | InputType.TYPE_TEXT_VARIATION_PASSWORD);
        privateView.setSaveEnabled(false);
        column.addView(endpointView);
        column.addView(publicView);
        column.addView(privateView);

        Button connect = new Button(this);
        connect.setText("Connect");
        connect.setOnClickListener(v -> requestConsent(this::connectOperator));
        column.addView(connect);

        Button disconnect = new Button(this);
        disconnect.setText("Disconnect");
        disconnect.setOnClickListener(v -> {
            if (service != null) {
                service.disconnect();
            }
            showPhase();
        });
        column.addView(disconnect);

        DebugHooks.attach(this, column);

        ScrollView scroll = new ScrollView(this);
        scroll.addView(column);
        setContentView(scroll);
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

    private EditText field(String hint, int inputType) {
        EditText view = new EditText(this);
        view.setHint(hint);
        view.setInputType(inputType);
        view.setImportantForAutofill(View.IMPORTANT_FOR_AUTOFILL_NO);
        return view;
    }

    static String describe(String code) {
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
        } else {
            detail = "The tunnel did not stay up (" + code + ").";
        }
        return detail + "\n\n" + LIMITS;
    }
}
