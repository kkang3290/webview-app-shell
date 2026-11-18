import AVFoundation
import Foundation

struct ScreenReplayCredentials: Codable, Sendable {
    let uploadUrl: String
    let serverNow: String
    var clockOffset: TimeInterval?
}
struct ScreenReplayClip: Codable, Sendable {
    let seq: Int
    let startedAt: String
    let durationMs: Int
    let filename: String
}
struct ScreenReplayJournal: Codable, Sendable {
    let credentials: ScreenCredentials
    var clips: [ScreenReplayClip] = []
    var complete = false
    var failed = false
}

enum ScreenReplayReceipt {
    private struct Clip: Decodable { let seq: Int; let bytes: Int64 }
    private struct Finished: Decodable { let finished: Bool }
    static func valid(_ data: Data, seq: Int?, bytes: Int64?) -> Bool {
        guard data.count <= 4096, (seq == nil) == (bytes == nil) else { return false }
        if let seq, let bytes {
            guard let result = try? JSONDecoder().decode(Clip.self, from: data) else { return false }
            return result.seq == seq && result.bytes == bytes
        }
        return (try? JSONDecoder().decode(Finished.self, from: data))?.finished == true
    }
}

/** 前台 App 与广播扩展共用：分段先落盘（App Group 目录），扩展退出后由 App 补传。协议见 docs/screen-capture.md。 */
actor ScreenReplayUploads {
    static let shared = ScreenReplayUploads()
    private var busy = Set<String>()
    private var again = Set<String>()
    func drain(_ id: String) async throws {
        guard !busy.contains(id) else { again.insert(id); return }
        busy.insert(id)
        defer {
            busy.remove(id)
            if again.remove(id) != nil { Task { try? await drain(id) } }
        }
        let name = "\(id).archive.json"
        var journal = try ScreenLeaseStore.read(ScreenReplayJournal.self, name)
        for clip in journal.clips {
            let file = try ScreenLeaseStore.file(clip.filename)
            if !FileManager.default.fileExists(atPath: file.path) { continue }
            try await upload(journal.credentials, clip: clip, file: file, final: nil)
            try FileManager.default.removeItem(at: file)
        }
        // Re-read: the recorder can append a new durable clip while HTTP is in flight.
        journal = try ScreenLeaseStore.read(ScreenReplayJournal.self, name)
        let pending = journal.clips.contains { clip in
            guard let url = try? ScreenLeaseStore.file(clip.filename) else { return true }
            return FileManager.default.fileExists(atPath: url.path)
        }
        if journal.complete && !pending {
            try await upload(journal.credentials, clip: nil, file: nil, final: (journal.clips.count, journal.failed))
            try ScreenLeaseStore.write(true, "\(id).archive-done")
            ScreenLeaseStore.remove(name)
        }
    }
    func recover() async {
        guard let directory = ScreenLeaseStore.directory,
              let names = try? FileManager.default.contentsOfDirectory(atPath: directory.path) else { return }
        for name in names where name.hasSuffix(".archive.json") {
            let id = String(name.dropLast(".archive.json".count))
            try? await drain(id)
        }
    }
    private func upload(_ credentials: ScreenCredentials, clip: ScreenReplayClip?, file: URL?, final: (Int, Bool)?) async throws {
        guard credentials.valid, let replay = credentials.replay,
              var parts = URLComponents(string: replay.uploadUrl) else { throw URLError(.badURL) }
        var query = [URLQueryItem(name: "publisherId", value: credentials.publisherId)]
        if let clip {
            query += [URLQueryItem(name: "seq", value: String(clip.seq)), URLQueryItem(name: "startedAt", value: clip.startedAt), URLQueryItem(name: "durationMs", value: String(clip.durationMs))]
        }
        if let final {
            query += [URLQueryItem(name: "seq", value: String(final.0)), URLQueryItem(name: "finish", value: "1"), URLQueryItem(name: "failed", value: final.1 ? "1" : "0")]
        }
        parts.queryItems = query
        guard let url = parts.url else { throw URLError(.badURL) }
        var request = URLRequest(url: url, timeoutInterval: 20)
        request.httpMethod = "POST"; request.setValue("video/mp4", forHTTPHeaderField: "Content-Type")
        request.setValue(credentials.leaseToken, forHTTPHeaderField: "X-Screen-Lease")
        let session = URLSession(configuration: .ephemeral, delegate: ScreenNoRedirect(), delegateQueue: nil)
        defer { session.finishTasksAndInvalidate() }
        let bytes = try file.map { url -> Int64 in
            let attributes = try FileManager.default.attributesOfItem(atPath: url.path)
            guard let size = attributes[.size] as? NSNumber else { throw URLError(.cannotOpenFile) }
            return size.int64Value
        }
        for attempt in 0..<3 {
            do {
                let response: URLResponse
                let data: Data
                if let file { (data, response) = try await session.upload(for: request, fromFile: file) }
                else { (data, response) = try await session.data(for: request) }
                guard let http = response as? HTTPURLResponse, (200..<300).contains(http.statusCode) else { throw URLError(.badServerResponse) }
                guard ScreenReplayReceipt.valid(data, seq: clip?.seq, bytes: bytes) else { throw URLError(.badServerResponse) }
                return
            } catch {
                if attempt == 2 { throw error }
                try await Task.sleep(nanoseconds: UInt64(attempt + 1) * 500_000_000)
            }
        }
    }
}

