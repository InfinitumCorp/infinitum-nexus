import CumulusKit
import SwiftUI

@main
struct CumulusApp: App {
    @StateObject private var session = CumulusSession()

    var body: some Scene {
        WindowGroup {
            ShellView(session: session)
                .frame(minWidth: 800, minHeight: 560)
        }
        .commands {
            CommandGroup(replacing: .newItem) {
                Button("Compose") { session.composeNew() }
                    .keyboardShortcut("n", modifiers: .command)
            }
        }
    }
}
