import Capacitor
import Foundation

/// 后台上传（Android 同名同语义）：enqueue / get / list / cancel / remove，事件 progress / state。
/// 交给系统的后台 URLSession：App 被挂起甚至被杀，系统都会把文件传完，再把 App 叫醒交结果。
@objc(BackgroundUploadPlugin)
final class BackgroundUploadPlugin: CAPPlugin, CAPBridgedPlugin, BackgroundUploadListener {
    let identifier = "BackgroundUploadPlugin"
    let jsName = "BackgroundUpload"
    let pluginMethods: [CAPPluginMethod] = [
        CAPPluginMethod(name: "enqueue", returnType: CAPPluginReturnPromise),
        CAPPluginMethod(name: "get", returnType: CAPPluginReturnPromise),
        CAPPluginMethod(name: "list", returnType: CAPPluginReturnPromise),
        CAPPluginMethod(name: "cancel", returnType: CAPPluginReturnPromise),
        CAPPluginMethod(name: "remove", returnType: CAPPluginReturnPromise),
    ]
    private var manager: BackgroundUploadManager { .shared }

    override func load() {
        self.manager.listener = self
    }

    @objc func enqueue(_ call: CAPPluginCall) {
        let id = call.getString("id") ?? UUID().uuidString
        guard let url = call.getString("url"), let method = call.getString("method"),
              let file = call.getObject("file")
        else { return call.reject("url, method and file are required", "INVALID") }
        var headers: [String: String] = [:]
        for (name, value) in call.getObject("headers") ?? [:] {
            guard let value = value as? String else { return call.reject("header \(name) must be a string", "INVALID") }
            headers[name] = value
        }
        do {
            let record = try self.manager.enqueue(
                id: id, url: url, method: method, headers: headers, label: call.getString("label") ?? "",
                path: file["path"] as? String, inlineData: file["data"] as? String
            )
            call.resolve(record.json)
        } catch {
            call.reject(error.localizedDescription, "INVALID")
        }
    }

    @objc func get(_ call: CAPPluginCall) {
        guard let id = call.getString("id"), let record = self.manager.record(id) else {
            return call.reject("unknown upload", "NOT_FOUND")
        }
        call.resolve(record.json)
    }

    @objc func list(_ call: CAPPluginCall) {
        call.resolve(["uploads": self.manager.records().map(\.json)])
    }

    @objc func cancel(_ call: CAPPluginCall) {
        guard let id = call.getString("id"), let record = self.manager.cancel(id) else {
            return call.reject("unknown upload", "NOT_FOUND")
        }
        call.resolve(record.json)
    }

    @objc func remove(_ call: CAPPluginCall) {
        guard let id = call.getString("id") else { return call.reject("id is required", "INVALID") }
        do {
            try self.manager.remove(id)
            call.resolve()
        } catch {
            call.reject(error.localizedDescription, "BUSY")
        }
    }

    func uploadProgress(_ id: String, sent: Int64, total: Int64) {
        self.notifyListeners("progress", data: ["id": id, "sent": sent, "total": total])
    }

    func uploadStateChanged(_ record: UploadRecord) {
        self.notifyListeners("state", data: record.json)
    }
}
