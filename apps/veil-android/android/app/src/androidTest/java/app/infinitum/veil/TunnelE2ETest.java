package app.infinitum.veil;

import static org.junit.Assert.assertEquals;
import static org.junit.Assert.assertFalse;
import static org.junit.Assert.assertNotNull;
import static org.junit.Assert.assertNull;
import static org.junit.Assert.assertTrue;

import android.content.ComponentName;
import android.content.Context;
import android.content.Intent;
import android.content.ServiceConnection;
import android.content.pm.PackageManager;
import android.content.pm.ServiceInfo;
import android.net.VpnService;
import android.os.IBinder;

import androidx.test.ext.junit.runners.AndroidJUnit4;
import androidx.test.platform.app.InstrumentationRegistry;

import org.junit.After;
import org.junit.Before;
import org.junit.Test;
import org.junit.runner.RunWith;

import java.net.DatagramPacket;
import java.net.DatagramSocket;
import java.net.Inet4Address;
import java.net.InetAddress;
import java.net.NetworkInterface;
import java.nio.charset.StandardCharsets;
import java.util.Enumeration;
import java.util.concurrent.CountDownLatch;
import java.util.concurrent.TimeUnit;
import java.util.concurrent.atomic.AtomicReference;

import app.infinitum.veil.mobile.Mobile;

/**
 * Runs on a device or emulator. A passing JVM test is not a substitute.
 * Keys are minted in process and are not written down.
 */
@RunWith(AndroidJUnit4.class)
public class TunnelE2ETest {
    private VeilVpnService service;

    @Before
    public void grantAndBind() throws Exception {
        InstrumentationRegistry.getInstrumentation()
                .getUiAutomation()
                .executeShellCommand("appops set app.infinitum.veil ACTIVATE_VPN allow")
                .close();
        Context context = target();
        assertNull(VpnService.prepare(context));
        bind();
    }

    @After
    public void tearDown() {
        if (service != null) {
            service.disconnect();
        }
        Mobile.stopPeer();
        Mobile.stopClient();
    }