/** A bounded video-only encoder. Each file is independently decodable after extension exit. */
final class ScreenReplayEncoder {
    let writer: AVAssetWriter
    private let input: AVAssetWriterInput
    let firstTime: CMTime
    private var lastTime: CMTime
    init(url: URL, dimensions: CMVideoDimensions, firstTime: CMTime) throws {
        self.firstTime = firstTime; lastTime = firstTime
        writer = try AVAssetWriter(outputURL: url, fileType: .mp4)
        input = AVAssetWriterInput(mediaType: .video, outputSettings: [AVVideoCodecKey: AVVideoCodecType.h264,
            AVVideoWidthKey: Int(dimensions.width), AVVideoHeightKey: Int(dimensions.height),
            AVVideoCompressionPropertiesKey: [AVVideoAverageBitRateKey: 1_800_000, AVVideoMaxKeyFrameIntervalDurationKey: 2]])
        input.expectsMediaDataInRealTime = true
        guard writer.canAdd(input) else { throw URLError(.cannotCreateFile) }
        writer.add(input); guard writer.startWriting() else { throw writer.error ?? URLError(.cannotCreateFile) }
        writer.startSession(atSourceTime: firstTime)
    }
    func append(_ sample: CMSampleBuffer) throws {
        guard input.isReadyForMoreMediaData else { return }
        guard input.append(sample) else { throw writer.error ?? URLError(.cannotWriteToFile) }
        lastTime = CMSampleBufferGetPresentationTimeStamp(sample)
    }
    func finish(duration: TimeInterval) async throws -> TimeInterval {
        let length = max(1.0 / 30, duration, CMTimeGetSeconds(lastTime - firstTime) + 1.0 / 30)
        writer.endSession(atSourceTime: firstTime + CMTime(seconds: length, preferredTimescale: 600))
        input.markAsFinished(); await writer.finishWriting()
        guard writer.status == .completed else { throw writer.error ?? URLError(.cannotWriteToFile) }
        return length
    }
}

