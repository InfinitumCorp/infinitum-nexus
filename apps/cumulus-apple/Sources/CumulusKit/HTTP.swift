import Foundation
#if canImport(FoundationNetworking)
import FoundationNetworking
#endif

public protocol HTTPTransport: AnyObject {
    func send(_ request: URLRequest) async throws -> (Data, HTTPURLResponse)
}

public final class URLSessionTransport: HTTPTransport {
    public init() {}

    public func send(_ request: URLRequest) async throws -> (Data, HTTPURLResponse) {
        let (data, response) = try await URLSession.shared.data(for: request)
        guard let http = response as? HTTPURLResponse else {
            throw CumulusError.transport("The server did not return an HTTP response.")
        }
        return (data, http)
    }
}

public struct HTTPResult: Sendable {
    public let status: Int
    public let data: Data
}

public final class HTTPClient {
    public let transport: HTTPTransport

    public init(transport: HTTPTransport = URLSessionTransport()) {
        self.transport = transport
    }

    public func send(_ request: URLRequest) async throws -> HTTPResult {
        let (data, response) = try await transport.send(request)
        if response.statusCode >= 400 {
            throw CumulusError.api(status: response.statusCode, message: Self.message(data, status: response.statusCode), code: Self.code(data))
        }
        return HTTPResult(status: response.statusCode, data: data)
    }

    public static func message(_ data: Data, status: Int) -> String {
        if let object = try? JSONSerialization.jsonObject(with: data) as? [String: Any],
           let error = object["error"] as? String, !error.isEmpty {
            return error
        }
        return "The request failed (\(status))."
    }

    public static func code(_ data: Data) -> String? {
        guard let object = try? JSONSerialization.jsonObject(with: data) as? [String: Any] else { return nil }
        return object["code"] as? String
    }

    public static func decode<T: Decodable>(_ type: T.Type, from data: Data) throws -> T {
        let decoder = JSONDecoder()
        decoder.keyDecodingStrategy = .useDefaultKeys
        do {
            return try decoder.decode(T.self, from: data)
        } catch {
            throw CumulusError.decode("The response did not match \(T.self).")
        }
    }
}

public enum APIRequest {
    public static func json(_ method: String, url: URL, token: String?, mailCookie: Bool, body: Any? = nil) throws -> URLRequest {
        var request = URLRequest(url: url)
        request.httpMethod = method
        request.setValue("application/json", forHTTPHeaderField: "Accept")
        if let token, !token.isEmpty {
            request.setValue("Bearer \(token)", forHTTPHeaderField: "Authorization")
            if mailCookie {
                request.setValue("cmail_session=\(token)", forHTTPHeaderField: "Cookie")
            }
        }
        if method != "GET" && method != "HEAD" {
            request.setValue("1", forHTTPHeaderField: "X-Cumulus")
        }
        if let body {
            request.setValue("application/json", forHTTPHeaderField: "Content-Type")
            guard JSONSerialization.isValidJSONObject(body) else {
                throw CumulusError.decode("The request body is not JSON.")
            }
            request.httpBody = try JSONSerialization.data(withJSONObject: body)
        }
        return request
    }

    public static func url(_ base: URL, _ path: String, query: [URLQueryItem] = []) -> URL {
        let trimmed = base.absoluteString.trimmingCharacters(in: CharacterSet(charactersIn: "/"))
        let suffix = path.hasPrefix("/") ? path : "/" + path
        var components = URLComponents(string: trimmed + suffix)!
        if !query.isEmpty { components.queryItems = query }
        return components.url!
    }
}
