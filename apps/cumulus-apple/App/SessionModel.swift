import CumulusKit
import Foundation
import SwiftUI

@MainActor
final class CumulusSession: ObservableObject {
    enum Product: String, CaseIterable, Identifiable {
        case id, mail, cloud, download
        var id: String { rawValue }
        var title: String {
            switch self {
            case .id: return "Cumulus://ID"
            case .mail: return "Cumulus://Mail"
            case .cloud: return "Cumulus://Cloud"
            case .download: return "Download"
            }
        }
    }

    enum MailSection: Equatable {
        case mail, clean, wallet, people, tasks
    }

    enum CloudSection: String, Equatable {
        case drive, trash, exchange
    }

    struct Composer: Equatable {
        var to = ""
        var cc = ""
        var subject = ""
        var body = ""
        var threadID: String?
        var draftID: String?
        var schedule = false
        var sendAt = Date().addingTimeInterval(3600)
    }

    @Published var product: Product = .mail
    @Published var configuration: CumulusConfiguration
    @Published var tokens: TokenSet?
    @Published var claims: IDTokenClaims?
    @Published var mailbox: MailboxSnapshot?
    @Published var clean: CleanSnapshot?
    @Published var drive = DriveListing(folders: [], files: [], nextFolder: nil, nextFile: nil)
    @Published var trash = DriveListing(folders: [], files: [], nextFolder: nil, nextFile: nil)
    @Published var quota: DriveQuota?
    @Published var shares: [DriveShare] = []
    @Published var versions: [DriveVersion] = []
    @Published var selectedFile: DriveFile?
    @Published var consents: [ConsentRecord] = []
    @Published var licenses: [LicenseGrant] = []
    @Published var choices: [String: Bool] = [:]
    @Published var error = ""
    @Published var busy = false
    @Published var isPreview = false
    @Published var mailBox: MailBox = .inbox
    @Published var inboxTab: InboxTab = .primary
    @Published var query = ""
    @Published var activeLabel: String?
    @Published var selectedMessage: MailMessage?
    @Published var composer: Composer?
    @Published var mailSection: MailSection = .mail
    @Published var cloudSection: CloudSection = .drive
    @Published var folderID: String?
    @Published var crumbs: [(id: String?, name: String)] = [(nil, "My Drive")]
    @Published var undoID: String?
    @Published var downloadedURL: URL?

    let store: TokenStore
    private var api: CumulusAPI

    init(store: TokenStore? = nil) {
        let configuration = CumulusConfigLoader.load()
        let store = store ?? KeychainTokenStore()
        self.configuration = configuration
        self.store = store
        self.api = CumulusAPI(configuration: configuration, http: HTTPClient(), tokens: store)
        if CommandLine.arguments.contains("-CumulusPreview") {
            loadPreview()
            // UI tests can open a product directly with CUMULUS_PRODUCT=cloud. It is an environment
            // variable because macOS treats a bare launch argument as a file to open and then skips the window.
            if let start = ProcessInfo.processInfo.environment["CUMULUS_PRODUCT"].flatMap(Product.init(rawValue:)) {
                product = start
            }
        } else {
        tokens = try? store.load()
        }
    }

    var signedIn: Bool { isPreview || tokens != nil }

    var rows: [MailMessage] {
        guard let mailbox else { return [] }
        if let activeLabel {
            return MailboxIndex.withLabel(mailbox.messages, activeLabel)
        }
        return MailboxIndex.rows(mailbox.messages, box: mailBox, tab: inboxTab, query: query, now: Date())
    }

    var thread: [MailMessage] {
        guard let mailbox, let selectedMessage else { return [] }
        return MailboxIndex.thread(mailbox.messages, threadID: selectedMessage.threadId)
    }

    /// Re-checks a stored ID token against the Cognito JWKS. A bad signature signs the app out.
    func restore() async {
        guard !isPreview, let idToken = tokens?.idToken else { return }
        do {
            let jwks = try await api.fetchJWKS()
            claims = try OIDC.validateIDToken(idToken: idToken, configuration: configuration, nonce: nil, jwks: jwks)
        } catch let error as CumulusError {
            if case .oidc = error {
                signOut()
                self.error = String(describing: error)
            }
        } catch {
            return
        }
    }

