import XCTest
#if canImport(FoundationNetworking)
import FoundationNetworking
#endif
@testable import CumulusKit

final class ClientTests: XCTestCase {
    func testMailStateSendsSessionCookieAndBearer() async throws {
        let transport = ScriptedTransport()
        transport.handler = { request in
            XCTAssertEqual(request.url?.path, "/api/state")
            XCTAssertEqual(request.value(forHTTPHeaderField: "Authorization"), "Bearer session-token")
            XCTAssertEqual(request.value(forHTTPHeaderField: "Cookie"), "cmail_session=session-token")
            XCTAssertNil(request.value(forHTTPHeaderField: "X-Cumulus"))
            let body = """
            {"me":{"name":"Alex Reid","email":"alex@cumuluscloud.app","cid":"cid:alex"},"messages":[{"id":"m1","threadId":"t1","folder":"inbox","from":{"name":"Mira","email":"mira@cumuluscloud.app"},"to":[{"name":"Alex","email":"alex@cumuluscloud.app"}],"subject":"Notes","body":"Hello","at":"2026-11-05T12:00:00Z","unread":true,"starred":false,"labels":["Spectre"]}],"aliases":[],"tasks":[],"contacts":[],"quota":{"label":"1 MB of 15 GB","pct":1},"unread":1,"account":{"cid":"cid:alex","username":"alex","mailAddress":"alex@cumuluscloud.app","plan":"Free","wallet":{"address":"firm:alex","balances":{"USDC":"10.00","FIRM":"2"}}}}
            """
            return (200, Data(body.utf8))
        }
        let api = try makeAPI(transport)
        let mailbox = try await api.mailbox()
        XCTAssertEqual(mailbox.me.email, "alex@cumuluscloud.app")
        XCTAssertEqual(mailbox.messages.first?.labels, ["Spectre"])
        XCTAssertEqual(mailbox.account?.wallet?.balances.map(\.asset).sorted(), ["FIRM", "USDC"])
    }

    func testSendIncludesCumulusHeader() async throws {
        let transport = ScriptedTransport()
        transport.handler = { request in
            XCTAssertEqual(request.url?.path, "/api/send")
            XCTAssertEqual(request.value(forHTTPHeaderField: "X-Cumulus"), "1")
            let posted = try JSONSerialization.jsonObject(with: request.httpBody ?? Data()) as? [String: Any]
            XCTAssertEqual(posted?["to"] as? String, "leah@cumuluscloud.app")
            let body = #"{"state":{"me":{"name":"Alex","email":"alex@cumuluscloud.app"},"messages":[],"quota":{"label":"","pct":0},"unread":0}}"#
            return (200, Data(body.utf8))
        }
        let api = try makeAPI(transport)
        let mailbox = try await api.sendMail(to: "leah@cumuluscloud.app", subject: "Notes", body: "Hello")
        XCTAssertEqual(mailbox.me.email, "alex@cumuluscloud.app")
    }

