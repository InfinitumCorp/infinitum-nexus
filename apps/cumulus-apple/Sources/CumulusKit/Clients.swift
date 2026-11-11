import Foundation
#if canImport(FoundationNetworking)
import FoundationNetworking
#endif

public final class CumulusAPI {
    public let configuration: CumulusConfiguration
    public let http: HTTPClient
    public let tokens: TokenStore

    public init(configuration: CumulusConfiguration, http: HTTPClient, tokens: TokenStore) {
        self.configuration = configuration
        self.http = http
        self.tokens = tokens
    }

    public func accessToken() throws -> String {
        guard let token = try tokens.load()?.accessToken, !token.isEmpty else {
            throw CumulusError.oidc("Sign in with Cumulus://ID.")
        }
        return token
    }

    /// Exchanges the code, checks the ID token against the issuer JWKS, then stores the tokens.
    public func exchange(code: String, verifier: String, nonce: String, now: Date = Date()) async throws -> (tokens: TokenSet, claims: IDTokenClaims) {
        let request = OIDC.tokenRequest(configuration: configuration, code: code, verifier: verifier)
        let result = try await http.send(request)
        let tokens = try OIDC.parseTokenResponse(result.data, now: now)
        guard let idToken = tokens.idToken, !idToken.isEmpty else {
            throw CumulusError.oidc("The token response did not include an ID token.")
        }
        let claims = try OIDC.validateIDToken(idToken: idToken, configuration: configuration, nonce: nonce, jwks: try await fetchJWKS(), now: now)
        try self.tokens.save(tokens)
        return (tokens, claims)
    }

    /// Public JWKS. No access token is sent.
    public func fetchJWKS() async throws -> JWKS {
        var request = URLRequest(url: configuration.jwksURL)
        request.httpMethod = "GET"
        request.setValue("application/json", forHTTPHeaderField: "Accept")
        let result = try await http.send(request)
        return try JWKS.parse(result.data)
    }

    public func refresh(now: Date = Date()) async throws -> TokenSet {
        guard let current = try tokens.load(), let refresh = current.refreshToken else {
            throw CumulusError.oidc("There is no refresh token.")
        }
        let request = OIDC.refreshRequest(configuration: configuration, refreshToken: refresh)
        let result = try await http.send(request)
        var next = try OIDC.parseTokenResponse(result.data, now: now)
        if next.refreshToken == nil { next.refreshToken = refresh }
        try tokens.save(next)
        return next
    }

    public func signOut() throws {
        try tokens.clear()
    }

    // MARK: Mail

    public func mailbox() async throws -> MailboxSnapshot {
        try HTTPClient.decode(MailboxSnapshot.self, from: try await get(configuration.mailAPI, "/api/state", mail: true))
    }

    public func sendMail(to: String, cc: String = "", subject: String, body: String, threadID: String? = nil, draftID: String? = nil, sendAt: String? = nil) async throws -> MailboxSnapshot {
        var payload: [String: Any] = ["to": to, "cc": cc, "subject": subject, "body": body]
        if let threadID { payload["threadId"] = threadID }
        if let draftID { payload["draftId"] = draftID }
        let path = sendAt == nil ? "/api/send" : "/api/schedule"
        if let sendAt { payload["sendAt"] = sendAt }
        let data = try await post(configuration.mailAPI, path, payload, mail: true)
        return try snapshot(from: data)
    }

    public func saveDraft(to: String, cc: String = "", subject: String, body: String, threadID: String? = nil, draftID: String? = nil) async throws -> MailboxSnapshot {
        var payload: [String: Any] = ["to": to, "cc": cc, "subject": subject, "body": body]
        if let threadID { payload["threadId"] = threadID }
        if let draftID { payload["draftId"] = draftID }
        return try snapshot(from: try await post(configuration.mailAPI, "/api/draft", payload, mail: true))
    }

    public func markRead(threadID: String) async throws -> MailboxSnapshot {
        try snapshot(from: try await post(configuration.mailAPI, "/api/read", ["threadId": threadID], mail: true))
    }

    public func star(id: String) async throws -> MailboxSnapshot {
        try snapshot(from: try await post(configuration.mailAPI, "/api/star", ["id": id], mail: true))
    }