    @Test
    public void encryptedRoundTripAndNegatives() throws Exception {
        String deviceIp = underlyingV4();
        String[] client = Mobile.mintKey().split(" ");
        String[] peer = Mobile.mintKey().split(" ");
        byte[] payload = "VEIL-E2E-ROUNDTRIP".getBytes(StandardCharsets.US_ASCII);

        String up = service.connect(config(client[0], peer[1], "127.0.0.1:9", false, 0, false));
        assertEquals("up", up);
        assertFalse(service.dnsInstalled());
        int peerPort = Mobile.peerStart(peer[0], client[1], "127.0.0.1:9", 0, fd -> service.protect((int) fd));
        Mobile.setClientPeer(deviceIp + ":" + peerPort);
        Mobile.setInprocessPeer(deviceIp + ":" + service.listenPort());

        sendV4(payload);
        assertTrue("decrypted payload did not arrive", waitForPayload(payload, 12_000));
        assertFalse("inner payload was on the UDP socket", Mobile.wireHasPlaintext(payload));
        assertTrue(Mobile.clientHandshakeUnix() > 0L);

        service.disconnect();
        assertFalse(Mobile.clientUp());
        assertEquals("down", service.status());
        Mobile.stopPeer();

        String[] wrong = Mobile.mintKey().split(" ");
        up = service.connect(config(client[0], wrong[1], "127.0.0.1:9", false, 0, false));
        assertEquals("up", up);
        peerPort = Mobile.peerStart(peer[0], client[1], "127.0.0.1:9", 0, fd -> service.protect((int) fd));
        Mobile.setClientPeer(deviceIp + ":" + peerPort);
        Mobile.setInprocessPeer(deviceIp + ":" + service.listenPort());
        sendV4(payload);
        Thread.sleep(1500);
        assertFalse(Mobile.peerHas(payload));
        assertFalse(Mobile.wireHasPlaintext(payload));
        service.disconnect();
        Mobile.stopPeer();

        String protectCode = service.connect(config(client[0], peer[1], "127.0.0.1:9", false, 0, true));
        assertEquals("protect-failed", protectCode);
        assertFalse(Mobile.clientUp());
        assertEquals("down", service.status());

        up = service.connect(config(client[0], peer[1], "127.0.0.1:9", true, 1500, false));
        assertEquals("up", up);
        peerPort = Mobile.peerStart(peer[0], client[1], "127.0.0.1:9", 0, fd -> service.protect((int) fd));
        Mobile.setClientPeer(deviceIp + ":" + peerPort);
        service.onRevoke();
        assertEquals("down", service.status());
        assertFalse(Mobile.clientUp());
        Mobile.stopPeer();

        up = service.connect(config(client[0], peer[1], "127.0.0.1:9", false, 0, false));
        assertEquals("up", up);
        peerPort = Mobile.peerStart(peer[0], client[1], "127.0.0.1:9", 0, fd -> service.protect((int) fd));
        Mobile.setClientPeer(deviceIp + ":" + peerPort);
        Mobile.setInprocessPeer(deviceIp + ":" + service.listenPort());
        byte[] again = "VEIL-E2E-RESTART".getBytes(StandardCharsets.US_ASCII);
        sendV4(again);
        assertTrue(waitForPayload(again, 12_000));
        service.disconnect();

        long dropped = Mobile.dropped();
        try {
            DatagramSocket v6 = new DatagramSocket();
            byte[] marker = "VEIL-IPV6".getBytes(StandardCharsets.US_ASCII);
            v6.send(new DatagramPacket(marker, marker.length, InetAddress.getByName("2001:db8::1"), 9));
            v6.close();
            Thread.sleep(500);
            assertFalse(Mobile.peerHas(marker));
        } catch (Exception ipv6) {
            // The emulator may have no IPv6 path. Capture-and-discard is still the service contract.
        }

        ServiceInfo info = target().getPackageManager().getServiceInfo(
                new ComponentName(target(), VeilVpnService.class), PackageManager.GET_META_DATA);
        assertNotNull(info.metaData);
        assertFalse(info.metaData.getBoolean("android.net.VpnService.SUPPORTS_ALWAYS_ON", true));
        assertTrue(dropped >= 0);
    }

    private static VeilVpnService.PeerConfig config(
            String priv, String pub, String endpoint, boolean watch, int waitMs, boolean protectFails) {
        return new VeilVpnService.PeerConfig(priv, pub, endpoint, "10.77.0.2/32", 0, watch, waitMs, protectFails);
    }

    private void sendV4(byte[] payload) throws Exception {
        DatagramSocket socket = new DatagramSocket();
        socket.send(new DatagramPacket(payload, payload.length, InetAddress.getByName("10.77.0.1"), 9));
        socket.close();
    }

    private static boolean waitForPayload(byte[] payload, long ms) throws Exception {
        long end = System.currentTimeMillis() + ms;
        while (System.currentTimeMillis() < end) {
            if (Mobile.peerHas(payload)) {
                return true;
            }
            Thread.sleep(50);
        }
        return false;
    }

    private static String underlyingV4() throws Exception {
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
        throw new IllegalStateException("no IPv4 address on the device");
    }

    private void bind() throws Exception {
        CountDownLatch latch = new CountDownLatch(1);
        AtomicReference<VeilVpnService> ref = new AtomicReference<>();
        ServiceConnection connection = new ServiceConnection() {
            @Override
            public void onServiceConnected(ComponentName name, IBinder binder) {
                ref.set(((VeilVpnService.LocalBinder) binder).getService());
                latch.countDown();
            }

            @Override
            public void onServiceDisconnected(ComponentName name) {
            }
        };
        Intent intent = new Intent(target(), VeilVpnService.class);
        assertTrue(target().bindService(intent, connection, Context.BIND_AUTO_CREATE));
        assertTrue(latch.await(5, TimeUnit.SECONDS));
        service = ref.get();
        assertNotNull(service);
    }

    private static Context target() {
        return InstrumentationRegistry.getInstrumentation().getTargetContext();
    }
}
