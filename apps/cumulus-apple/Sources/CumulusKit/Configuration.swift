import Foundation

/// API origins for the Cumulus apps. Read from a JSON file or the process environment.
/// No client secret belongs here. The Apple client is a public PKCE client.
public struct CumulusConfiguration: Codable, Equatable, Sendable {
    public var idOrigin: URL
    public var issuer: URL
    public var clientID: String
    public var redirectURI: URL
    public var scopes: [String]
    public var mailAPI: URL
    public var cloudAPI: URL
    public var exchangeAPI: URL
    public var downloadPage: URL
    /// Cognito hosted UI hostname, without a scheme. Nil keeps the Keycloak issuer paths.
    public var cognitoDomain: String?
    public var cognitoRegion: String?
    public var cognitoUserPoolID: String?

    public init(
        idOrigin: URL,
        issuer: URL,
        clientID: String,
        redirectURI: URL,
        scopes: [String],
        mailAPI: URL,
        cloudAPI: URL,
        exchangeAPI: URL,
        downloadPage: URL,
        cognitoDomain: String? = nil,
        cognitoRegion: String? = nil,
        cognitoUserPoolID: String? = nil
    ) throws {
        self.idOrigin = idOrigin
        self.issuer = issuer
        self.clientID = clientID
        self.redirectURI = redirectURI
        self.scopes = scopes
        self.mailAPI = mailAPI
        self.cloudAPI = cloudAPI
        self.exchangeAPI = exchangeAPI
        self.downloadPage = downloadPage
        self.cognitoDomain = cognitoDomain?.nilIfEmpty
        self.cognitoRegion = cognitoRegion?.nilIfEmpty
        self.cognitoUserPoolID = cognitoUserPoolID?.nilIfEmpty
        try validate()
    }

    public static let production = try! CumulusConfiguration(
        idOrigin: URL(string: "https://id.cumuluscloud.app")!,
        issuer: URL(string: "https://id.cumuluscloud.app/realms/cumulus")!,
        clientID: "cumulus-apple",
        redirectURI: URL(string: "cumulus://oauth/callback")!,
        scopes: ["openid", "email", "profile"],
        mailAPI: URL(string: "https://mail.cumuluscloud.app")!,
        cloudAPI: URL(string: "https://cloud.cumuluscloud.app")!,
        exchangeAPI: URL(string: "https://cloud.cumuluscloud.app")!,
        downloadPage: URL(string: "https://cumuluscloud.app")!
    )

    public var usesCognito: Bool {
        cognitoDomain != nil && cognitoRegion != nil && cognitoUserPoolID != nil
    }

    public var authorizationEndpoint: URL {
        if usesCognito {
            return URL(string: "https://\(cognitoDomain!)/oauth2/authorize")!
        }
        return endpoint("protocol/openid-connect/auth")
    }

    public var tokenEndpoint: URL {
        if usesCognito {
            return URL(string: "https://\(cognitoDomain!)/oauth2/token")!
        }
        return endpoint("protocol/openid-connect/token")
    }

    public var userInfoEndpoint: URL {
        if usesCognito {
            return URL(string: "https://\(cognitoDomain!)/oauth2/userInfo")!
        }
        return endpoint("protocol/openid-connect/userinfo")
    }

    private func endpoint(_ path: String) -> URL {
        let base = issuer.absoluteString.trimmingCharacters(in: CharacterSet(charactersIn: "/"))
        return URL(string: base + "/" + path)!
    }

    /// Cognito's issuer is the user-pool URL, not the hosted UI.
    public var expectedIssuer: String {
        if usesCognito {
            return "https://cognito-idp.\(cognitoRegion!).amazonaws.com/\(cognitoUserPoolID!)"
        }
        return issuer.absoluteString.trimmingCharacters(in: CharacterSet(charactersIn: "/"))
    }

    public static func load(data: Data) throws -> CumulusConfiguration {
        let decoded = try JSONDecoder().decode(File.self, from: data)
        return try CumulusConfiguration(
            idOrigin: try url(decoded.idOrigin, name: "idOrigin"),
            issuer: try url(decoded.issuer, name: "issuer"),
            clientID: decoded.clientID,
            redirectURI: try url(decoded.redirectURI, name: "redirectURI", allowCumulusScheme: true),
            scopes: decoded.scopes ?? ["openid", "email", "profile"],
            mailAPI: try url(decoded.mailAPI, name: "mailAPI"),
            cloudAPI: try url(decoded.cloudAPI, name: "cloudAPI"),
            exchangeAPI: try url(decoded.exchangeAPI, name: "exchangeAPI"),
            downloadPage: try url(decoded.downloadPage, name: "downloadPage"),
            cognitoDomain: decoded.cognitoDomain,
            cognitoRegion: decoded.cognitoRegion,
            cognitoUserPoolID: decoded.cognitoUserPoolID
        )
    }

