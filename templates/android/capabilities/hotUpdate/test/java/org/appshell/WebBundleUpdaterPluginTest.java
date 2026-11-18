package org.appshell;

import static org.junit.Assert.assertFalse;
import static org.junit.Assert.assertEquals;
import static org.junit.Assert.assertThrows;
import static org.junit.Assert.assertTrue;

import android.content.SharedPreferences;

import org.junit.Test;

import java.io.IOException;
import java.lang.reflect.Proxy;
import java.nio.charset.StandardCharsets;
import java.nio.file.Files;
import java.nio.file.Path;
import java.util.HashMap;
import java.util.Map;

public class WebBundleUpdaterPluginTest {
    @Test
    public void apkReinstallClearsOnlyWebBundlesAndNormalRestartKeepsThem() throws Exception {
        Path files = Files.createTempDirectory("appshell-apk-update-");
        Path bundle = files.resolve("webbundles/1.0.604/index.html");
        Path recording = files.resolve("recording.webm");
        Map<String, Object> cap = new HashMap<>(Map.of("serverBasePath", bundle.getParent().toString(), "unrelated", "keep"));
        Map<String, Object> own = new HashMap<>(Map.of("confirmed", true, "version", "1.0.604"));
        try {
            Files.createDirectories(bundle.getParent());
            Files.write(bundle, "old environment".getBytes(StandardCharsets.UTF_8));
            Files.write(recording, "keep recording".getBytes(StandardCharsets.UTF_8));
            EmbeddedWebBundleState.resetAfterApkUpdate(100L, "aaa", preferences(cap), preferences(own), files.toFile());
            assertFalse(cap.containsKey("serverBasePath"));
            assertEquals("keep", cap.get("unrelated"));
            assertTrue(own.isEmpty());
            assertFalse(Files.exists(bundle));
            assertEquals("keep recording", new String(Files.readAllBytes(recording), StandardCharsets.UTF_8));

            Files.createDirectories(bundle.getParent());
            Files.write(bundle, "newly downloaded".getBytes(StandardCharsets.UTF_8));
            cap.put("serverBasePath", bundle.getParent().toString());
            own.put("confirmed", true);
            EmbeddedWebBundleState.resetAfterApkUpdate(100L, "aaa", preferences(cap), preferences(own), files.toFile());
            assertTrue(cap.containsKey("serverBasePath"));
            assertTrue(own.containsKey("confirmed"));
            assertTrue(Files.exists(bundle));

            // versionCode/versionName 未变也重置，不能复用另一环境的同版本目录。
            EmbeddedWebBundleState.resetAfterApkUpdate(200L, "aaa", preferences(cap), preferences(own), files.toFile());
            assertFalse(cap.containsKey("serverBasePath"));
            assertTrue(own.isEmpty());
            assertFalse(Files.exists(bundle));
            assertTrue(Files.exists(recording));
        } finally {
            try (var paths = Files.walk(files)) {
                for (Path path : paths.sorted(java.util.Comparator.reverseOrder()).toList()) Files.delete(path);
            }
        }
    }

    @Test
    public void publishedBundleMustMatchAppEnvironmentAndCleanSource() throws Exception {
        Path bundle = Files.createTempDirectory("appshell-published-bundle-");
        try {
            write(bundle.resolve("index.html"), "<html></html>");
            write(bundle.resolve(WebBundleContract.MANIFEST_FILE), publishedManifest("com.example.app", "test", false));
            WebBundleContract.validatePublishedBundle(bundle.toFile(), "com.example.app", "test");

            write(bundle.resolve(WebBundleContract.MANIFEST_FILE), publishedManifest("com.example.app", "test", true));
            assertThrows(IOException.class, () ->
                WebBundleContract.validatePublishedBundle(bundle.toFile(), "com.example.app", "test"));

            write(bundle.resolve(WebBundleContract.MANIFEST_FILE), publishedManifest("com.example.app", "prod", false));
            assertThrows(IOException.class, () ->
                WebBundleContract.validatePublishedBundle(bundle.toFile(), "com.example.app", "test"));

            write(bundle.resolve(WebBundleContract.MANIFEST_FILE), publishedManifest("com.example.other", "test", false));
            assertThrows(IOException.class, () ->
                WebBundleContract.validatePublishedBundle(bundle.toFile(), "com.example.app", "test"));

            Files.delete(bundle.resolve("index.html"));
            write(bundle.resolve(WebBundleContract.MANIFEST_FILE), publishedManifest("com.example.app", "test", false));
            assertThrows(IOException.class, () ->
                WebBundleContract.validatePublishedBundle(bundle.toFile(), "com.example.app", "test"));
        } finally {
            try (var paths = Files.walk(bundle)) {
                for (Path path : paths.sorted(java.util.Comparator.reverseOrder()).toList()) Files.delete(path);
            }
        }
    }

