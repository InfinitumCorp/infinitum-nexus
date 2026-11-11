import XCTest
@testable import CumulusKit

final class MailboxTests: XCTestCase {
    private let now = Date(timeIntervalSince1970: 1_762_900_000)

    func testInboxTabsAndFolders() {
        let person = message(id: "1", folder: "inbox", subject: "Hello", from: "Mira Chen", email: "mira@cumuluscloud.app", at: "2026-11-05T12:00:00Z", unread: true, labels: ["Spectre"])
        let news = message(id: "2", folder: "inbox", subject: "Weekly", from: "News", email: "newsletter@cumuluscloud.app", at: "2026-11-05T11:00:00Z", body: "Unsubscribe any time")
        let sent = message(id: "3", folder: "sent", subject: "Sent", from: "Alex", email: "alex@cumuluscloud.app", at: "2026-11-04T11:00:00Z", delivery: [MailDeliveryHop(email: "a@example.com", status: "outbound", detail: "queued")])
        let snoozed = message(id: "4", folder: "inbox", subject: "Later", from: "Sam", email: "sam@cumuluscloud.app", at: "2026-11-01T11:00:00Z", snoozeUntil: "2027-01-01T00:00:00Z")
        let messages = [person, news, sent, snoozed]
        XCTAssertEqual(MailboxIndex.classify(news), .newsletter)
        XCTAssertEqual(MailboxIndex.classify(person), .person)
        let primary = MailboxIndex.rows(messages, box: .inbox, tab: .primary, query: "", now: now)
        XCTAssertEqual(primary.map(\.id), ["1"])
        let updates = MailboxIndex.rows(messages, box: .inbox, tab: .updates, query: "", now: now)
        XCTAssertEqual(updates.map(\.id), ["2"])
        XCTAssertEqual(MailboxIndex.rows(messages, box: .outbox, tab: .all, query: "", now: now).map(\.id), ["3"])
        XCTAssertEqual(MailboxIndex.rows(messages, box: .snoozed, tab: .all, query: "", now: now).map(\.id), ["4"])
        XCTAssertEqual(MailboxIndex.labels(in: messages), ["Spectre"])
        XCTAssertEqual(MailboxIndex.withLabel(messages, "Spectre").map(\.id), ["1"])
    }

    func testThreadKeepsNewestRow() {
        let older = message(id: "a", thread: "t", folder: "inbox", subject: "Re: Notes", from: "Leah", email: "leah@cumuluscloud.app", at: "2026-11-01T00:00:00Z")
        let newer = message(id: "b", thread: "t", folder: "inbox", subject: "Re: Notes", from: "Leah", email: "leah@cumuluscloud.app", at: "2026-11-02T00:00:00Z", unread: true)
        let rows = MailboxIndex.rows([older, newer], box: .inbox, tab: .all, query: "", now: now)
        XCTAssertEqual(rows.map(\.id), ["b"])
        XCTAssertEqual(MailboxIndex.thread([older, newer], threadID: "t").map(\.id), ["a", "b"])
    }

    func testExchangePolicy() {
        XCTAssertFalse(ExchangePolicy.sharingAllowed(choices: ["cumulus": true], productID: "cumulus", globalPrivacyControl: true))
        XCTAssertFalse(ExchangePolicy.sharingAllowed(choices: ["odin": true], productID: "odin", globalPrivacyControl: false))
        XCTAssertFalse(ExchangePolicy.sharingAllowed(choices: [:], productID: "veil", globalPrivacyControl: false))
        XCTAssertTrue(ExchangePolicy.sharingAllowed(choices: ["veil": true], productID: "veil", globalPrivacyControl: false))
        XCTAssertEqual(ExchangePolicy.personSharePercent, 85)
        XCTAssertTrue(ExchangePolicy.neverSold.contains("Messages"))
        XCTAssertFalse(ExchangePolicy.offered.contains { $0.id == "odin" || $0.id == "firmament" || $0.id == "infinitum" })
    }

    private func message(
        id: String,
        thread: String? = nil,
        folder: String,
        subject: String,
        from: String,
        email: String,
        at: String,
        unread: Bool = false,
        labels: [String] = [],
        body: String = "Body",
        delivery: [MailDeliveryHop] = [],
        snoozeUntil: String? = nil
    ) -> MailMessage {
        MailMessage(
            id: id,
            threadId: thread ?? id,
            folder: folder,
            from: MailPerson(name: from, email: email),
            to: [MailPerson(name: "Alex", email: "alex@cumuluscloud.app")],
            subject: subject,
            body: body,
            at: at,
            unread: unread,
            starred: false,
            labels: labels,
            delivery: delivery,
            snoozeUntil: snoozeUntil
        )
    }
}
