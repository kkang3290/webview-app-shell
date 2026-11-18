import UIKit

/// 保护顶部安全区；底部 Home 指示条的留白交给 Web 页面自己用 env(safe-area-inset-bottom) 处理。
final class ShellHostViewController: UIViewController {
    private let browser = ShellWebViewController()

    override func viewDidLoad() {
        super.viewDidLoad()
        self.view.backgroundColor = StatusBarThemePlugin.launchColor() ?? .systemBackground
        self.addChild(self.browser)
        self.browser.view.translatesAutoresizingMaskIntoConstraints = false
        self.view.addSubview(self.browser.view)
        let safeArea = self.view.safeAreaLayoutGuide
        // 键盘弹出时网页视口跟着缩（输入框不被挡住）；Home 指示条的留白仍由网页自己处理。
        let keyboard = self.view.keyboardLayoutGuide
        // iOS 17 起可让参考线不含底部安全区（网页铺到底）；iOS 15/16 没有这个开关，网页底边停在 Home 指示条上方，
        // 指示条那一条露出启动底色。布局正确，只是不铺满。
        if #available(iOS 17.0, *) { keyboard.usesBottomSafeArea = false }
        NSLayoutConstraint.activate([
            self.browser.view.topAnchor.constraint(equalTo: safeArea.topAnchor),
            self.browser.view.bottomAnchor.constraint(equalTo: keyboard.topAnchor),
            self.browser.view.leadingAnchor.constraint(equalTo: safeArea.leadingAnchor),
            self.browser.view.trailingAnchor.constraint(equalTo: safeArea.trailingAnchor),
        ])
        self.browser.didMove(toParent: self)
    }

    override var childForStatusBarStyle: UIViewController? { self.browser }
    override var childForStatusBarHidden: UIViewController? { self.browser }
}