    public func move(id: String, folder: String) async throws -> MailboxSnapshot {
        try snapshot(from: try await post(configuration.mailAPI, "/api/move", ["id": id, "folder": folder], mail: true))
    }

    public func snooze(id: String, until: String) async throws -> MailboxSnapshot {
        try snapshot(from: try await post(configuration.mailAPI, "/api/snooze", ["id": id, "until": until], mail: true))
    }

    public func actOnThreads(_ action: String, threadIDs: [String], box: String) async throws -> (undo: String?, mailbox: MailboxSnapshot) {
        let data = try await post(configuration.mailAPI, "/api/threads", ["action": action, "threadIds": threadIDs, "box": box], mail: true)
        let object = try object(data)
        let undo = object["undo"] as? String
        guard let state = object["state"] else { throw CumulusError.decode("The mailbox was missing.") }
        let encoded = try JSONSerialization.data(withJSONObject: state)
        return (undo, try HTTPClient.decode(MailboxSnapshot.self, from: encoded))
    }

    public func undo(_ id: String) async throws -> MailboxSnapshot {
        try snapshot(from: try await post(configuration.mailAPI, "/api/undo", ["id": id], mail: true))
    }

    public func emptyMailTrash() async throws -> MailboxSnapshot {
        try snapshot(from: try await post(configuration.mailAPI, "/api/trash/empty", [:], mail: true))
    }

    public func addAlias(_ alias: String) async throws -> MailboxSnapshot {
        try snapshot(from: try await post(configuration.mailAPI, "/api/alias", ["alias": alias], mail: true))
    }

    public func addContact(name: String, email: String) async throws -> MailboxSnapshot {
        try snapshot(from: try await post(configuration.mailAPI, "/api/contact", ["name": name, "email": email], mail: true))
    }

    public func toggleTask(id: String) async throws -> MailboxSnapshot {
        try snapshot(from: try await post(configuration.mailAPI, "/api/task/toggle", ["id": id], mail: true))
    }

    public func message(id: String) async throws -> MailMessage {
        let data = try await get(configuration.mailAPI, "/api/message", query: [URLQueryItem(name: "id", value: id)], mail: true)
        struct Envelope: Decodable { var message: MailMessage }
        return try HTTPClient.decode(Envelope.self, from: data).message
    }

    public func clean() async throws -> CleanSnapshot {
        try HTTPClient.decode(CleanSnapshot.self, from: try await get(configuration.mailAPI, "/api/clean", mail: true))
    }

    public func setCleanRules(_ rules: [String: Any]) async throws -> CleanSnapshot {
        let data = try await post(configuration.mailAPI, "/api/clean/rules", rules, mail: true)
        return try cleanEnvelope(data)
    }

    public func runClean() async throws -> CleanSnapshot {
        try cleanEnvelope(try await post(configuration.mailAPI, "/api/clean/run", [:], mail: true))
    }

    public func approveClean(id: String) async throws -> CleanSnapshot {
        try cleanEnvelope(try await post(configuration.mailAPI, "/api/clean/approve", ["id": id], mail: true))
    }

    public func dismissClean(id: String) async throws -> CleanSnapshot {
        try cleanEnvelope(try await post(configuration.mailAPI, "/api/clean/dismiss", ["id": id], mail: true))
    }

    public func undoClean(id: String) async throws -> CleanSnapshot {
        try cleanEnvelope(try await post(configuration.mailAPI, "/api/clean/undo", ["id": id], mail: true))
    }

    public func mute(email: String) async throws -> CleanSnapshot {
        try cleanEnvelope(try await post(configuration.mailAPI, "/api/clean/mute", ["email": email], mail: true))
    }

    public func account() async throws -> AccountSummary {
        try HTTPClient.decode(AccountSummary.self, from: try await get(configuration.mailAPI, "/api/me", mail: true))
    }

    // MARK: Drive

    public func driveQuota() async throws -> DriveQuota {
        try HTTPClient.decode(DriveQuota.self, from: try await get(configuration.cloudAPI, "/v1/quota", mail: false))
    }

    public func grantDrive() async throws {
        _ = try await post(configuration.cloudAPI, "/v1/access", [:], mail: false)
    }

