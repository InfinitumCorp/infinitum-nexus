import Foundation

public struct MailPerson: Codable, Equatable, Sendable {
    public var name: String
    public var email: String
    public var cid: String?

    public init(name: String, email: String, cid: String? = nil) {
        self.name = name
        self.email = email
        self.cid = cid
    }
}

public struct MailAttachment: Codable, Equatable, Sendable {
    public var name: String
    public var size: Int
    public var id: String?
    public var type: String?
}

public struct MailDeliveryHop: Codable, Equatable, Sendable {
    public var email: String
    public var status: String
    public var detail: String
}

public struct MailPayment: Codable, Equatable, Sendable {
    public var asset: String
    public var amount: String
    public var txId: String
    public var ledgerHash: String?
}

public struct MailTunnel: Codable, Equatable, Sendable {
    public var verified: Bool
    public var fingerprint: String
}

public struct MailMessage: Decodable, Equatable, Identifiable, Sendable {
    public var id: String
    public var threadId: String
    public var folder: String
    public var from: MailPerson
    public var to: [MailPerson]
    public var cc: [MailPerson]
    public var subject: String
    public var body: String
    public var at: String
    public var unread: Bool
    public var starred: Bool
    public var labels: [String]
    public var attachments: [MailAttachment]
    public var delivery: [MailDeliveryHop]
    public var snoozeUntil: String?
    public var sendAt: String?
    public var payment: MailPayment?
    public var system: String?
    public var tunnel: MailTunnel?
    public var locked: Bool
    public var kind: String?

    public init(
        id: String,
        threadId: String,
        folder: String,
        from: MailPerson,
        to: [MailPerson],
        cc: [MailPerson] = [],
        subject: String,
        body: String,
        at: String,
        unread: Bool,
        starred: Bool,
        labels: [String] = [],
        attachments: [MailAttachment] = [],
        delivery: [MailDeliveryHop] = [],
        snoozeUntil: String? = nil,
        sendAt: String? = nil,
        payment: MailPayment? = nil,
        system: String? = nil,
        tunnel: MailTunnel? = nil,
        locked: Bool = false,
        kind: String? = nil
    ) {
        self.id = id
        self.threadId = threadId
        self.folder = folder
        self.from = from
        self.to = to
        self.cc = cc
        self.subject = subject
        self.body = body
        self.at = at
        self.unread = unread
        self.starred = starred
        self.labels = labels
        self.attachments = attachments
        self.delivery = delivery
        self.snoozeUntil = snoozeUntil
        self.sendAt = sendAt
        self.payment = payment
        self.system = system
        self.tunnel = tunnel
        self.locked = locked
        self.kind = kind
    }

    private enum CodingKeys: String, CodingKey {
        case id, threadId, folder, from, to, cc, subject, body, at, unread, starred, labels
        case attachments, delivery, snoozeUntil, sendAt, payment, system, tunnel, locked, kind
    }

    public init(from decoder: Decoder) throws {
        let c = try decoder.container(keyedBy: CodingKeys.self)
        id = try c.decode(String.self, forKey: .id)
        threadId = try c.decodeIfPresent(String.self, forKey: .threadId) ?? id
        folder = try c.decodeIfPresent(String.self, forKey: .folder) ?? "inbox"
        from = try c.decode(MailPerson.self, forKey: .from)
        to = try c.decodeIfPresent([MailPerson].self, forKey: .to) ?? []
        cc = try c.decodeIfPresent([MailPerson].self, forKey: .cc) ?? []
        subject = try c.decodeIfPresent(String.self, forKey: .subject) ?? ""
        body = try c.decodeIfPresent(String.self, forKey: .body) ?? ""
        at = try c.decodeIfPresent(String.self, forKey: .at) ?? ""
        unread = try c.decodeIfPresent(Bool.self, forKey: .unread) ?? false
        starred = try c.decodeIfPresent(Bool.self, forKey: .starred) ?? false
        labels = try c.decodeIfPresent([String].self, forKey: .labels) ?? []
        attachments = try c.decodeIfPresent([MailAttachment].self, forKey: .attachments) ?? []
        delivery = try c.decodeIfPresent([MailDeliveryHop].self, forKey: .delivery) ?? []
        snoozeUntil = try c.decodeIfPresent(String.self, forKey: .snoozeUntil)
        sendAt = try c.decodeIfPresent(String.self, forKey: .sendAt)
        payment = try c.decodeIfPresent(MailPayment.self, forKey: .payment)
        system = try c.decodeIfPresent(String.self, forKey: .system)
        tunnel = try c.decodeIfPresent(MailTunnel.self, forKey: .tunnel)
        locked = try c.decodeIfPresent(Bool.self, forKey: .locked) ?? false
        kind = try c.decodeIfPresent(String.self, forKey: .kind)
    }
}

