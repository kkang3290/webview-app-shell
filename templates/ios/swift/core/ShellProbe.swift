#if DEBUG && targetEnvironment(simulator)
    import Foundation
    import WebKit

    /// 仅 Debug 模拟器：appshell 的自动化验证入口。
    /// 启动环境 APPSHELL_PROBE_SCRIPT=<宿主机 JS 文件>、APPSHELL_PROBE_OUT=<结果文件>，
    /// 页面首次加载完成后以 callAsyncJavaScript 执行脚本（可 await），返回值写成 JSON。
    enum ShellProbe {
        private static var observation: NSKeyValueObservation?

        static func install(on webView: WKWebView) {
            let environment = ProcessInfo.processInfo.environment
            guard let scriptPath = environment["APPSHELL_PROBE_SCRIPT"], let outPath = environment["APPSHELL_PROBE_OUT"],
                  let script = try? String(contentsOfFile: scriptPath, encoding: .utf8)
            else { return }
            Self.observation = webView.observe(\.isLoading, options: [.new]) { view, _ in
                guard !view.isLoading else { return }
                Self.observation = nil
                DispatchQueue.main.asyncAfter(deadline: .now() + 1) {
                    view.callAsyncJavaScript(script, arguments: [:], in: nil, in: .page) { result in
                        let payload: Any
                        switch result {
                        case let .success(value): payload = ["ok": true, "value": value]
                        case let .failure(error): payload = ["ok": false, "error": "\(error)"]
                        }
                        let data = (try? JSONSerialization.data(withJSONObject: payload, options: [.prettyPrinted]))
                            ?? Data("{\"ok\":false,\"error\":\"unserializable result\"}".utf8)
                        try? data.write(to: URL(fileURLWithPath: outPath))
                    }
                }
            }
        }
    }
#endif
