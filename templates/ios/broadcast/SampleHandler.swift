import ImageIO
import HaishinKit
import Logboard
import ReplayKit
import RTMPHaishinKit
import VideoToolbox

/** 广播上传扩展（screenCapture）：只推画面，不碰声音。租约与推流地址由主 App 经 App Group 交过来。 */
final class SampleHandler: RPBroadcastSampleHandler, @unchecked Sendable {
    private let lock = NSLock()
    private var framePending = false
    private var publisher: ScreenPublisher?

    override func broadcastStarted(withSetupInfo setupInfo: [String: NSObject]?) {
        LBLogger.with(kHaishinKitIdentifier).appender = NullAppender.shared
        LBLogger.with(kRTMPHaishinKitIdentifier).appender = NullAppender.shared
        do {
            let lease = try ScreenLeaseStore.read(ScreenCredentials.self, "pending.json")
            ScreenLeaseStore.remove("pending.json")
            guard lease.valid, lease.expiry > Date() else { throw URLError(.userAuthenticationRequired) }
            try ScreenLeaseStore.write(lease, "active.json")
            let next = ScreenPublisher(lease: lease) { [weak self] requested in
                if requested {
                    // Swift requires an Error, but ReplayKit accepts a nil NSError to stop silently.
                    // Use the public Objective-C selector; a code-0 NSError still shows an alert.
                    _ = self?.perform(#selector(RPBroadcastSampleHandler.finishBroadcastWithError(_:)), with: nil)
                } else {
                    self?.finishBroadcastWithError(NSError(domain: "AppShellScreen", code: 1, userInfo: [NSLocalizedDescriptionKey: AppShellScreenConfig.stoppedMessage]))
                }
            }
            publisher = next
            Task { await next.start() }
        } catch {
            finishBroadcastWithError(NSError(domain: "AppShellScreen", code: 2, userInfo: [NSLocalizedDescriptionKey: AppShellScreenConfig.startInAppMessage]))
        }
    }
    override func broadcastFinished() { if let publisher { Task { await publisher.stop(state: "stopped") } }; publisher = nil }
    override func broadcastPaused() { if let publisher { Task { await publisher.stop(state: "stopped") } } }
    override func processSampleBuffer(_ sampleBuffer: CMSampleBuffer, with sampleBufferType: RPSampleBufferType) {
        guard sampleBufferType == .video, let publisher else { return }
        lock.lock()
        guard !framePending else { lock.unlock(); return }
        framePending = true; lock.unlock()
        // Bound the number of retained ReplayKit buffers; extensions have a strict memory limit.
        let frame = VideoFrame(sampleBuffer)
        Task {
            await publisher.append(frame)
            self.frameCompleted()
        }
    }
    private func frameCompleted() { lock.lock(); framePending = false; lock.unlock() }
}
/** Applies [ScreenUplinkPolicy] to HaishinKit's per-second network monitor events. */
private actor ScreenUplinkStrategy: StreamBitRateStrategy {
    let mamimumVideoBitRate = ScreenUplinkPolicy.maximumBitRate
    let mamimumAudioBitRate = 0
    private var policy = ScreenUplinkPolicy()
    var gated: Bool { policy.gated }

    func adjustBitrate(_ event: NetworkMonitorEvent, stream: some StreamConvertible) async {
        let next: Int?
        switch event {
        case .status(let report):
            next = policy.observe(queueBytes: report.currentQueueBytesOut, sentBytesPerSecond: report.currentBytesOutPerSecond, insufficient: false)
        case .publishInsufficientBWOccured(let report):
            next = policy.observe(queueBytes: report.currentQueueBytesOut, sentBytesPerSecond: report.currentBytesOutPerSecond, insufficient: true)
        case .reset:
            policy.reset(); next = ScreenUplinkPolicy.maximumBitRate
        }
        guard let next else { return }
        var settings = await stream.videoSettings
        guard settings.bitRate != next else { return }
        settings.bitRate = next
        try? await stream.setVideoSettings(settings)
    }
}

private struct VideoFrame: @unchecked Sendable {
    let buffer: CMSampleBuffer
    init(_ buffer: CMSampleBuffer) { self.buffer = buffer }
}

private actor ScreenPublisher {
    private var lease: ScreenCredentials
    private let finished: @Sendable (Bool) -> Void
    private let mixer = MediaMixer(captureSessionMode: .manual)
    private var session: (any Session)?
    private var heartbeat: Task<Void, Never>?
    private var renewal: Task<Void, Never>?
    private var stopped = false
    private var sharing = false
    private var recovery: ScreenRecovery
    private var connectionGeneration = 0
    private var dimensions: CMVideoDimensions?
    private var uplink: ScreenUplinkStrategy?
    private var recorder: ScreenReplayRecorder?
    private let normalizer = ReplayVideoFrameNormalizer()

    init(lease: ScreenCredentials, finished: @Sendable @escaping (Bool) -> Void) { self.lease = lease; self.finished = finished; self.recovery = ScreenRecovery(deadline: lease.expiry) }
    func start() async {
        heartbeat = Task {
            while !Task.isCancelled && !stopped {
                if ScreenLeaseStore.stopped(lease.publisherId) { await stop(state: "stopped", finishBroadcast: true); return }
                if recovery.next(now: Date()) == .stop { await stop(state: "failed", finishBroadcast: true); return }
                do { try await recorder?.tick() } catch { await stop(state: "failed", finishBroadcast: true); return }
                ScreenLeaseStore.status(lease.publisherId, sharing ? "sharing" : "requesting")
                // Poll the classroom stop flag more often than the 1s heartbeat so ending class is prompt.
                for _ in 0..<5 where !Task.isCancelled && !stopped && !ScreenLeaseStore.stopped(lease.publisherId) {
                    try? await Task.sleep(nanoseconds: 200_000_000)
                }
            }
        }
        do {
            if lease.replay != nil { recorder = try ScreenReplayRecorder(credentials: lease) }
            var settings = await mixer.videoMixerSettings; settings.mode = .passthrough
            await mixer.setVideoMixerSettings(settings); await mixer.startRunning()
            guard !stopped else { await mixer.stopRunning(); return }
            renewal = Task { await maintain() }
        } catch { await stop(state: "failed", finishBroadcast: true) }
    }
    private func maintain() async {
        while !Task.isCancelled && !stopped {
            let action = recovery.next(now: Date())
            if action == .stop { await stop(state: "failed", finishBroadcast: true); return }
            if action == .wait { try? await Task.sleep(nanoseconds: 250_000_000); continue }
            do {
                if action == .reconnect { await closeTransport() }
                let renewed = try await ScreenLeaseAPI.request(lease, action: "renew", refreshPush: action == .reconnect)
                guard !stopped else { return }
                recovery.renewed(until: renewed.expiry, now: Date())
                guard recovery.next(now: Date()) != .stop else { await stop(state: "failed", finishBroadcast: true); return }
                lease = renewed
                if action == .reconnect { try await connect() }
                guard !stopped else { return }
                // A disconnect can arrive while a healthy renewal is in flight.
                if sharing { recovery.succeeded(now: Date()) }
            } catch {
                guard !stopped else { return }
                let rejected = (error as? ScreenLeaseAPI.Failure).map { ScreenLeaseAPI.permanent(status: $0.status) } ?? false
                recovery.failed(permanent: rejected, now: Date())
            }
        }
    }
    private func closeTransport() async {
        connectionGeneration += 1; sharing = false
        let previous = session; session = nil; dimensions = nil
        uplink = nil
        if let previous { try? await previous.close(); await mixer.removeOutput(previous.stream) }
    }
    private func connect() async throws {
        guard let url = URL(string: lease.url), !stopped else { throw URLError(.cancelled) }
        let epoch = connectionGeneration
        let next = RTMPSessionFactory().make(url, mode: .publish, configuration: nil)
        session = next
        await next.setMaxRetryCount(0)
        await next.stream.setVideoInputBufferCounts(3)
        var settings = await next.stream.videoSettings
        settings.bitRate = ScreenUplinkPolicy.maximumBitRate; settings.frameInterval = 1.0 / 30.0; settings.expectedFrameRate = 30
        settings.profileLevel = kVTProfileLevel_H264_Baseline_AutoLevel as String
        settings.maxKeyFrameIntervalDuration = 2; settings.scalingMode = .letterbox
        try await next.stream.setVideoSettings(settings)
        let strategy = ScreenUplinkStrategy()
        await next.stream.setBitRateStrategy(strategy)
        uplink = strategy
        await mixer.addOutput(next.stream)
        try await next.connect { [weak self] in Task { await self?.disconnected(epoch: epoch) } }
        guard !stopped, epoch == connectionGeneration else { try? await next.close(); await mixer.removeOutput(next.stream); return }
        guard recovery.next(now: Date()) != .stop else { throw URLError(.timedOut) }
        sharing = true; ScreenLeaseStore.status(lease.publisherId, "sharing")
    }
    private func disconnected(epoch: Int) {
        guard !stopped, epoch == connectionGeneration else { return }
        connectionGeneration += 1; sharing = false
        recovery.disconnected(now: Date())
        recovery.failed(permanent: false, now: Date())
        ScreenLeaseStore.status(lease.publisherId, "requesting")
    }
    func append(_ frame: VideoFrame) async {
        guard !stopped else { return }
        let value = CMGetAttachment(frame.buffer, key: RPVideoSampleOrientationKey as CFString, attachmentModeOut: nil) as? NSNumber
        let orientation = CGImagePropertyOrientation(rawValue: value?.uint32Value ?? 1) ?? .up
        let buffer: CMSampleBuffer
        do {
            guard let upright = try normalizer.normalize(frame.buffer, orientation: orientation) else { return }
            buffer = upright
        }
        catch { await stop(state: "failed", finishBroadcast: true); return }
        guard let size = buffer.formatDescription?.dimensions else { return }
        if let session, sharing, dimensions?.width != size.width || dimensions?.height != size.height {
            dimensions = size
            let scale = min(1.0, 1920.0 / Double(max(size.width, size.height)), 1080.0 / Double(min(size.width, size.height)))
            var settings = await session.stream.videoSettings
            settings.videoSize = CGSize(width: (Int(Double(size.width) * scale) / 2) * 2, height: (Int(Double(size.height) * scale) / 2) * 2)
            do { try await session.stream.setVideoSettings(settings) } catch { await stop(state: "failed", finishBroadcast: true); return }
        }
        if let recorder {
            do { try await recorder.append(buffer) } catch { await stop(state: "failed", finishBroadcast: true); return }
        }
        // The local replay above keeps every frame; only the live push skips frames while its queue drains.
        if let uplink, await uplink.gated { return }
        if sharing && !stopped { await mixer.append(buffer) }
    }
    func stop(state: String, finishBroadcast: Bool = false) async {
        guard !stopped else { return }
        let requested = ScreenLeaseStore.stopped(lease.publisherId)
        if (try? ScreenLeaseStore.read(ScreenCredentials.self, "active.json"))?.publisherId == lease.publisherId { ScreenLeaseStore.remove("active.json") }
        stopped = true; sharing = false; heartbeat?.cancel(); renewal?.cancel()
        ScreenLeaseStore.status(lease.publisherId, requested ? "stopped" : state)
        ScreenLeaseStore.remove("\(lease.publisherId).stop")
        // Persist the replay tail before ReplayKit may tear the extension down, then end the
        // system broadcast at once. A graceful RTMP close waits up to 3s for CDN replies that
        // often never arrive; the app and Web also stop the lease, so closing runs afterwards.
        try? await recorder?.finish()
        recorder = nil
        let stoppedLease = lease
        Task { _ = try? await ScreenLeaseAPI.request(stoppedLease, action: "stop") }
        if finishBroadcast { finished(requested) }
        await closeTransport(); await mixer.stopRunning()
    }
}
