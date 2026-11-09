import AppKit
import Foundation

/// Menu-bar UI for VEIL Desktop. VEIL VPN, Tor, and Off call the local daemon.
/// This file is AppKit source. Linux CI cannot compile it. The unsigned .app
/// produced on Linux is the utun engine, not this menu bar.
final class VeilMenu: NSObject, NSApplicationDelegate {
    private let status = NSStatusBar.system.statusItem(withLength: NSStatusItem.variableLength)
    private var runtime: Runtime?

    func applicationDidFinishLaunching(_ notification: Notification) {
        status.button?.title = "VEIL"
        let menu = NSMenu()
        menu.addItem(item("VEIL VPN", #selector(selectVeil)))
        menu.addItem(item("Tor", #selector(selectTor)))
        menu.addItem(item("Off", #selector(selectOff)))
        menu.addItem(.separator())
        menu.addItem(item("Quit", #selector(quit)))
        status.menu = menu
        runtime = Runtime.load()
        refresh()
    }

    @objc private func selectVeil() { post("veil") }
    @objc private func selectTor() { post("tor") }
    @objc private func selectOff() { post("off") }
    @objc private func quit() {
        post("off")
        NSApp.terminate(nil)
    }

    private func post(_ mode: String) {
        guard let runtime else {
            status.button?.title = "VEIL off"
            return
        }
        var request = URLRequest(url: runtime.url.appendingPathComponent("mode"))
        request.httpMethod = "POST"
        request.setValue("Bearer \(runtime.token)", forHTTPHeaderField: "Authorization")
        request.httpBody = Data("{\"mode\":\"\(mode)\"}".utf8)
        URLSession.shared.dataTask(with: request) { _, _, _ in
            DispatchQueue.main.async { self.refresh() }
        }.resume()
    }

    private func refresh() {
        guard let runtime else { return }
        var request = URLRequest(url: runtime.url.appendingPathComponent("status"))
        request.setValue("Bearer \(runtime.token)", forHTTPHeaderField: "Authorization")
        URLSession.shared.dataTask(with: request) { data, _, _ in
            let title = Self.title(from: data)
            DispatchQueue.main.async { self.status.button?.title = title }
        }.resume()
    }

    private static func title(from data: Data?) -> String {
        guard let data,
              let json = try? JSONSerialization.jsonObject(with: data) as? [String: Any],
              let mode = json["mode"] as? String else {
            return "VEIL"
        }
        switch mode {
        case "veil": return "VEIL VPN"
        case "tor": return "VEIL Tor"
        default: return "VEIL off"
        }
    }

    private func item(_ title: String, _ action: Selector) -> NSMenuItem {
        NSMenuItem(title: title, action: action, keyEquivalent: "")
    }
}

private struct Runtime {
    var url: URL
    var token: String

    static func load() -> Runtime? {
        let base = FileManager.default.urls(for: .applicationSupportDirectory, in: .userDomainMask).first
            ?? FileManager.default.homeDirectoryForCurrentUser
        let candidates = [
            base.appendingPathComponent("infinitum/veil-desktop/local.json"),
            FileManager.default.homeDirectoryForCurrentUser.appendingPathComponent("Library/Application Support/infinitum/veil-desktop/local.json"),
        ]
        let config = FileManager.default.urls(for: .libraryDirectory, in: .userDomainMask).first?
            .appendingPathComponent("Application Support")
        var paths = candidates
        if let home = FileManager.default.homeDirectoryForCurrentUser as URL? {
            paths.append(home.appendingPathComponent(".config/infinitum/veil-desktop/local.json"))
        }
        _ = config
        for path in paths {
            guard let data = try? Data(contentsOf: path),
                  let json = try? JSONSerialization.jsonObject(with: data) as? [String: Any],
                  let urlText = json["url"] as? String,
                  let url = URL(string: urlText),
                  let token = json["token"] as? String else {
                continue
            }
            return Runtime(url: url, token: token)
        }
        return nil
    }
}

let app = NSApplication.shared
let delegate = VeilMenu()
app.delegate = delegate
app.setActivationPolicy(.accessory)
app.run()