public struct MailTask: Codable, Equatable, Identifiable, Sendable {
    public var id: String
    public var title: String
    public var detail: String
    public var done: Bool
    public var messageId: String?
    public init(id: String, title: String, detail: String, done: Bool, messageId: String? = nil) {
        self.id = id
        self.title = title
        self.detail = detail
        self.done = done
        self.messageId = messageId
    }
}

public struct MailContact: Codable, Equatable, Identifiable, Sendable {
    public var id: String
    public var name: String
    public var email: String
    public var org: String?
    public var note: String?
    public init(id: String, name: String, email: String, org: String? = nil, note: String? = nil) {
        self.id = id
        self.name = name
        self.email = email
        self.org = org
        self.note = note
    }
}

public struct MailQuota: Codable, Equatable, Sendable {
    public var label: String
    public var pct: Double
    public init(label: String, pct: Double) {
        self.label = label
        self.pct = pct
    }
}

public struct StorageSummary: Codable, Equatable, Sendable {
    public var label: String
    public var pct: Double
    public var mail: String?
    public var cloud: String?
    public init(label: String, pct: Double, mail: String? = nil, cloud: String? = nil) {
        self.label = label
        self.pct = pct
        self.mail = mail
        self.cloud = cloud
    }
}

public struct WalletBalance: Codable, Equatable, Sendable {
    public var asset: String
    public var amount: String
    public init(asset: String, amount: String) {
        self.asset = asset
        self.amount = amount
    }
}

public struct WalletSummary: Codable, Equatable, Sendable {
    public var address: String
    public var balances: [WalletBalance]

    public init(address: String, balances: [WalletBalance]) {
        self.address = address
        self.balances = balances
    }

    public init(from decoder: Decoder) throws {
        let c = try decoder.container(keyedBy: CodingKeys.self)
        address = try c.decodeIfPresent(String.self, forKey: .address) ?? ""
        if let list = try? c.decode([WalletBalance].self, forKey: .balances) {
            balances = list
        } else if let map = try? c.decode([String: String].self, forKey: .balances) {
            balances = map.map { WalletBalance(asset: $0.key, amount: $0.value) }.sorted { $0.asset < $1.asset }
        } else {
            balances = []
        }
    }

    public func encode(to encoder: Encoder) throws {
        var c = encoder.container(keyedBy: CodingKeys.self)
        try c.encode(address, forKey: .address)
        try c.encode(balances, forKey: .balances)
    }

    private enum CodingKeys: String, CodingKey { case address, balances }
}

public struct AccountSummary: Codable, Equatable, Sendable {
    public var cid: String
    public var username: String
    public var mailAddress: String
    public var plan: String
    public var storage: StorageSummary?
    public var wallet: WalletSummary?
    public init(cid: String, username: String, mailAddress: String, plan: String, storage: StorageSummary? = nil, wallet: WalletSummary? = nil) {
        self.cid = cid
        self.username = username
        self.mailAddress = mailAddress
        self.plan = plan
        self.storage = storage
        self.wallet = wallet
    }
}

public struct TunnelStatus: Codable, Equatable, Sendable {
    public var fingerprint: String?
    public var atRest: Bool?
    public init(fingerprint: String? = nil, atRest: Bool? = nil) {
        self.fingerprint = fingerprint
        self.atRest = atRest
    }
}

public struct MailboxSnapshot: Decodable, Equatable, Sendable {
    public var me: MailPerson
    public var messages: [MailMessage]
    public var aliases: [String]
    public var tasks: [MailTask]
    public var contacts: [MailContact]
    public var quota: MailQuota
    public var unread: Int
    public var account: AccountSummary?
    public var tunnel: TunnelStatus?
    public var briefs: [String: String]

    public init(
        me: MailPerson,
        messages: [MailMessage],
        aliases: [String] = [],
        tasks: [MailTask] = [],
        contacts: [MailContact] = [],
        quota: MailQuota = MailQuota(label: "", pct: 0),
        unread: Int = 0,
        account: AccountSummary? = nil,
        tunnel: TunnelStatus? = nil,
        briefs: [String: String] = [:]
    ) {
        self.me = me
        self.messages = messages
        self.aliases = aliases
        self.tasks = tasks
        self.contacts = contacts
        self.quota = quota
        self.unread = unread
        self.account = account
        self.tunnel = tunnel
        self.briefs = briefs
    }