    public func listDrive(folderID: String?) async throws -> DriveListing {
        var query: [URLQueryItem] = []
        if let folderID { query.append(URLQueryItem(name: "folderId", value: folderID)) }
        return try HTTPClient.decode(DriveListing.self, from: try await get(configuration.cloudAPI, "/v1/list", query: query, mail: false))
    }

    public func driveTrash() async throws -> DriveListing {
        try HTTPClient.decode(DriveListing.self, from: try await get(configuration.cloudAPI, "/v1/trash", mail: false))
    }

    public func createFolder(name: String, parentID: String?) async throws -> DriveFolder {
        var body: [String: Any] = ["name": name]
        if let parentID { body["parentId"] = parentID }
        let data = try await post(configuration.cloudAPI, "/v1/folders", body, mail: false)
        struct Envelope: Decodable { var folder: DriveFolder }
        return try HTTPClient.decode(Envelope.self, from: data).folder
    }

    public func uploadFile(name: String, folderID: String?, bytes: Data, contentType: String) async throws -> DriveFile {
        let token = try accessToken()
        var request = URLRequest(url: APIRequest.url(configuration.cloudAPI, "/v1/files"))
        request.httpMethod = "POST"
        request.setValue("Bearer \(token)", forHTTPHeaderField: "Authorization")
        request.setValue("application/octet-stream", forHTTPHeaderField: "Content-Type")
        request.setValue(String(bytes.count), forHTTPHeaderField: "Content-Length")
        request.setValue(name, forHTTPHeaderField: "X-Cumulus-Name")
        if let folderID { request.setValue(folderID, forHTTPHeaderField: "X-Cumulus-Folder") }
        request.setValue(SHA256.hex(bytes), forHTTPHeaderField: "X-Cumulus-Sha256")
        request.httpBody = bytes
        let result = try await http.send(request)
        struct Envelope: Decodable { var file: DriveFile }
        return try HTTPClient.decode(Envelope.self, from: result.data).file
    }

    public func downloadFile(id: String) async throws -> Data {
        let token = try accessToken()
        var request = URLRequest(url: APIRequest.url(configuration.cloudAPI, "/v1/files/\(id)/content"))
        request.httpMethod = "GET"
        request.setValue("Bearer \(token)", forHTTPHeaderField: "Authorization")
        return try await http.send(request).data
    }

    public func fileVersions(id: String) async throws -> [DriveVersion] {
        struct Envelope: Decodable { var versions: [DriveVersion] }
        return try HTTPClient.decode(Envelope.self, from: try await get(configuration.cloudAPI, "/v1/files/\(id)/versions", mail: false)).versions
    }

    public func deleteVersion(fileID: String, versionID: String) async throws {
        _ = try await send("DELETE", configuration.cloudAPI, "/v1/files/\(fileID)/versions/\(versionID)", nil, mail: false)
    }

    public func trashFile(id: String, purge: Bool = false) async throws {
        let path = "/v1/files/\(id)" + (purge ? "?purge=1" : "")
        _ = try await send("DELETE", configuration.cloudAPI, path, nil, mail: false)
    }

    public func restoreFile(id: String) async throws -> DriveFile {
        struct Envelope: Decodable { var file: DriveFile }
        return try HTTPClient.decode(Envelope.self, from: try await post(configuration.cloudAPI, "/v1/files/\(id)/restore", [:], mail: false)).file
    }

    public func trashFolder(id: String) async throws {
        _ = try await send("DELETE", configuration.cloudAPI, "/v1/folders/\(id)", nil, mail: false)
    }

    public func restoreFolder(id: String) async throws -> DriveFolder {
        struct Envelope: Decodable { var folder: DriveFolder }
        return try HTTPClient.decode(Envelope.self, from: try await post(configuration.cloudAPI, "/v1/folders/\(id)/restore", [:], mail: false)).folder
    }

    public func emptyDriveTrash() async throws {
        _ = try await post(configuration.cloudAPI, "/v1/trash/empty", [:], mail: false)
    }

    public func createShare(fileID: String, expiresAt: String? = nil) async throws -> DriveShare {
        var body: [String: Any] = [:]
        if let expiresAt { body["expiresAt"] = expiresAt }
        struct Envelope: Decodable { var share: DriveShare }
        return try HTTPClient.decode(Envelope.self, from: try await post(configuration.cloudAPI, "/v1/files/\(fileID)/shares", body, mail: false)).share
    }

