package org.appshell;

import java.io.BufferedReader;
import java.io.File;
import java.io.FileInputStream;
import java.io.IOException;
import java.io.InputStreamReader;
import java.nio.charset.StandardCharsets;
import java.util.regex.Pattern;

/**
 * 热更新包契约：包由 appshell CLI 产出，根目录带 {@value #MANIFEST_FILE}。
 * 只接受同一 appId、同一环境、干净源码构建的包——跨 App 或跨环境的包装上去就是事故。
 * 本地 JVM 单测里 org.json 是桩实现，所以这里用正则读几个固定字段。
 */
final class WebBundleContract {
    static final String MANIFEST_FILE = "appshell-build.json";
    private static final Pattern SCHEMA_VERSION = Pattern.compile("\"schemaVersion\"\\s*:\\s*1(?:\\s*[,}])");
    private static final Pattern SOURCE_COMMIT = Pattern.compile("\"sourceCommit\"\\s*:\\s*\"[0-9a-fA-F]{40}\"");
    private static final Pattern CLEAN_SOURCE = Pattern.compile("\"sourceDirty\"\\s*:\\s*false");

    private WebBundleContract() {}

    static void validatePublishedBundle(File directory) throws IOException {
        validatePublishedBundle(directory, AppShellConfig.APPLICATION_ID, AppShellConfig.ENVIRONMENT);
    }

    static void validatePublishedBundle(File directory, String appId, String environment) throws IOException {
        read(new File(directory, "index.html"));
        String manifest = read(new File(directory, MANIFEST_FILE));
        if (!SCHEMA_VERSION.matcher(manifest).find() || !SOURCE_COMMIT.matcher(manifest).find()
            || !CLEAN_SOURCE.matcher(manifest).find()) {
            throw new IOException("Web Bundle 来源不完整或不是干净源码构建");
        }
        if (!field("appId", appId).matcher(manifest).find()) {
            throw new IOException("Web Bundle 不属于 " + appId);
        }
        if (!field("environment", environment).matcher(manifest).find()) {
            throw new IOException("Web Bundle 不是 " + environment + " 环境的构建");
        }
    }

    private static Pattern field(String name, String value) {
        return Pattern.compile("\"" + name + "\"\\s*:\\s*\"" + Pattern.quote(value) + "\"");
    }

    private static String read(File file) throws IOException {
        if (!file.isFile()) throw new IOException("Web Bundle 缺少 " + file.getName());
        StringBuilder content = new StringBuilder();
        try (BufferedReader reader = new BufferedReader(new InputStreamReader(
                new FileInputStream(file), StandardCharsets.UTF_8))) {
            String line;
            while ((line = reader.readLine()) != null) content.append(line).append('\n');
        }
        return content.toString();
    }
}