    private enum CodingKeys: String, CodingKey {
        case me, messages, aliases, tasks, contacts, quota, unread, account, tunnel, briefs
    }

    public init(from decoder: Decoder) throws {
        let c = try decoder.container(keyedBy: CodingKeys.self)
        me = try c.decode(MailPerson.self, forKey: .me)
        messages = try c.decodeIfPresent([MailMessage].self, forKey: .messages) ?? []
        aliases = try c.decodeIfPresent([String].self, forKey: .aliases) ?? []
        tasks = try c.decodeIfPresent([MailTask].self, forKey: .tasks) ?? []
        contacts = try c.decodeIfPresent([MailContact].self, forKey: .contacts) ?? []
        quota = try c.decodeIfPresent(MailQuota.self, forKey: .quota) ?? MailQuota(label: "", pct: 0)
        unread = try c.decodeIfPresent(Int.self, forKey: .unread) ?? 0
        account = try c.decodeIfPresent(AccountSummary.self, forKey: .account)
        tunnel = try c.decodeIfPresent(TunnelStatus.self, forKey: .tunnel)
        briefs = try c.decodeIfPresent([String: String].self, forKey: .briefs) ?? [:]
    }
}

public struct CleanRules: Codable, Equatable, Sendable {
    public var auto: Bool
    public var newslettersAfterDays: Int?
    public var notificationsAfterDays: Int?
    public var bouncesAfterDays: Int?
    public var emptyTrashAfterDays: Int?
    public var muted: [String]

    public static let standard = CleanRules(auto: true, newslettersAfterDays: 7, notificationsAfterDays: 14, bouncesAfterDays: 30, emptyTrashAfterDays: nil, muted: [])
}

public struct CleanPreview: Codable, Equatable, Sendable {
    public var kind: String
    public var count: Int
    public var reason: String
}

public struct CleanSuggestion: Codable, Equatable, Identifiable, Sendable {
    public var id: String
    public var kind: String
    public var count: Int
    public var reason: String?
    public var email: String?
}

public struct CleanLog: Codable, Equatable, Sendable {
    public var reason: String
    public var by: String?
    public var kind: String
    public var count: Int
    public var at: String?
    public var undone: Bool?
}

public struct CleanSnapshot: Decodable, Equatable, Sendable {
    public var rules: CleanRules
    public var lastRun: String?
    public var log: [CleanLog]
    public var preview: [CleanPreview]
    public var suggestions: [CleanSuggestion]
    public var note: String

    public init(from decoder: Decoder) throws {
        let c = try decoder.container(keyedBy: CodingKeys.self)
        rules = try c.decodeIfPresent(CleanRules.self, forKey: .rules) ?? .standard
        lastRun = try c.decodeIfPresent(String.self, forKey: .lastRun)
        log = try c.decodeIfPresent([CleanLog].self, forKey: .log) ?? []
        preview = try c.decodeIfPresent([CleanPreview].self, forKey: .preview) ?? []
        suggestions = try c.decodeIfPresent([CleanSuggestion].self, forKey: .suggestions) ?? []
        note = try c.decodeIfPresent(String.self, forKey: .note) ?? ""
    }

    private enum CodingKeys: String, CodingKey { case rules, lastRun, log, preview, suggestions, note }
}

public struct DriveFolder: Codable, Equatable, Identifiable, Sendable {
    public var id: String
    public var name: String
    public var parentId: String?
    public var trashedAt: String?
    public var createdAt: String
    public var updatedAt: String
    public init(id: String, name: String, parentId: String?, trashedAt: String?, createdAt: String, updatedAt: String) {
        self.id = id
        self.name = name
        self.parentId = parentId
        self.trashedAt = trashedAt
        self.createdAt = createdAt
        self.updatedAt = updatedAt
    }
}

public struct DriveFile: Codable, Equatable, Identifiable, Sendable {
    public var id: String
    public var name: String
    public var folderId: String?
    public var size: Int
    public var sha256: String
    public var mediaType: String
    public var encrypted: Bool
    public var versionId: String
    public var version: Int
    public var trashedAt: String?
    public var createdAt: String
    public var updatedAt: String
    public init(id: String, name: String, folderId: String?, size: Int, sha256: String, mediaType: String, encrypted: Bool, versionId: String, version: Int, trashedAt: String?, createdAt: String, updatedAt: String) {
        self.id = id
        self.name = name
        self.folderId = folderId
        self.size = size
        self.sha256 = sha256
        self.mediaType = mediaType
        self.encrypted = encrypted
        self.versionId = versionId
        self.version = version
        self.trashedAt = trashedAt
        self.createdAt = createdAt
        self.updatedAt = updatedAt
    }
}

