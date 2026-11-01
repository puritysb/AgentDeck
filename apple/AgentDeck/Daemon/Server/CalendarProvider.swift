#if os(macOS)
import Foundation

struct CalendarSnapshot: Sendable {
    var status: String
    var events: [CalendarEvent]?
    var fetchedAt: Double?
    var revision = -1
    var owner: UUID?
}
struct CalendarReply: Sendable { var status: Int; var body: Data }
private final class CalendarNoRedirect: NSObject, URLSessionTaskDelegate, @unchecked Sendable {
    func urlSession(_ session: URLSession, task: URLSessionTask, willPerformHTTPRedirection response: HTTPURLResponse,
                    newRequest request: URLRequest, completionHandler: @escaping (URLRequest?) -> Void) { completionHandler(nil) }
}
struct CalendarTransport: Sendable {
    var request: @Sendable (URLRequest) async throws -> CalendarReply = { request in
        let config = URLSessionConfiguration.ephemeral
        config.urlCache = nil; config.httpCookieStorage = nil; config.urlCredentialStorage = nil; config.httpShouldSetCookies = false
        config.timeoutIntervalForRequest = request.timeoutInterval; config.timeoutIntervalForResource = request.timeoutInterval
        let session = URLSession(configuration: config, delegate: CalendarNoRedirect(), delegateQueue: nil)
        defer { session.invalidateAndCancel() }
        let (bytes, response) = try await session.bytes(for: request)
        guard let response = response as? HTTPURLResponse, response.statusCode == 200 else { throw CalendarICS.Failure.invalid }
        var data = Data()
        for try await byte in bytes { guard data.count < CalendarPolicy.maxBodyBytes else { throw CalendarICS.Failure.limit }; data.append(byte) }
        return .init(status: response.statusCode, body: data)
    }
    func fetch(_ cfg: CalendarConfiguration, nowMs: Double, zone: String) async throws -> [CalendarICS.Event] {
        let started = ContinuousClock.now
        var events: [CalendarICS.Event] = []
        for (index, raw) in cfg.urls.enumerated() {
            try Task.checkCancellation()
            let elapsed = started.duration(to: .now).components
            let remaining = Double(CalendarPolicy.timeoutMs) / 1000 - Double(elapsed.seconds) - Double(elapsed.attoseconds) / 1e18
            guard remaining > 0, let url = URL(string: raw) else { throw CalendarICS.Failure.invalid }
            var req = URLRequest(url: url, cachePolicy: .reloadIgnoringLocalCacheData, timeoutInterval: remaining)
            req.setValue("text/calendar", forHTTPHeaderField: "Accept")
            let reply = try await request(req)
            try Task.checkCancellation()
            guard reply.status == 200, reply.body.count <= CalendarPolicy.maxBodyBytes, let text = String(data: reply.body, encoding: .utf8) else { throw CalendarICS.Failure.invalid }
            events += try CalendarICS.parse(text, namespace: String(index))
            guard events.count <= CalendarPolicy.maxEvents else { throw CalendarICS.Failure.limit }
        }
        _ = try CalendarICS.build(events, nowMs: nowMs, zone: zone)
        try Task.checkCancellation()
        return events
    }
}
@DaemonActor
final class CalendarProvider {
    static let shared = CalendarProvider()
    private let connection: CalendarConnection
    private let transport: CalendarTransport
    private var activeRevision = -1, serial = 0
    private var owner: UUID?
    private var cache: (at: Double, events: [CalendarICS.Event])?
    private var job: (id: Int, at: Double, task: Task<[CalendarICS.Event], Error>)?
    private var failedAt: Double?
    private var observer: UUID?
    private(set) var status = "disabled"
    init(connection: CalendarConnection = .shared, transport: CalendarTransport = .init()) { self.connection = connection; self.transport = transport }
    func freshness(nowMs: Double = Date().timeIntervalSince1970 * 1000) -> String {
        guard connection.grant.accepts(activeRevision) else { return "disabled" }
        guard status != "unknown", let cache else { return status }
        let age = nowMs - cache.at
        if age < 0 || age >= Double(CalendarPolicy.staleMs) { return "unknown" }
        return age < Double(CalendarPolicy.cacheMs) ? "fresh" : "stale"
    }
    func stop(owner expected: UUID? = nil) {
        if let expected, owner != expected { return }
        clear(); activeRevision = -1; owner = nil; status = "disabled"
    }
    private func clear() {
        serial += 1; job?.task.cancel(); job = nil; cache = nil; failedAt = nil
        connection.grant.remove(observer); observer = nil
    }
    func accepts(_ snapshot: CalendarSnapshot) -> Bool { snapshot.events == nil || (snapshot.owner == owner && connection.grant.accepts(snapshot.revision)) }
    func events(_ snapshot: CalendarSnapshot) -> [CalendarEvent]? { accepts(snapshot) ? snapshot.events : nil }
    func snapshot(nowMs: Double = Date().timeIntervalSince1970 * 1000, zone: String = TimeZone.current.identifier, owner requestedOwner: UUID? = nil) async -> CalendarSnapshot {
        if let requestedOwner, owner != requestedOwner { stop(); owner = requestedOwner }
        let revision: Int, cfg: CalendarConfiguration?
        do { (revision, cfg) = try await connection.snapshot() }
        catch {
            guard requestedOwner == nil || requestedOwner == owner else { return .init(status: "disabled") }
            clear(); status = "unknown"; return .init(status: status)
        }
        guard requestedOwner == nil || requestedOwner == owner else { return .init(status: "disabled") }
        guard let cfg else { stop(owner: requestedOwner); return .init(status: "disabled") }
        if activeRevision != revision { clear(); activeRevision = revision }
        guard connection.grant.accepts(revision) else { return .init(status: "disabled") }
        if observer == nil {
            observer = connection.grant.observe(revision) { [weak self] in
                Task { @DaemonActor in if self?.activeRevision == revision { self?.stop() } }
            }
        }
        let age = cache.map { nowMs - $0.at } ?? .infinity
        let retry = failedAt.map { nowMs >= $0 && nowMs - $0 < Double(CalendarPolicy.retryMs) } ?? false
        if !(age >= 0 && age < Double(CalendarPolicy.cacheMs)) && !retry {
            if job == nil {
                serial += 1
                let transport = transport
                let worker = Task.detached(priority: .utility) { try await transport.fetch(cfg, nowMs: nowMs, zone: cfg.timeZone ?? zone) }
                job = (serial, nowMs, worker)
            }
            let pending = job!, ticket = serial
            let cancel = connection.grant.observe(revision) { pending.task.cancel() }
            defer { connection.grant.remove(cancel) }
            do {
                let data = try await pending.task.value
                if ticket == serial, connection.grant.accepts(revision) { cache = (pending.at, data); failedAt = nil; job = nil }
            } catch {
                if ticket == serial, connection.grant.accepts(revision) { failedAt = pending.at; job = nil }
            }
        }
        guard requestedOwner == nil || requestedOwner == owner else { return .init(status: "disabled") }
        guard activeRevision == revision, connection.grant.accepts(revision) else { return .init(status: "disabled") }
        guard let cache, nowMs >= cache.at, nowMs - cache.at < Double(CalendarPolicy.staleMs) else { status = "unknown"; return .init(status: status, revision: revision) }
        do {
            let data = cache.events, display = cfg.timeZone ?? zone
            let events = try await Task.detached(priority: .utility) { try CalendarICS.build(data, nowMs: nowMs, zone: display) }.value
            guard (requestedOwner == nil || requestedOwner == owner), connection.grant.accepts(revision), activeRevision == revision else { return .init(status: "disabled") }
            status = nowMs - cache.at < Double(CalendarPolicy.cacheMs) ? "fresh" : "stale"
            return .init(status: status, events: events, fetchedAt: cache.at, revision: revision, owner: owner)
        } catch {
            guard (requestedOwner == nil || requestedOwner == owner), activeRevision == revision, connection.grant.accepts(revision) else { return .init(status: "disabled") }
            status = "unknown"; return .init(status: status, revision: revision)
        }
    }
}
#endif