    func testDriveUploadDownloadShareAndTrash() async throws {
        let transport = ScriptedTransport()
        var paths: [String] = []
        transport.handler = { request in
            let path = request.url?.path ?? ""
            paths.append(path + " " + (request.httpMethod ?? ""))
            if path == "/v1/list" {
                let body = #"{"folders":[{"id":"folder-1","name":"ODIN briefing","parentId":null,"trashedAt":null,"createdAt":"2026-11-01T00:00:00Z","updatedAt":"2026-11-02T00:00:00Z"}],"files":[{"id":"file-1","name":"brief.pdf","folderId":null,"size":12,"sha256":"abc","mediaType":"application/pdf","encrypted":false,"versionId":"ver-1","version":1,"trashedAt":null,"createdAt":"2026-11-01T00:00:00Z","updatedAt":"2026-11-02T00:00:00Z"}],"nextFolder":null,"nextFile":null}"#
                return (200, Data(body.utf8))
            }
            if path == "/v1/files" {
                XCTAssertEqual(request.value(forHTTPHeaderField: "X-Cumulus-Name"), "notes.txt")
                XCTAssertEqual(request.value(forHTTPHeaderField: "X-Cumulus-Sha256"), SHA256.hex(Data("hello".utf8)))
                XCTAssertEqual(request.value(forHTTPHeaderField: "Authorization"), "Bearer session-token")
                let file = #"{"file":{"id":"file-2","name":"notes.txt","folderId":null,"size":5,"sha256":"abc","mediaType":"text/plain","encrypted":true,"versionId":"ver-2","version":1,"trashedAt":null,"createdAt":"2026-11-03T00:00:00Z","updatedAt":"2026-11-03T00:00:00Z"}}"#
                return (201, Data(file.utf8))
            }
            if path == "/v1/files/file-1/content" {
                return (200, Data("bytes".utf8))
            }
            if path == "/v1/files/file-1/versions" {
                return (200, Data(#"{"versions":[{"id":"ver-1","version":1,"size":12,"sha256":"abc","mediaType":"application/pdf","encrypted":false,"createdAt":"2026-11-01T00:00:00Z","current":true}]}"#.utf8))
            }
            if path == "/v1/files/file-1/shares" && request.httpMethod == "POST" {
                return (201, Data(#"{"share":{"id":"share-1","fileId":"file-1","expiresAt":null,"revokedAt":null,"createdAt":"2026-11-05T00:00:00Z","token":"tok","url":"https://cloud.cumuluscloud.app/v1/s/tok"}}"#.utf8))
            }
            if path == "/v1/trash" {
                return (200, Data(#"{"folders":[],"files":[]}"#.utf8))
            }
            return (200, Data(#"{"ok":true}"#.utf8))
        }
        let api = try makeAPI(transport)
        let listing = try await api.listDrive(folderID: nil)
        XCTAssertEqual(listing.folders.first?.name, "ODIN briefing")
        let uploaded = try await api.uploadFile(name: "notes.txt", folderID: nil, bytes: Data("hello".utf8), contentType: "text/plain")
        XCTAssertEqual(uploaded.name, "notes.txt")
        let downloaded = try await api.downloadFile(id: "file-1")
        XCTAssertEqual(downloaded, Data("bytes".utf8))
        let versions = try await api.fileVersions(id: "file-1")
        XCTAssertEqual(versions.first?.current, true)
        let share = try await api.createShare(fileID: "file-1")
        XCTAssertEqual(share.url, "https://cloud.cumuluscloud.app/v1/s/tok")
        _ = try await api.driveTrash()
        XCTAssertTrue(paths.contains("/v1/files/file-1/content GET"))
    }

    func testExchangeConsentAndLicenses() async throws {
        let transport = ScriptedTransport()
        transport.handler = { request in
            if request.url?.path == "/v1/exchange/consents" && request.httpMethod == "POST" {
                let posted = try JSONSerialization.jsonObject(with: request.httpBody ?? Data()) as? [String: Any]
                XCTAssertEqual(posted?["product"] as? String, "cumulus")
                XCTAssertEqual(posted?["purpose"] as? String, "data_licensing")
                XCTAssertEqual(posted?["granted"] as? Bool, true)
                let body = #"{"id":"consent-1","cid":"cid:alex","product":"cumulus","granted":true,"scopes":["usage_metrics"],"purpose":"data_licensing","timestamp":"2026-11-05T00:00:00Z"}"#
                return (200, Data(body.utf8))
            }
            if request.url?.path == "/v1/exchange/licenses" {
                let body = #"{"licenses":[{"objectKey":"usage/cumulus","licensee":"broker_acme","terms":"CDAT-commercial-1y","issuedAt":"2026-11-05T00:00:00Z"}]}"#
                return (200, Data(body.utf8))
            }
            return (200, Data(#"{"consents":[]}"#.utf8))
        }
        let api = try makeAPI(transport)
        let consent = try await api.grantConsent(product: "cumulus", granted: true)
        XCTAssertEqual(consent.id, "consent-1")
        let licenses = try await api.licenses()
        XCTAssertEqual(licenses.first?.terms, "CDAT-commercial-1y")
        let consents = try await api.consents()
        XCTAssertEqual(consents.count, 0)
    }

    func testAPIErrorDoesNotEchoTheToken() async throws {
        let transport = ScriptedTransport()
        transport.handler = { _ in
            (401, Data(#"{"error":"Please sign in","code":"unauthorized"}"#.utf8))
        }
        let api = try makeAPI(transport)
        do {
            _ = try await api.mailbox()
            XCTFail("expected an error")
        } catch let error as CumulusError {
            XCTAssertEqual(error, .api(status: 401, message: "Please sign in", code: "unauthorized"))
            XCTAssertFalse(error.description.contains("session-token"))
        }
    }

    private func makeAPI(_ transport: ScriptedTransport) throws -> CumulusAPI {
        let store = MemoryTokenStore()
        try store.save(TokenSet(accessToken: "session-token"))
        return CumulusAPI(configuration: .production, http: HTTPClient(transport: transport), tokens: store)
    }
}

final class ScriptedTransport: HTTPTransport {
    var handler: (URLRequest) throws -> (Int, Data) = { _ in (200, Data("{}".utf8)) }

    func send(_ request: URLRequest) async throws -> (Data, HTTPURLResponse) {
        let (status, data) = try handler(request)
        let response = HTTPURLResponse(url: request.url ?? URL(string: "https://mail.cumuluscloud.app/")!, statusCode: status, httpVersion: "HTTP/1.1", headerFields: nil)!
        return (data, response)
    }
}
