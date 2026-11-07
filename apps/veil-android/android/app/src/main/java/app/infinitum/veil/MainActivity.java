package app.infinitum.veil;

import android.app.Activity;
import android.os.Bundle;
import android.widget.TextView;

/** Shows product identity. It does not dial infinitumveilvpn.app and has no peer. */
public final class MainActivity extends Activity {
    @Override
    protected void onCreate(Bundle savedInstanceState) {
        super.onCreate(savedInstanceState);
        TextView view = new TextView(this);
        view.setPadding(48, 48, 48, 48);
        view.setText(
                "VEIL\n\n"
                        + "Product name: infinitumveilvpn.app\n"
                        + "Hosted at Cloudflare. This name is not a VPN server and no peer is provisioned.\n\n"
                        + "Disconnected. Connect stays off until a caller supplies an IPv4 peer.\n\n"
                        + "IPv6 is captured and discarded, not tunneled. No DNS server is installed.\n"
                        + "When the tunnel is down, other traffic is not blocked. This is not an OS kill switch.");
        setContentView(view);
    }
}
