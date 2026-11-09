import Foundation
import Network
import NetworkExtension
import WireGuardKit

/// Packet tunnel for VEIL Desktop. WireGuardKit is MIT (wireguard-apple).
/// This provider is not compiled in the Linux CI build. It needs Xcode,
/// a Network Extension entitlement, and an Apple Developer team.
final class PacketTunnelProvider: NEPacketTunnelProvider {
    private lazy var adapter = WireGuardAdapter(with: self) { _, _ in }

    override func startTunnel(options: [String: NSObject]?, completionHandler: @escaping (Error?) -> Void) {
        guard let proto = protocolConfiguration as? NETunnelProviderProtocol,
              let grant = proto.providerConfiguration?["grant"] as? String ?? options?["grant"] as? String,
              let tunnel = Self.configuration(from: grant) else {
            completionHandler(PacketTunnelError.invalidGrant)
            return
        }
        adapter.start(tunnelConfiguration: tunnel) { error in
            completionHandler(error)
        }
    }

    override func stopTunnel(with reason: NEProviderStopReason, completionHandler: @escaping () -> Void) {
        adapter.stop { _ in
            completionHandler()
        }
    }

    /// Builds a full tunnel. Public DNS and split tunnels are refused.
    static func configuration(from grantJSON: String) -> TunnelConfiguration? {
        guard let data = grantJSON.data(using: .utf8),
              let grant = try? JSONDecoder().decode(DeviceGrant.self, from: data),
              grant.coverage == "device", grant.deviceWide, grant.killSwitch == "fail-closed",
              grant.dns == "through-tunnel",
              grant.peer.allowedIps == ["0.0.0.0/0", "::/0"],
              let privateKey = PrivateKey(base64Key: grant.interface.privateKey),
              let publicKey = PublicKey(base64Key: grant.peer.publicKey),
              let address = IPAddressRange(from: grant.interface.address),
              address.stringRepresentation.hasPrefix("10.64."),
              let endpoint = Endpoint(from: grant.peer.endpoint) else {
            return nil
        }
        var interfaceConfig = InterfaceConfiguration(privateKey: privateKey)
        interfaceConfig.addresses = [address]
        interfaceConfig.mtu = UInt16(grant.interface.mtu)
        interfaceConfig.dns = grant.interface.dns.compactMap { DNSServer(from: $0) }
        guard interfaceConfig.dns.allSatisfy({ $0.stringRepresentation.hasPrefix("10.64.") }) else {
            return nil
        }
        var peer = PeerConfiguration(publicKey: publicKey)
        peer.endpoint = endpoint
        peer.allowedIPs = grant.peer.allowedIps.compactMap { IPAddressRange(from: $0) }
        peer.persistentKeepAlive = UInt16(grant.peer.persistentKeepalive)
        return TunnelConfiguration(name: "VEIL", interface: interfaceConfig, peers: [peer])
    }
}

private struct DeviceGrant: Decodable {
    var coverage: String
    var deviceWide: Bool
    var dns: String
    var killSwitch: String
    var interface: InterfaceGrant
    var peer: PeerGrant
}

private struct InterfaceGrant: Decodable {
    var privateKey: String
    var address: String
    var dns: [String]
    var mtu: Int
}

private struct PeerGrant: Decodable {
    var publicKey: String
    var endpoint: String
    var allowedIps: [String]
    var persistentKeepalive: Int
}

private enum PacketTunnelError: Error {
    case invalidGrant
}