    func signIn() async {
        error = ""
        busy = true
        defer { busy = false }
        do {
            let request = try OIDC.authorizationRequest(configuration: configuration)
            let callback = try await BrowserSignIn.start(url: request.url, scheme: "cumulus")
            let code = try OIDC.parseCallback(callback, expectedState: request.state)
            let signedIn = try await api.exchange(code: code, verifier: request.verifier, nonce: request.nonce)
            tokens = signedIn.tokens
            claims = signedIn.claims
            try await reload()
        } catch {
            self.error = String(describing: error)
        }
    }

    func signOut() {
        try? store.clear()
        try? api.signOut()
        tokens = nil
        claims = nil
        mailbox = nil
        clean = nil
        selectedMessage = nil
        composer = nil
        isPreview = false
        error = ""
    }

    func reload() async throws {
        guard !isPreview else { return }
        mailbox = try await api.mailbox()
        clean = try? await api.clean()
        if product == .cloud { try await reloadDrive() }
        consents = (try? await api.consents()) ?? consents
        licenses = (try? await api.licenses()) ?? licenses
    }

    func reloadDrive() async throws {
        guard !isPreview else { return }
        _ = try? await api.grantDrive()
        quota = try? await api.driveQuota()
        if cloudSection == .trash {
            trash = try await api.driveTrash()
        } else {
            drive = try await api.listDrive(folderID: folderID)
        }
    }

    /// Reloads the current Drive view and shows any error, for buttons that can't throw.
    func refreshDrive() async {
        await run { try await self.reloadDrive() }
    }

    func openFolder(_ id: String?, name: String) async {
        folderID = id
        if id == nil {
            crumbs = [(nil, "My Drive")]
        } else if let index = crumbs.firstIndex(where: { $0.id == id }) {
            crumbs = Array(crumbs.prefix(index + 1))
        } else {
            crumbs.append((id, name))
        }
        cloudSection = .drive
        await run { try await self.reloadDrive() }
    }

    func composeNew() {
        composer = Composer()
        mailSection = .mail
        product = .mail
    }

    func sendComposer() async {
        guard let composer else { return }
        if isPreview {
            var box = mailbox ?? previewMailbox()
            let message = MailMessage(
                id: "local-\(UUID().uuidString)",
                threadId: composer.threadID ?? UUID().uuidString,
                folder: composer.schedule ? "drafts" : "sent",
                from: box.me,
                to: [MailPerson(name: composer.to, email: composer.to)],
                cc: composer.cc.isEmpty ? [] : [MailPerson(name: composer.cc, email: composer.cc)],
                subject: composer.subject,
                body: composer.body,
                at: ISO8601DateFormatter().string(from: Date()),
                unread: false,
                starred: false,
                sendAt: composer.schedule ? ISO8601DateFormatter().string(from: composer.sendAt) : nil
            )
            box = MailboxSnapshot(me: box.me, messages: box.messages + [message], aliases: box.aliases, tasks: box.tasks, contacts: box.contacts, quota: box.quota, unread: box.unread, account: box.account, tunnel: box.tunnel)
            mailbox = box
            self.composer = nil
            return
        }
        await run {
            let formatter = ISO8601DateFormatter()
            if composer.schedule {
                self.mailbox = try await self.api.sendMail(to: composer.to, cc: composer.cc, subject: composer.subject, body: composer.body, threadID: composer.threadID, draftID: composer.draftID, sendAt: formatter.string(from: composer.sendAt))
            } else {
                self.mailbox = try await self.api.sendMail(to: composer.to, cc: composer.cc, subject: composer.subject, body: composer.body, threadID: composer.threadID, draftID: composer.draftID)
            }
            self.composer = nil
        }
    }

    func threadAction(_ action: String, messageID: String? = nil) async {
        let target = mailbox?.messages.first { $0.id == (messageID ?? selectedMessage?.id) }
        guard let target else { return }
        let leaves = action == "trash" || action == "archive" || action == "inbox"
        if isPreview {
            guard var box = mailbox else { return }
            box = MailboxSnapshot(
                me: box.me,
                messages: box.messages.map { message in
                    guard message.threadId == target.threadId else { return message }
                    var copy = message
                    if action == "trash" { copy.folder = "trash" }
                    if action == "archive" { copy.folder = "archive" }
                    if action == "read" { copy.unread = false }
                    if action == "star" { copy.starred = true }
                    if action == "unstar" { copy.starred = false }
                    if action == "inbox" { copy.folder = "inbox" }
                    return copy
                },
                aliases: box.aliases, tasks: box.tasks, contacts: box.contacts, quota: box.quota, unread: box.unread, account: box.account, tunnel: box.tunnel
            )
            mailbox = box
            if leaves { selectedMessage = nil }
            return
        }
        await run {
            let result = try await self.api.actOnThreads(action, threadIDs: [target.threadId], box: self.mailBox.rawValue)
            self.mailbox = result.mailbox
            self.undoID = result.undo
            if leaves { self.selectedMessage = nil }
        }
    }