    private static String publishedManifest(String appId, String environment, boolean dirty) {
        return "{\"schemaVersion\":1,\"appId\":\"" + appId + "\",\"environment\":\"" + environment + "\"," +
            "\"sourceCommit\":\"" + "a".repeat(40) + "\",\"sourceDirty\":" + dirty + "}";
    }

    private static void write(Path file, String content) throws IOException {
        Files.write(file, content.getBytes(StandardCharsets.UTF_8));
    }

    @Test
    public void embeddedBundleChangeClearsHotUpdateEvenWhenInstallTimestampIsUnchanged() throws Exception {
        Path files = Files.createTempDirectory("appshell-bundle-change-");
        Path bundle = files.resolve("webbundles/1.0.604/index.html");
        Map<String, Object> cap = new HashMap<>();
        Map<String, Object> own = new HashMap<>();
        try {
            EmbeddedWebBundleState.resetAfterApkUpdate(100L, "aaa", preferences(cap), preferences(own), files.toFile());
            Files.createDirectories(bundle.getParent());
            Files.write(bundle, "hot update".getBytes(StandardCharsets.UTF_8));
            cap.put("serverBasePath", bundle.getParent().toString());
            own.put("confirmed", true);

            EmbeddedWebBundleState.resetAfterApkUpdate(100L, "bbb", preferences(cap), preferences(own), files.toFile());

            assertFalse(cap.containsKey("serverBasePath"));
            assertEquals("bbb", cap.get("appshellEmbeddedBundleSha256"));
            assertTrue(own.isEmpty());
            assertFalse(Files.exists(bundle));
        } finally {
            try (var paths = Files.walk(files)) {
                for (Path path : paths.sorted(java.util.Comparator.reverseOrder()).toList()) Files.delete(path);
            }
        }
    }

    private static SharedPreferences preferences(Map<String, Object> values) {
        SharedPreferences.Editor editor = (SharedPreferences.Editor) Proxy.newProxyInstance(
            SharedPreferences.Editor.class.getClassLoader(), new Class<?>[] { SharedPreferences.Editor.class },
            (proxy, method, args) -> {
                switch (method.getName()) {
                    case "remove": values.remove(args[0]); return proxy;
                    case "putLong": values.put((String) args[0], args[1]); return proxy;
                    case "putString": values.put((String) args[0], args[1]); return proxy;
                    case "clear": values.clear(); return proxy;
                    case "apply": return null;
                    case "commit": return true;
                    default: throw new AssertionError(method.getName());
                }
            });
        return (SharedPreferences) Proxy.newProxyInstance(SharedPreferences.class.getClassLoader(),
            new Class<?>[] { SharedPreferences.class }, (proxy, method, args) -> switch (method.getName()) {
                case "getLong" -> values.getOrDefault(args[0], args[1]);
                case "getString" -> values.getOrDefault(args[0], args[1]);
                case "edit" -> editor;
                default -> throw new AssertionError(method.getName());
            });
    }

    @Test
    public void bundleRequiresChromium111IncludingVendorWebViews() {
        assertFalse(WebBundleUpdaterPlugin.supportsWebView("Mozilla/5.0 Chrome/110.0.5481.154 Mobile Safari/537.36"));
        assertTrue(WebBundleUpdaterPlugin.supportsWebView("Mozilla/5.0 Chrome/111.0.5563.116 Mobile Safari/537.36"));
        assertTrue(WebBundleUpdaterPlugin.supportsWebView("Mozilla/5.0 Chrome/140.0.0.0 Mobile Safari/537.36"));
        assertFalse(WebBundleUpdaterPlugin.supportsWebView("HuaweiBrowser/16.0.5.302 Chrome/99.0.4844.88"));
        assertTrue(WebBundleUpdaterPlugin.supportsWebView("HuaweiBrowser/16.0.5.302 Chrome/122.0.6261.90"));
        assertFalse(WebBundleUpdaterPlugin.supportsWebView(null));
        assertFalse(WebBundleUpdaterPlugin.supportsWebView("Mozilla/5.0 Safari/537.36"));
        assertFalse(WebBundleUpdaterPlugin.supportsWebView("Chrome/999999999999999999999999.0"));
    }
}