/** Video only: microphone/system/private-call audio must never enter this archive. */
final class ScreenReplayRecorder {
    private let credentials: ScreenCredentials
    private var journal: ScreenReplayJournal
    private var encoder: ScreenReplayEncoder?
    private var firstTime = CMTime.invalid
    private var firstDate = Date()
    private var size = CMVideoDimensions(width: 0, height: 0)
    private let clockOffset: TimeInterval
    private var lastSample: CMSampleBuffer?
    private var sampledAt = Date()
    private var closed = false
    private var finishing = false
    init(credentials: ScreenCredentials) throws {
        self.credentials = credentials; journal = ScreenReplayJournal(credentials: credentials)
        guard let replay = credentials.replay, let now = ScreenReplayRecorder.formatter.date(from: replay.serverNow) else { throw URLError(.badServerResponse) }
        clockOffset = replay.clockOffset ?? now.timeIntervalSinceNow
        try persist()
    }
    private static var formatter: ISO8601DateFormatter {
        let formatter = ISO8601DateFormatter(); formatter.formatOptions = [.withInternetDateTime, .withFractionalSeconds]; return formatter
    }
    private func persist() throws { try ScreenLeaseStore.write(journal, "\(credentials.publisherId).archive.json") }
    func append(_ sample: CMSampleBuffer) async throws {
        do {
        guard !closed, !finishing, let format = sample.formatDescription else { return }
        let time = CMSampleBufferGetPresentationTimeStamp(sample), nextSize = format.dimensions
        if encoder != nil && (CMTimeGetSeconds(time - firstTime) >= 5 || size.width != nextSize.width || size.height != nextSize.height) { try await finishClip(until: time) }
        guard !closed else { return }
        if encoder == nil {
            let pending = journal.clips.filter { (try? FileManager.default.fileExists(atPath: ScreenLeaseStore.file($0.filename).path)) == true }.count
            guard pending < 12 else { throw URLError(.cannotWriteToFile) }
            let file = try ScreenLeaseStore.file("\(credentials.publisherId)-\(journal.clips.count).mp4")
            try? FileManager.default.removeItem(at: file)
            encoder = try ScreenReplayEncoder(url: file, dimensions: nextSize, firstTime: time)
            firstTime = time
            firstDate = Date().addingTimeInterval(clockOffset); size = nextSize
        }
        try encoder?.append(sample)
        lastSample = sample; sampledAt = Date()
        } catch {
            journal.failed = true; try? persist(); throw error
        }
    }
    func tick() async throws {
        guard !closed, !finishing else { return }
        if encoder != nil && Date().addingTimeInterval(clockOffset).timeIntervalSince(firstDate) >= 5 { try await finishClip() }
        // ReplayKit may deliver no new buffers for a static page. Preserve the last
        // public screen instead of leaving an unrecorded gap until the next redraw.
        if encoder == nil, let lastSample, !closed {
            var timing = CMSampleTimingInfo(duration: CMTime(value: 1, timescale: 30),
                presentationTimeStamp: CMSampleBufferGetPresentationTimeStamp(lastSample) + CMTime(seconds: Date().timeIntervalSince(sampledAt), preferredTimescale: 600), decodeTimeStamp: .invalid)
            var copy: CMSampleBuffer?
            guard CMSampleBufferCreateCopyWithNewTiming(allocator: nil, sampleBuffer: lastSample, sampleTimingEntryCount: 1, sampleTimingArray: &timing, sampleBufferOut: &copy) == noErr, let copy else { throw URLError(.cannotDecodeContentData) }
            try await append(copy)
        }
    }
    private func finishClip(until: CMTime? = nil) async throws {
        guard !finishing, let encoder else { return }
        finishing = true; defer { finishing = false }
        self.encoder = nil
        let elapsed = until.map { CMTimeGetSeconds($0 - firstTime) } ?? Date().addingTimeInterval(clockOffset).timeIntervalSince(firstDate)
        let duration: TimeInterval
        do { duration = try await encoder.finish(duration: elapsed) }
        catch { journal.failed = true; try? persist(); throw error }
        journal.clips.append(ScreenReplayClip(seq: journal.clips.count, startedAt: Self.formatter.string(from: firstDate), durationMs: Int((duration * 1000).rounded()), filename: encoder.writer.outputURL.lastPathComponent))
        try persist()
        let id = credentials.publisherId
        Task { try? await ScreenReplayUploads.shared.drain(id) }
    }
    func finish() async throws {
        guard !closed else { return }; closed = true
        while finishing { try await Task.sleep(nanoseconds: 10_000_000) }
        do { try await finishClip() } catch { journal.failed = true }
        journal.complete = true; try persist()
        let id = credentials.publisherId
        Task { try? await ScreenReplayUploads.shared.drain(id) }
    }
}