public struct DriveListing: Codable, Equatable, Sendable {
    public var folders: [DriveFolder]
    public var files: [DriveFile]
    public var nextFolder: String?
    public var nextFile: String?
    public init(folders: [DriveFolder], files: [DriveFile], nextFolder: String?, nextFile: String?) {
        self.folders = folders
        self.files = files
        self.nextFolder = nextFolder
        self.nextFile = nextFile
    }
}

public struct DriveVersion: Codable, Equatable, Identifiable, Sendable {
    public var id: String
    public var version: Int
    public var size: Int
    public var sha256: String
    public var mediaType: String
    public var encrypted: Bool
    public var createdAt: String
    public var current: Bool
}

public struct DriveShare: Codable, Equatable, Identifiable, Sendable {
    public var id: String
    public var fileId: String
    public var expiresAt: String?
    public var revokedAt: String?
    public var createdAt: String
    public var token: String?
    public var url: String?
    public init(id: String, fileId: String, expiresAt: String?, revokedAt: String?, createdAt: String, token: String? = nil, url: String? = nil) {
        self.id = id
        self.fileId = fileId
        self.expiresAt = expiresAt
        self.revokedAt = revokedAt
        self.createdAt = createdAt
        self.token = token
        self.url = url
    }
}

public struct DriveQuota: Codable, Equatable, Sendable {
    public var usedBytes: Int
    public var limitBytes: Int
    public var label: String?
    public init(usedBytes: Int, limitBytes: Int, label: String? = nil) {
        self.usedBytes = usedBytes
        self.limitBytes = limitBytes
        self.label = label
    }
}

public struct ConsentRecord: Codable, Equatable, Identifiable, Sendable {
    public var id: String
    public var cid: String
    public var product: String
    public var granted: Bool
    public var scopes: [String]
    public var purpose: String
    public var timestamp: String
    public var firmamentTx: String?
}

public struct LicenseGrant: Codable, Equatable, Identifiable, Sendable {
    public var id: String?
    public var objectKey: String
    public var licensee: String
    public var terms: String
    public var issuedAt: String
    public var identifier: String { id ?? "\(objectKey)|\(licensee)|\(issuedAt)" }
    public init(id: String?, objectKey: String, licensee: String, terms: String, issuedAt: String) {
        self.id = id
        self.objectKey = objectKey
        self.licensee = licensee
        self.terms = terms
        self.issuedAt = issuedAt
    }
}

public struct ExchangeProduct: Equatable, Sendable, Identifiable {
    public var id: String
    public var mark: String
    public init(id: String, mark: String) {
        self.id = id
        self.mark = mark
    }
}

/// Opt-in licensing rules from the FIRM Wallet data-exchange card and `@infinitum/data-exchange`.
public enum ExchangePolicy {
    public static let poolMinimum = 1000
    public static let personSharePercent = 85
    public static let purpose = "data_licensing"
    public static let scope = "usage_metrics"
    public static let neverSold = [
        "Messages", "Documents", "Prompts", "Precise location", "Biometrics", "Anything from ODIN°™ or a military edition",
    ]
    public static let excluded: Set<String> = ["odin", "aether-mil", "firmament", "infinitum"]
    public static let offered: [ExchangeProduct] = [
        ExchangeProduct(id: "cumulus", mark: "Cumulus://Cloud"),
        ExchangeProduct(id: "cumulus-mail", mark: "Cumulus://Mail"),
        ExchangeProduct(id: "cumulus-id", mark: "Cumulus://ID"),
        ExchangeProduct(id: "scalvs", mark: "SCALVS.ai"),
        ExchangeProduct(id: "architect", mark: ":\\ARCHITECT\\"),
        ExchangeProduct(id: "metatron", mark: "METATRON¹⁰⁰"),
        ExchangeProduct(id: "veil", mark: "VEIL</>"),
        ExchangeProduct(id: "firm-wallet", mark: "FIRM Wallet"),
        ExchangeProduct(id: "fabric", mark: "FABRIC"),
        ExchangeProduct(id: "hrvst", mark: "[HRVST]"),
        ExchangeProduct(id: "spectre", mark: "+SPCTR"),
    ]

    public static func sharingAllowed(choices: [String: Bool], productID: String, globalPrivacyControl: Bool) -> Bool {
        !globalPrivacyControl && !excluded.contains(productID) && choices[productID] == true
    }
}
