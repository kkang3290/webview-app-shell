import Capacitor
import Foundation
import ReplayKit
import UIKit

/// 屏幕共享（能力组 screenCapture，Android / 桌面同名）：capabilities / start / stop / state，事件 state。
/// iOS 只能经 ReplayKit 广播上传扩展采集整屏：start 把租约写进 App Group、弹系统广播面板；扩展连上推流后
/// 写回 sharing。扩展自己续租，App 被挂起也不断；租约续不上扩展自己停。分段回放由 App 与扩展共同补传。
@objc(ScreenCapturePlugin)
final class ScreenCapturePlugin: CAPPlugin, CAPBridgedPlugin {
    let identifier = "ScreenCapturePlugin"
    let jsName = "ScreenCapture"
    let pluginMethods: [CAPPluginMethod] = [
        CAPPluginMethod(name: "capabilities", returnType: CAPPluginReturnPromise),
        CAPPluginMethod(name: "start", returnType: CAPPluginReturnPromise),
        CAPPluginMethod(name: "stop", returnType: CAPPluginReturnPromise),
        CAPPluginMethod(name: "state", returnType: CAPPluginReturnPromise),
    ]
    private var recoveryObserver: NSObjectProtocol?
    @MainActor private var current: ScreenCredentials?
    @MainActor private var generation = 0
    @MainActor private var lastState = "stopped"
    // 授权界面归 ReplayKit：picker 常驻在页面上（隐藏），取消、重试都复用同一个
    @MainActor private lazy var broadcastPicker: RPSystemBroadcastPickerView = {
        let picker = RPSystemBroadcastPickerView(frame: CGRect(x: 0, y: 0, width: 44, height: 44))
        picker.preferredExtension = AppShellScreenConfig.extensionBundleId
        picker.showsMicrophoneButton = false
        picker.isHidden = true
        return picker
    }()

    override func load() {
        Task { await ScreenReplayUploads.shared.recover() }
        recoveryObserver = NotificationCenter.default.addObserver(forName: UIApplication.didBecomeActiveNotification, object: nil, queue: .main) { _ in
            Task { await ScreenReplayUploads.shared.recover() }
        }
        Task { @MainActor in self.bridge?.webView?.addSubview(self.broadcastPicker) }
    }

    deinit { if let recoveryObserver { NotificationCenter.default.removeObserver(recoveryObserver) } }

    @objc func capabilities(_ call: CAPPluginCall) {
        call.resolve(["platform": "ios", "screens": true, "windows": false, "stream": ["rtmps"], "replay": true])
    }

    /// 参数：{ stream: { url }, lease: { renewUrl, publisherId, token, expiresAt }, replay?: { uploadUrl, serverNow } }
    @objc func start(_ call: CAPPluginCall) {
        guard let stream = call.getObject("stream"), let lease = call.getObject("lease"),
              let url = stream["url"] as? String, let renewUrl = lease["renewUrl"] as? String,
              let publisherId = lease["publisherId"] as? String, let token = lease["token"] as? String,
              let expiresAt = lease["expiresAt"] as? String
        else { return call.reject("屏幕共享参数无效", "INVALID") }
        var replay: ScreenReplayCredentials?
        if let value = call.getObject("replay") {
            guard let uploadUrl = value["uploadUrl"] as? String, let serverNow = value["serverNow"] as? String,
                  let now = ScreenCapturePlugin.isoDate(serverNow)
            else { return call.reject("回放参数无效", "INVALID") }
            // 在弹系统面板之前校准时钟：用户可能在授权上停留几十秒，存档时间不能往回挪
            replay = ScreenReplayCredentials(uploadUrl: uploadUrl, serverNow: serverNow, clockOffset: now.timeIntervalSinceNow)
        }
        let credentials = ScreenCredentials(url: url, renewUrl: renewUrl, publisherId: publisherId, leaseToken: token, expiresAt: expiresAt, replay: replay)
        guard credentials.valid, credentials.expiry > Date() else {
            return call.reject("屏幕共享参数无效、已过期或地址不在 screenCapture.allowedHosts 里", "INVALID")
        }
        Task { @MainActor in
            guard current == nil else { return call.reject("已有进行中的屏幕共享，先 stop", "BUSY") }
            generation += 1
            let attempt = generation
            current = credentials
            do {
                try ScreenLeaseStore.write(credentials, "pending.json")
                ScreenLeaseStore.status(credentials.publisherId, "requesting")
                setState("requesting")
                guard let button = broadcastPicker.subviews.compactMap({ $0 as? UIButton }).first else { throw URLError(.unsupportedURL) }
                button.sendActions(for: .touchUpInside)
                // 最多等 45 秒：用户确认系统面板、扩展连上推流
                for _ in 0..<225 {
                    guard generation == attempt else { return call.resolve(["state": "stopped"]) }
                    let status = try? ScreenLeaseStore.read(ScreenStatus.self, "\(credentials.publisherId).state")
                    if status?.state == "sharing" {
                        setState("sharing")
                        return call.resolve(["state": "sharing"])
                    }
                    if status?.state == "failed" || status?.state == "stopped" { throw URLError(.cannotConnectToHost) }
                    try await Task.sleep(nanoseconds: 200_000_000)
                }
                throw URLError(.timedOut)
            } catch {
                if generation == attempt { await stopCurrent(state: "failed") }
                call.reject("屏幕共享未连接或已取消，请重新开始", "FAILED")
            }
        }
    }