    func upload(_ url: URL) async {
        let name = url.lastPathComponent
        let accessing = url.startAccessingSecurityScopedResource()
        defer { if accessing { url.stopAccessingSecurityScopedResource() } }
        guard let bytes = try? Data(contentsOf: url) else {
            error = "That file could not be read."
            return
        }
        if isPreview {
            let file = DriveFile(id: UUID().uuidString, name: name, folderId: folderID, size: bytes.count, sha256: SHA256.hex(bytes), mediaType: "application/octet-stream", encrypted: false, versionId: UUID().uuidString, version: 1, trashedAt: nil, createdAt: ISO8601DateFormatter().string(from: Date()), updatedAt: ISO8601DateFormatter().string(from: Date()))
            var listing = drive
            listing.files.append(file)
            drive = listing
            return
        }
        await run {
            _ = try await self.api.uploadFile(name: name, folderID: self.folderID, bytes: bytes, contentType: "application/octet-stream")
            try await self.reloadDrive()
        }
    }

    func downloadSelected() async {
        guard let file = selectedFile else { return }
        if isPreview {
            let url = FileManager.default.temporaryDirectory.appendingPathComponent(file.name)
            try? Data("Preview file".utf8).write(to: url)
            downloadedURL = url
            return
        }
        await run {
            let data = try await self.api.downloadFile(id: file.id)
            let url = FileManager.default.temporaryDirectory.appendingPathComponent(file.name)
            try data.write(to: url)
            self.downloadedURL = url
        }
    }

    func shareSelected() async {
        guard let file = selectedFile else { return }
        if isPreview {
            shares = [DriveShare(id: "preview-share", fileId: file.id, expiresAt: nil, revokedAt: nil, createdAt: ISO8601DateFormatter().string(from: Date()), token: "preview", url: configuration.cloudAPI.absoluteString + "/v1/s/preview")]
            return
        }
        await run {
            let share = try await self.api.createShare(fileID: file.id)
            self.shares = try await self.api.listShares(fileID: file.id)
            if !self.shares.contains(where: { $0.id == share.id }) {
                self.shares.insert(share, at: 0)
            }
        }
    }

    func loadVersions() async {
        guard let file = selectedFile, !isPreview else { return }
        versions = (try? await api.fileVersions(id: file.id)) ?? []
    }

    func trashSelected() async {
        guard let file = selectedFile else { return }
        if isPreview {
            var listing = drive
            listing.files.removeAll { $0.id == file.id }
            drive = listing
            selectedFile = nil
            return
        }
        await run {
            try await self.api.trashFile(id: file.id)
            self.selectedFile = nil
            try await self.reloadDrive()
        }
    }

    func createFolder(named name: String) async {
        let trimmed = name.trimmingCharacters(in: .whitespacesAndNewlines)
        guard !trimmed.isEmpty else { return }
        if isPreview {
            var listing = drive
            listing.folders.append(DriveFolder(id: UUID().uuidString, name: trimmed, parentId: folderID, trashedAt: nil, createdAt: "", updatedAt: ""))
            drive = listing
            return
        }
        await run {
            _ = try await self.api.createFolder(name: trimmed, parentID: self.folderID)
            try await self.reloadDrive()
        }
    }

    func setChoice(_ product: String, _ granted: Bool) async {
        var next = choices
        next[product] = granted
        choices = next
        guard !isPreview else { return }
        _ = try? await api.grantConsent(product: product, granted: granted)
    }

    func selectMessage(_ message: MailMessage) {
        selectedMessage = message
        mailSection = .mail
        if isPreview, var box = mailbox {
            box = MailboxSnapshot(
                me: box.me,
                messages: box.messages.map { item in
                    var copy = item
                    if copy.threadId == message.threadId { copy.unread = false }
                    return copy
                },
                aliases: box.aliases, tasks: box.tasks, contacts: box.contacts, quota: box.quota, unread: box.unread, account: box.account, tunnel: box.tunnel
            )
            mailbox = box
        }
    }

