import Foundation

enum CaptureError: Error { case device, format, listenerInUse }

struct Directive: Decodable {
    let revision: String
    let capture: Bool
    let inputDevice: String
    let roster: [String]
}

struct Hello: Encodable {
    let version = "3.0"
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
    private let listenerID = UUID().uuidString
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

    func request(_ route: String, revision: String? = nil, endedAt: Int64? = nil, body: Data? = nil) async throws -> (Data, HTTPURLResponse) {
        var url = base.appending(path: route)
        if let revision { url.append(queryItems: [URLQueryItem(name: "revision", value: revision)]) }
        var req = URLRequest(url: url, cachePolicy: .reloadIgnoringLocalCacheData, timeoutInterval: body == nil || endedAt != nil ? 30 : 5)
        req.setValue(token, forHTTPHeaderField: "x-harness-token")
        req.setValue(listenerID, forHTTPHeaderField: "x-voice-listener-id")
        if let endedAt { req.setValue(String(endedAt), forHTTPHeaderField: "x-voice-capture-ended-at") }
        if let body {
            req.httpMethod = "POST"
            req.setValue("application/json", forHTTPHeaderField: "Content-Type")
            req.httpBody = body
        }
        let (data, response) = try await session.data(for: req)
        if (response as? HTTPURLResponse)?.statusCode == 409,
           (try? JSONDecoder().decode([String: String].self, from: data))?["error"] == "listener_in_use" {
            throw CaptureError.listenerInUse
        }
        guard let http = response as? HTTPURLResponse, http.statusCode == 200 else { throw URLError(.badServerResponse) }
        return (data, http)
    }

    func postUtterance(revision: String, endedAt: Int64, body: Data) async throws -> HTTPURLResponse {
        while true {
            try Task.checkCancellation()
            let (_, http) = try await request("voice/utterances", revision: revision, endedAt: endedAt, body: body)
            // A held POST waits up to 25 seconds for key-up. Retry the identical
            // text and id if the daemon still lacks a confirmed release boundary.
            if http.value(forHTTPHeaderField: "x-voice-held-revision") != revision { return http }
        }
    }
}

@MainActor final class Listener {
    let daemon = Daemon()
    var recognizer: Recognizer?
    private var mic: Microphone?
    private var decoding: Task<Void, Never>?
    private var directivePoll: Task<(Data, HTTPURLResponse), Error>?
    private var releasedAt: Int64?
    private var finalSegment: Segment?
    private var pendingHello: Task<Void, Error>?

    func hello() async throws {
        let previous = pendingHello
        let send = Task {
            try await previous?.value
            try await sendHello()
        }
        pendingHello = send
        try await send.value
    }

    private func sendHello() async throws {
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
        releasedAt = nil
        finalSegment = nil
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
            let poll = Task { [revision] in try await daemon.request("voice/listener/directive", revision: revision) }
            directivePoll = poll
            let response = await poll.result
            directivePoll = nil
            if poll.isCancelled {
                // A hardware change interrupted the long poll. Get current settings before reopening.
                revision = nil
                continue
            }
            let (data, http) = try response.get()
            let next = try JSONDecoder().decode(Directive.self, from: data)
            let capture = next.capture && permission() == "granted"
            if next.revision != revision || (capture ? mic?.isRunning != true : mic != nil && releasedAt == nil) {
                if !next.capture, permission() == "granted", let revision,
                   http.value(forHTTPHeaderField: "x-voice-release-revision") == revision,
                   let time = http.value(forHTTPHeaderField: "x-voice-release-at").flatMap(Int64.init) {
                    releasedAt = time
                    if let input = mic {
                        input.whenCaptured(through: time) { [weak self, weak input] in
                            guard let self, let input, self.mic === input else { return }
                            self.finalSegment = input.stop(releasedAt: time)
                            self.mic = nil
                        }
                    }
                } else {
                    close()
                }
                if capture {
                    let microphone = try Microphone(selection: next.inputDevice) { [weak self] stopped in
                        guard let self, self.mic === stopped else { return }
                        self.close()
                        self.directivePoll?.cancel()
                    }
                    mic = microphone
                    decoding = Task { [segments = microphone.segments] in
                        let boosting = try? await recognizer.prime(next.roster)
                        @MainActor func deliver(_ buffered: Segment) async {
                            do {
                                var segment = buffered
                                var daemonCutoff: Int64?
                                while !Task.isCancelled {
                                    if let cutoff = daemonCutoff ?? releasedAt, segment.endedAt > cutoff {
                                        guard let clipped = segment.through(cutoff) else { return }
                                        segment = clipped
                                    }
                                    let words = try await recognizer.transcribe(segment, boosting: boosting)
                                    try Task.checkCancellation()
                                    // Key-up may have arrived during this very decode.
                                    if let releasedAt, segment.endedAt > releasedAt { continue }
                                    guard let words else { return }
                                    let http = try await daemon.postUtterance(revision: next.revision,
                                        endedAt: segment.endedAt, body: JSONEncoder().encode(words))
                                    // The POST can also beat the key-up directive back to the helper.
                                    guard http.value(forHTTPHeaderField: "x-voice-release-revision") == next.revision,
                                          let cutoff = http.value(forHTTPHeaderField: "x-voice-release-at").flatMap(Int64.init),
                                          segment.endedAt > cutoff else { return }
                                    daemonCutoff = cutoff
                                }
                            } catch {
                                if Task.isCancelled { return }
                                fputs("Voice listener dropped one segment.\n", stderr)
                            }
                        }
                        for await segment in segments {
                            if Task.isCancelled { return }
                            await deliver(segment)
                        }
                        if !Task.isCancelled, let finalSegment {
                            self.finalSegment = nil
                            await deliver(finalSegment)
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
        catch CaptureError.listenerInUse { fputs("Another voice listener is active.\n", stderr); exit(1) }
        catch CaptureError.device { fputs("The selected microphone input is unavailable.\n", stderr); exit(1) }
        catch { fputs("Voice listener stopped. Check the daemon, local models and selected input.\n", stderr); exit(1) }
    }
}
