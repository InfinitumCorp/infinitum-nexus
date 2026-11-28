import Foundation

public enum MailBox: String, CaseIterable, Equatable, Sendable {
    case inbox, snoozed, outbox, starred, sent, drafts, scheduled, archive, trash

    public var title: String {
        switch self {
        case .inbox: return "Inbox"
        case .snoozed: return "Snoozed"
        case .outbox: return "Outbox"
        case .starred: return "Starred"
        case .sent: return "Sent"
        case .drafts: return "Drafts"
        case .scheduled: return "Scheduled"
        case .archive: return "Archive"
        case .trash: return "Trash"
        }
    }
}

public enum InboxTab: String, Equatable, Sendable {
    case primary, updates, all
}

public enum MailKind: String, Equatable, Sendable {
    case person, newsletter, notification, receipt, bounce
}

public enum MailboxIndex {
    public static let updateKinds: Set<String> = ["newsletter", "notification", "receipt", "bounce"]

    public static func classify(_ message: MailMessage) -> MailKind {
        if message.system == "postmaster" { return .bounce }
        if message.system == "wallet" || message.system == "ledger" || message.payment != nil { return .receipt }
        if message.system != nil { return .notification }
        let local = message.from.email.split(separator: "@").first.map(String.init)?.lowercased() ?? ""
        let text = (message.subject + "\n" + message.body).lowercased()
        if isBulkLocal(local) || text.contains("unsubscribe") || text.contains("view this in your browser") || text.contains("view it in your browser") || text.contains("manage your preferences") || text.contains("manage preferences") {
            return .newsletter
        }
        if message.labels.contains(where: { ["promotion", "promotions", "newsletter", "newsletters", "update", "updates"].contains($0.lowercased()) }) {
            return .newsletter
        }
        return .person
    }

    public static func kind(of message: MailMessage) -> String {
        message.kind ?? classify(message).rawValue
    }

    public static func inBox(_ message: MailMessage, _ box: MailBox, now: Date) -> Bool {
        let snoozed = isSnoozed(message, now: now)
        if box == .snoozed { return snoozed }
        if snoozed { return false }
        switch box {
        case .outbox:
            return message.folder == "sent" && message.delivery.contains { $0.status == "outbound" }
        case .starred:
            return message.starred && message.folder != "trash"
        case .scheduled:
            return message.folder == "drafts" && message.sendAt != nil
        case .drafts:
            return message.folder == "drafts" && message.sendAt == nil
        case .snoozed:
            return false
        default:
            return message.folder == box.rawValue
        }
    }

    public static func rows(_ messages: [MailMessage], box: MailBox, tab: InboxTab, query: String, now: Date) -> [MailMessage] {
        let trimmed = query.trimmingCharacters(in: .whitespacesAndNewlines)
        let pool = trimmed.isEmpty ? messages.filter { inBox($0, box, now: now) } : messages.filter { matches($0, query: trimmed) }
        var latest: [String: MailMessage] = [:]
        for message in pool {
            if trimmed.isEmpty && box == .inbox && tab == .primary && kind(of: message) != MailKind.person.rawValue { continue }
            if trimmed.isEmpty && box == .inbox && tab == .updates && !updateKinds.contains(kind(of: message)) { continue }
            if let previous = latest[message.threadId] {
                if previous.at < message.at { latest[message.threadId] = message }
            } else {
                latest[message.threadId] = message
            }
        }
        return latest.values.sorted { $0.at > $1.at }
    }

    public static func labels(in messages: [MailMessage]) -> [String] {
        var seen: [String] = []
        for message in messages {
            for label in message.labels where !seen.contains(label) {
                seen.append(label)
            }
        }
        return seen
    }

    public static func withLabel(_ messages: [MailMessage], _ label: String) -> [MailMessage] {
        var latest: [String: MailMessage] = [:]
        for message in messages where message.labels.contains(label) && message.folder != "trash" && message.folder != "drafts" {
            if let previous = latest[message.threadId] {
                if previous.at < message.at { latest[message.threadId] = message }
            } else {
                latest[message.threadId] = message
            }
        }
        return latest.values.sorted { $0.at > $1.at }
    }

    public static func thread(_ messages: [MailMessage], threadID: String) -> [MailMessage] {
        messages.filter { $0.threadId == threadID }.sorted { $0.at < $1.at }
    }

    private static func isSnoozed(_ message: MailMessage, now: Date) -> Bool {
        guard let raw = message.snoozeUntil, let until = parse(raw) else { return false }
        return until > now && message.folder != "trash" && message.folder != "drafts"
    }

    private static func matches(_ message: MailMessage, query: String) -> Bool {
        let haystack = [
            message.subject, message.body, message.from.name, message.from.email,
            message.labels.joined(separator: " "),
        ].joined(separator: "\n").lowercased()
        return query.lowercased().split(separator: " ").allSatisfy { haystack.contains($0) }
    }

    private static func parse(_ iso: String) -> Date? {
        let formatter = ISO8601DateFormatter()
        formatter.formatOptions = [.withInternetDateTime, .withFractionalSeconds]
        if let date = formatter.date(from: iso) { return date }
        formatter.formatOptions = [.withInternetDateTime]
        return formatter.date(from: iso)
    }

    private static func isBulkLocal(_ local: String) -> Bool {
        let prefixes = ["no-reply", "noreply", "do-not-reply", "donotreply", "news", "newsletter", "newsletters", "marketing", "updates", "update", "hello", "info", "digest", "notifications", "notification", "alerts", "alert", "team", "mailer", "promo", "promotions", "offers", "deals"]
        return prefixes.contains { local == $0 || local.hasPrefix($0 + ".") || local.hasPrefix($0 + "+") || local.hasPrefix($0 + "-") || local.hasPrefix($0 + "_") }
    }
}