    public static func load(environment: [String: String]) throws -> CumulusConfiguration {
        func value(_ key: String, _ fallback: String) -> String {
            let raw = environment[key]?.trimmingCharacters(in: .whitespacesAndNewlines) ?? ""
            return raw.isEmpty ? fallback : raw
        }
        let base = CumulusConfiguration.production
        return try CumulusConfiguration(
            idOrigin: try url(value("CUMULUS_ID_ORIGIN", base.idOrigin.absoluteString), name: "CUMULUS_ID_ORIGIN"),
            issuer: try url(value("CUMULUS_ISSUER", base.issuer.absoluteString), name: "CUMULUS_ISSUER"),
            clientID: value("CUMULUS_CLIENT_ID", base.clientID),
            redirectURI: try url(value("CUMULUS_REDIRECT_URI", base.redirectURI.absoluteString), name: "CUMULUS_REDIRECT_URI", allowCumulusScheme: true),
            scopes: value("CUMULUS_SCOPES", base.scopes.joined(separator: " ")).split(separator: " ").map(String.init),
            mailAPI: try url(value("CUMULUS_MAIL_API", base.mailAPI.absoluteString), name: "CUMULUS_MAIL_API"),
            cloudAPI: try url(value("CUMULUS_CLOUD_API", base.cloudAPI.absoluteString), name: "CUMULUS_CLOUD_API"),
            exchangeAPI: try url(value("CUMULUS_EXCHANGE_API", base.exchangeAPI.absoluteString), name: "CUMULUS_EXCHANGE_API"),
            downloadPage: try url(value("CUMULUS_DOWNLOAD_PAGE", base.downloadPage.absoluteString), name: "CUMULUS_DOWNLOAD_PAGE"),
            cognitoDomain: environment["CUMULUS_COGNITO_DOMAIN"],
            cognitoRegion: environment["CUMULUS_COGNITO_REGION"],
            cognitoUserPoolID: environment["CUMULUS_COGNITO_USER_POOL_ID"]
        )
    }

    private func validate() throws {
        if clientID.trimmingCharacters(in: .whitespaces).isEmpty {
            throw CumulusError.configuration("clientID is empty.")
        }
        if scopes.isEmpty { throw CumulusError.configuration("scopes is empty.") }
        for url in [idOrigin, issuer, mailAPI, cloudAPI, exchangeAPI, downloadPage] {
            try Self.rejectForbidden(url)
            guard url.scheme?.lowercased() == "https" else {
                throw CumulusError.configuration("\(url.absoluteString) must use https.")
            }
            guard url.user == nil, url.password == nil else {
                throw CumulusError.configuration("\(url.absoluteString) must not include credentials.")
            }
        }
        try Self.rejectForbidden(redirectURI)
        let scheme = redirectURI.scheme?.lowercased()
        guard scheme == "https" || scheme == "cumulus" else {
            throw CumulusError.configuration("redirectURI must be https or cumulus.")
        }
        if usesCognito {
            let domain = cognitoDomain!
            if domain.contains("://") || domain.contains("/") || domain.contains("*") {
                throw CumulusError.configuration("cognitoDomain must be a hostname.")
            }
            guard cognitoRegion?.isEmpty == false, cognitoUserPoolID?.isEmpty == false else {
                throw CumulusError.configuration("Cognito needs a region and a user pool id.")
            }
        } else if cognitoDomain != nil || cognitoRegion != nil || cognitoUserPoolID != nil {
            throw CumulusError.configuration("Cognito sign-in needs the domain, region, and user pool id together.")
        }
    }

    private static func url(_ raw: String, name: String, allowCumulusScheme: Bool = false) throws -> URL {
        guard let url = URL(string: raw), url.scheme != nil, url.host != nil || allowCumulusScheme else {
            throw CumulusError.configuration("\(name) is not a URL.")
        }
        try rejectForbidden(url)
        return url
    }

    private static func rejectForbidden(_ url: URL) throws {
        let text = url.absoluteString.lowercased()
        if text.contains("infinitumcorporation.ai") || (url.host ?? "").lowercased().contains("infinitumcorporation.ai") {
            throw CumulusError.configuration("That host is not a Cumulus API.")
        }
    }

    private struct File: Decodable {
        var idOrigin: String
        var issuer: String
        var clientID: String
        var redirectURI: String
        var scopes: [String]?
        var mailAPI: String
        var cloudAPI: String
        var exchangeAPI: String
        var downloadPage: String
        var cognitoDomain: String?
        var cognitoRegion: String?
        var cognitoUserPoolID: String?
    }
}

private extension String {
    var nilIfEmpty: String? {
        let trimmed = trimmingCharacters(in: .whitespacesAndNewlines)
        return trimmed.isEmpty ? nil : trimmed
    }
}

public enum CumulusError: Error, Equatable, CustomStringConvertible {
    case configuration(String)
    case pkce(String)
    case oidc(String)
    case api(status: Int, message: String, code: String?)
    case transport(String)
    case decode(String)

    public var description: String {
        switch self {
        case .configuration(let message), .pkce(let message), .oidc(let message), .transport(let message), .decode(let message):
            return message
        case .api(_, let message, _):
            return message
        }
    }
}