    @MainActor private func setState(_ state: String) {
        guard state != lastState else { return }
        lastState = state
        notifyListeners("state", data: ["state": state])
    }

    @MainActor private func stopCurrent(state: String = "stopped") async {
        // App 重启后扩展可能还在推这个进程没见过的租约（active.json 由扩展写入）
        guard let lease = current ?? (try? ScreenLeaseStore.read(ScreenCredentials.self, "active.json")) else { return }
        generation += 1
        current = nil
        ScreenLeaseStore.status(lease.publisherId, "stopped")
        try? ScreenLeaseStore.write(true, "\(lease.publisherId).stop")
        ScreenLeaseStore.remove("pending.json")
        if (try? ScreenLeaseStore.read(ScreenCredentials.self, "active.json"))?.publisherId == lease.publisherId { ScreenLeaseStore.remove("active.json") }
        // 扩展从没起来（用户取消）时，替它把空存档收尾，后端才知道这次没有回放
        if lease.replay != nil, (try? ScreenLeaseStore.read(Bool.self, "\(lease.publisherId).archive-done")) != true,
           (try? ScreenLeaseStore.read(ScreenReplayJournal.self, "\(lease.publisherId).archive.json")) == nil {
            var journal = ScreenReplayJournal(credentials: lease)
            journal.complete = true
            try? ScreenLeaseStore.write(journal, "\(lease.publisherId).archive.json")
            try? await ScreenReplayUploads.shared.drain(lease.publisherId)
        }
        _ = try? await ScreenLeaseAPI.request(lease, action: "stop")
        setState(state)
    }

    @objc func stop(_ call: CAPPluginCall) {
        Task { @MainActor in
            await stopCurrent()
            call.resolve(["state": "stopped"])
        }
    }

    @objc func state(_ call: CAPPluginCall) {
        Task { @MainActor in
            Task { await ScreenReplayUploads.shared.recover() }
            // App 重启后认回扩展仍在推的那次共享
            if current == nil,
               let saved = try? ScreenLeaseStore.read(ScreenCredentials.self, "active.json"), saved.valid,
               let status = try? ScreenLeaseStore.read(ScreenStatus.self, "\(saved.publisherId).state"),
               status.currentState(waitingForBroadcast: false) == "sharing" { current = saved }
            guard let lease = current else { return call.resolve(["state": "stopped"]) }
            let status = try? ScreenLeaseStore.read(ScreenStatus.self, "\(lease.publisherId).state")
            let pending = try? ScreenLeaseStore.read(ScreenCredentials.self, "pending.json")
            let state = status?.currentState(waitingForBroadcast: pending?.publisherId == lease.publisherId) ?? "failed"
            if state == "failed" || state == "stopped" { await stopCurrent(state: state) } else { setState(state) }
            var result: [String: Any] = ["state": state]
            if state == "sharing" { result["publisherId"] = lease.publisherId; result["renewUrl"] = lease.renewUrl }
            call.resolve(result)
        }
    }

    private static func isoDate(_ value: String) -> Date? {
        let formatter = ISO8601DateFormatter()
        formatter.formatOptions = [.withInternetDateTime, .withFractionalSeconds]
        return formatter.date(from: value)
    }
}
