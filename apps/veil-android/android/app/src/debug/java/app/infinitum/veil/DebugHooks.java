package app.infinitum.veil;

import android.widget.Button;
import android.widget.LinearLayout;
import android.widget.TextView;

import java.net.DatagramPacket;
import java.net.DatagramSocket;
import java.net.Inet4Address;
import java.net.InetAddress;
import java.net.NetworkInterface;
import java.nio.charset.StandardCharsets;
import java.util.Enumeration;

import app.infinitum.veil.mobile.Mobile;

/** Debug-only local peer. Release builds use the empty hook and have no test entry. */
public final class DebugHooks {
    private DebugHooks() {
    }

    public static void attach(MainActivity activity, LinearLayout column) {
        TextView label = new TextView(activity);
        label.setTextColor(0xFF1A1A1A);
        label.setText("Local test peer. Debug build only. Disposable keys stay in memory and are not an operator server.");
        column.addView(label);
        Button button = new Button(activity);
        button.setText("Start local test peer");
        button.setContentDescription("Start local test peer");
        button.setOnClickListener(v -> activity.requestConsent(() -> run(activity)));
        column.addView(button);
    }

    private static void run(MainActivity activity) {
        String ip;
        try {
            ip = deviceIpv4();
        } catch (Exception ex) {
            activity.showCode("no-device-ipv4");
            return;
        }
        String client;
        String peer;
        try {
            client = Mobile.mintKey();
            peer = Mobile.mintKey();
        } catch (Exception ex) {
            activity.showCode("failed");
            return;
        }
        String[] clientParts = client.split(" ");
        String[] peerParts = peer.split(" ");
        IntentServiceWork work = svc -> {
            String code = svc.connect(new VeilVpnService.PeerConfig(
                    clientParts[0], peerParts[1], "127.0.0.1:9", "10.77.0.2/32", 0, false, 0, false));
            activity.showCode(code);
            if (!"interface-up".equals(code)) {
                return;
            }
            try {
                int peerPort = Mobile.peerStart(peerParts[0], clientParts[1], "127.0.0.1:9", 0, fd -> svc.protect((int) fd));
                Mobile.setClientPeer(ip + ":" + peerPort);
                Mobile.setInprocessPeer(ip + ":" + svc.listenPort());
                byte[] payload = "VEIL-LOCAL-TEST".getBytes(StandardCharsets.US_ASCII);
                DatagramSocket socket = new DatagramSocket();
                socket.send(new DatagramPacket(payload, payload.length, InetAddress.getByName("10.77.0.1"), 9));
                socket.close();
                activity.showCode(svc.phase());
            } catch (Exception ex) {
                activity.showCode("failed");
            }
        };
        if (activity.service == null) {
            activity.showCode("service-unavailable");
            return;
        }
        work.run(activity.service);
    }

    private interface IntentServiceWork {
        void run(VeilVpnService service);
    }

    private static String deviceIpv4() throws Exception {
        Enumeration<NetworkInterface> interfaces = NetworkInterface.getNetworkInterfaces();
        while (interfaces.hasMoreElements()) {
            NetworkInterface nif = interfaces.nextElement();
            if (!nif.isUp() || nif.isLoopback()) {
                continue;
            }
            Enumeration<InetAddress> addresses = nif.getInetAddresses();
            while (addresses.hasMoreElements()) {
                InetAddress address = addresses.nextElement();
                if (address instanceof Inet4Address && !address.isLoopbackAddress()) {
                    return address.getHostAddress();
                }
            }
        }
        throw new IllegalStateException("no IPv4");
    }
}
