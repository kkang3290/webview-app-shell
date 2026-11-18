import Capacitor
import UIKit
import WebKit

final class ShellWebViewController: CAPBridgeViewController {
    private var refresh: ShellPageRefreshController?

    /// 容器创建前决定这次冷启动加载哪份网页：启用了热更新且有可用的包就用它，否则用安装包内置的产物。
    override func instanceDescriptor() -> InstanceDescriptor {
        let descriptor = super.instanceDescriptor()
        if let directory = AppShellHooks.webRoot() { descriptor.appLocation = directory }
        return descriptor
    }

    override func capacitorDidLoad() {
        self.bridge?.registerPluginInstance(StatusBarThemePlugin())
        self.bridge?.registerPluginInstance(PermissionsPlugin())
        // 能力组插件由 appshell prebuild 按 appshell.config.json 生成。
        if let bridge = self.bridge { AppShellPlugins.register(on: bridge) }
        if let webView = self.webView {
            if AppShellConfig.pullToRefresh {
                self.refresh = ShellPageRefreshController(webView: webView, blockSelector: AppShellConfig.refreshBlockSelector)
            }
            ShellBinaryUploadHTTP.install(on: webView)
            if let color = StatusBarThemePlugin.launchColor() {
                webView.backgroundColor = color
                webView.scrollView.backgroundColor = color
            }
        }
        self.webView?.allowsBackForwardNavigationGestures = true
        #if DEBUG && targetEnvironment(simulator)
            if let webView = self.webView { ShellProbe.install(on: webView) }
        #endif
    }
}