    private func run(_ work: () async throws -> Void) async {
        error = ""
        busy = true
        defer { busy = false }
        do { try await work() } catch { self.error = String(describing: error) }
    }

    private func loadPreview() {
        isPreview = true
        tokens = TokenSet(accessToken: "preview")
        claims = IDTokenClaims(issuer: configuration.expectedIssuer, subject: "cid:alex", audience: [configuration.clientID], expiresAt: Date().addingTimeInterval(3600), nonce: nil, email: "alex@cumuluscloud.app", name: "Alex Reid", preferredUsername: "alex")
        mailbox = previewMailbox()
        clean = nil
        drive = DriveListing(
            folders: [DriveFolder(id: "folder-odin", name: "ODIN briefing", parentId: nil, trashedAt: nil, createdAt: "2026-11-01T00:00:00Z", updatedAt: "2026-11-04T00:00:00Z")],
            files: [DriveFile(id: "file-brief", name: "odin-briefing.pdf", folderId: nil, size: 240_000, sha256: "abc", mediaType: "application/pdf", encrypted: true, versionId: "ver-1", version: 2, trashedAt: nil, createdAt: "2026-11-01T00:00:00Z", updatedAt: "2026-11-05T00:00:00Z")],
            nextFolder: nil,
            nextFile: nil
        )
        quota = DriveQuota(usedBytes: 1_048_576, limitBytes: 15_000_000_000, label: "1 MB of 15 GB")
        licenses = [LicenseGrant(id: nil, objectKey: "usage/cumulus", licensee: "Not shared", terms: "personal", issuedAt: "2026-11-01T00:00:00Z")]
    }

    private func previewMailbox() -> MailboxSnapshot {
        let me = MailPerson(name: "Alex Reid", email: "alex@cumuluscloud.app", cid: "cid:alex")
        let mira = MailPerson(name: "Mira Chen", email: "mira.chen@cumuluscloud.app")
        let messages = [
            MailMessage(id: "m-pipe", threadId: "th-pipe", folder: "inbox", from: mira, to: [me], subject: "VYRAL London — hold the forecast", body: "Holding the Q4 forecast on VYRAL as you asked.", at: "2026-11-05T12:40:00Z", unread: true, starred: true, labels: ["Spectre"], tunnel: MailTunnel(verified: true, fingerprint: "ab12 cd34")),
            MailMessage(id: "m-sec", threadId: "th-sec", folder: "inbox", from: MailPerson(name: "CID Security", email: "security@cumuluscloud.app"), to: [me], subject: "New passkey on your Cumulus://ID", body: "A passkey was added to cid:alex.", at: "2026-11-05T08:05:00Z", unread: true, starred: false, labels: ["CID"], system: "security"),
            MailMessage(id: "m-news", threadId: "th-news", folder: "inbox", from: MailPerson(name: "Cumulus", email: "newsletter@cumuluscloud.app"), to: [me], subject: "Product notes", body: "Unsubscribe from these notes any time.", at: "2026-11-04T09:00:00Z", unread: false, starred: false, labels: ["Updates"]),
        ]
        return MailboxSnapshot(
            me: me,
            messages: messages,
            aliases: ["north.quiet.1842@cumuluscloud.app"],
            tasks: [MailTask(id: "task-1", title: "Send the security appendix", detail: "Waiting on you.", done: false, messageId: "m-pipe")],
            contacts: [MailContact(id: "c1", name: "Mira Chen", email: "mira.chen@cumuluscloud.app", org: "Spectre", note: nil)],
            quota: MailQuota(label: "1 MB of 15 GB", pct: 1),
            unread: 2,
            account: AccountSummary(cid: "cid:alex", username: "alex", mailAddress: "alex@cumuluscloud.app", plan: "Free", storage: StorageSummary(label: "1 MB of 15 GB", pct: 1, mail: "1 MB", cloud: "0 B"), wallet: WalletSummary(address: "firm:alex", balances: [WalletBalance(asset: "USDC", amount: "0"), WalletBalance(asset: "FIRM", amount: "0")])),
            tunnel: TunnelStatus(fingerprint: "ab12 cd34 ef56", atRest: true)
        )
    }
}