    public func listShares(fileID: String) async throws -> [DriveShare] {
        struct Envelope: Decodable { var shares: [DriveShare] }
        return try HTTPClient.decode(Envelope.self, from: try await get(configuration.cloudAPI, "/v1/files/\(fileID)/shares", mail: false)).shares
    }

    public func revokeShare(id: String) async throws {
        _ = try await send("DELETE", configuration.cloudAPI, "/v1/shares/\(id)", nil, mail: false)
    }

    public func renameFile(id: String, name: String) async throws -> DriveFile {
        struct Envelope: Decodable { var file: DriveFile }
        return try HTTPClient.decode(Envelope.self, from: try await send("PATCH", configuration.cloudAPI, "/v1/files/\(id)", ["name": name], mail: false)).file
    }

    // MARK: Exchange

    public func consents() async throws -> [ConsentRecord] {
        let data = try await get(configuration.exchangeAPI, "/v1/exchange/consents", mail: false)
        if let list = try? HTTPClient.decode([ConsentRecord].self, from: data) { return list }
        struct Envelope: Decodable { var consents: [ConsentRecord] }
        return try HTTPClient.decode(Envelope.self, from: data).consents
    }

    public func grantConsent(product: String, granted: Bool) async throws -> ConsentRecord {
        let body: [String: Any] = [
            "product": product,
            "granted": granted,
            "scopes": [ExchangePolicy.scope],
            "purpose": ExchangePolicy.purpose,
        ]
        let data = try await post(configuration.exchangeAPI, "/v1/exchange/consents", body, mail: false)
        if let record = try? HTTPClient.decode(ConsentRecord.self, from: data) { return record }
        struct Envelope: Decodable { var consent: ConsentRecord }
        return try HTTPClient.decode(Envelope.self, from: data).consent
    }

    public func revokeConsent(id: String) async throws {
        _ = try await post(configuration.exchangeAPI, "/v1/exchange/consents/\(id)/revoke", [:], mail: false)
    }

    public func licenses() async throws -> [LicenseGrant] {
        let data = try await get(configuration.exchangeAPI, "/v1/exchange/licenses", mail: false)
        if let list = try? HTTPClient.decode([LicenseGrant].self, from: data) { return list }
        struct Envelope: Decodable { var licenses: [LicenseGrant] }
        return try HTTPClient.decode(Envelope.self, from: data).licenses
    }

    // MARK: plumbing

    private func snapshot(from data: Data) throws -> MailboxSnapshot {
        if let direct = try? HTTPClient.decode(MailboxSnapshot.self, from: data) { return direct }
        let object = try object(data)
        guard let state = object["state"] else { throw CumulusError.decode("The mailbox was missing.") }
        let encoded = try JSONSerialization.data(withJSONObject: state)
        return try HTTPClient.decode(MailboxSnapshot.self, from: encoded)
    }

    private func cleanEnvelope(_ data: Data) throws -> CleanSnapshot {
        if let direct = try? HTTPClient.decode(CleanSnapshot.self, from: data) { return direct }
        let object = try object(data)
        guard let clean = object["clean"] else { throw CumulusError.decode("Clean state was missing.") }
        let encoded = try JSONSerialization.data(withJSONObject: clean)
        return try HTTPClient.decode(CleanSnapshot.self, from: encoded)
    }

    private func get(_ base: URL, _ path: String, query: [URLQueryItem] = [], mail: Bool) async throws -> Data {
        try await send("GET", base, path, nil, query: query, mail: mail)
    }

    private func post(_ base: URL, _ path: String, _ body: Any, mail: Bool) async throws -> Data {
        try await send("POST", base, path, body, mail: mail)
    }

    private func send(_ method: String, _ base: URL, _ path: String, _ body: Any?, query: [URLQueryItem] = [], mail: Bool) async throws -> Data {
        let token = try accessToken()
        let request = try APIRequest.json(method, url: APIRequest.url(base, path, query: query), token: token, mailCookie: mail, body: body)
        return try await http.send(request).data
    }

    private func object(_ data: Data) throws -> [String: Any] {
        guard let object = try JSONSerialization.jsonObject(with: data) as? [String: Any] else {
            throw CumulusError.decode("The response was not a JSON object.")
        }
        return object
    }
}
