import Foundation

struct Directive: Decodable {
    let revision: String
    let capture: Bool
    let inputDevice: String
    let roster: [String]
}

struct Hello: Encodable {
    let version = "1.0"
    let backend = "fluidaudio"
    let devices = Array(Device.inputs().prefix(64))
    let modelLoaded: Bool
    let primingAvailable: Bool
    let microphone: String
}

final class Daemon: NSObject, URLSessionTaskDelegate {
    let base: URL
    let token: String
    let directory: URL
    private lazy var session = URLSession(configuration: .ephemeral, delegate: self, delegateQueue: nil)

    override init() {
        let env = ProcessInfo.processInfo.environment
        guard let base = env["MISSION_VOICE_DAEMON_URL"].flatMap(URL.init(string:)), base.scheme == "http",
              ["localhost", "127.0.0.1", "[::1]"].contains(base.host?.lowercased() ?? ""),
              let file = env["MISSION_VOICE_TOKEN_FILE"], let token = try? String(contentsOfFile: file, encoding: .utf8),
              let models = env["MISSION_VOICE_MODEL_DIR"] else {
            fputs("Expected a loopback daemon URL, readable token file and model directory.\n", stderr)
            exit(1)
        }
        self.base = base
        self.token = token.trimmingCharacters(in: .whitespacesAndNewlines)
        directory = URL(fileURLWithPath: models)
    }

    func urlSession(_ session: URLSession, task: URLSessionTask, willPerformHTTPRedirection response: HTTPURLResponse,
                    newRequest request: URLRequest, completionHandler: @escaping (URLRequest?) -> Void) {
        completionHandler(nil)
    }

    func request(_ route: String, revision: String? = nil, body: Data? = nil) async throws -> Data {
        var url = base.appending(path: route)
        if let revision { url.append(queryItems: [URLQueryItem(name: "revision", value: revision)]) }
        var req = URLRequest(url: url, cachePolicy: .reloadIgnoringLocalCacheData, timeoutInterval: body == nil ? 30 : 5)
        req.setValue(token, forHTTPHeaderField: "x-harness-token")
        if let body {
            req.httpMethod = "POST"
            req.setValue("application/json", forHTTPHeaderField: "Content-Type")
            req.httpBody = body
        }
        let (data, response) = try await session.data(for: req)
        guard (response as? HTTPURLResponse)?.statusCode == 200 else { throw URLError(.badServerResponse) }
        return data
    }
}

@MainActor final class Listener {
    let daemon = Daemon()
    var recognizer: Recognizer?
    private var mic: Microphone?
    private var decoding: Task<Void, Never>?

    func hello() async throws {
        let status = permission()
        if status != "granted" { close() }
        let body = Hello(modelLoaded: recognizer != nil, primingAvailable: recognizer?.ctc != nil, microphone: status)
        defer {
            if status == "denied" {
                fputs("Microphone access denied by macOS.\n", stderr)
                exit(2)
            }
        }
        _ = try await daemon.request("voice/listener/hello", body: JSONEncoder().encode(body))
    }

    func close() {
        decoding?.cancel()
        decoding = nil
        mic?.stop()
        mic = nil
    }

    func run() async throws {
        try await hello()
        let heartbeat = Task {
            while !Task.isCancelled {
                try await Task.sleep(for: .seconds(10))
                do { try await hello() }
                catch { close(); exit(1) }
            }
        }
        defer { heartbeat.cancel(); close() }
        let recognizer = try await Recognizer(directory: daemon.directory)
        self.recognizer = recognizer
        try await hello()
        var revision: String?
        while true {
            let data = try await daemon.request("voice/listener/directive", revision: revision)
            let next = try JSONDecoder().decode(Directive.self, from: data)
            let capture = next.capture && permission() == "granted"
            if next.revision != revision || capture != (mic != nil) {
                close()
                if capture {
                    let microphone = try Microphone(selection: next.inputDevice)
                    mic = microphone
                    decoding = Task { [segments = microphone.segments] in
                        let boosting = try? await recognizer.prime(next.roster)
                        for await segment in segments {
                            do {
                                try Task.checkCancellation()
                                let words = try await recognizer.transcribe(segment, boosting: boosting)
                                try Task.checkCancellation()
                                if let words {
                                    _ = try await daemon.request("voice/utterances", body: JSONEncoder().encode(words))
                                }
                            } catch {
                                if Task.isCancelled { return }
                                fputs("Voice listener dropped one segment.\n", stderr)
                            }
                        }
                    }
                }
            }
            revision = next.revision
        }
    }
}

@main struct VoiceListener {
    @MainActor static func main() async {
        do { try await Listener().run() }
        catch { fputs("Voice listener stopped. Check the daemon, local models and selected input.\n", stderr); exit(1) }
    }
}
