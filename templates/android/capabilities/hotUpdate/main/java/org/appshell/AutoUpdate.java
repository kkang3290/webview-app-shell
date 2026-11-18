package org.appshell;

import java.net.URI;
import java.util.LinkedHashSet;
import java.util.Set;
import java.util.regex.Matcher;
import java.util.regex.Pattern;

/**
 * 自动热更新的纯函数部分（不依赖 Android，可在 JVM 单测里跑）。
 * 本地 JVM 单测里 org.json 是桩实现，所以响应用正则取字段。
 */
final class AutoUpdate {
    static final String NEXT_LAUNCH = "next-launch";
    private static final Pattern VERSION = Pattern.compile("^\\d+\\.\\d+\\.\\d+$");
    private static final Pattern SHA256 = Pattern.compile("^([0-9a-fA-F]{64})(\\s|$)");

    static final class Latest {
        final String version;
        final String url;

        Latest(String version, String url) {
            this.version = version;
            this.url = url;
        }
    }

    private AutoUpdate() {}

    /** 按 "." 分段比数值；任何一方不是三段数字就判 false——宁可不更新。 */
    static boolean isNewer(String remote, String local) {
        if (remote == null || local == null || !VERSION.matcher(remote).matches() || !VERSION.matcher(local).matches()) return false;
        String[] a = remote.split("\\.");
        String[] b = local.split("\\.");
        for (int i = 0; i < 3; i++) {
            long diff = Long.parseLong(a[i]) - Long.parseLong(b[i]);
            if (diff != 0) return diff > 0;
        }
        return false;
    }

    /** protojson `{ "version": "...", "url": "..." }`：缺省即空串即「没有」。 */
    static Latest parseLatest(String body) {
        if (body == null) return null;
        String version = field(body, "version");
        String url = field(body, "url");
        if (version == null || url == null || !VERSION.matcher(version).matches() || url.isEmpty()) return null;
        return new Latest(version, url);
    }

    static String parseSha256(String body) {
        if (body == null) return null;
        Matcher m = SHA256.matcher(body.trim());
        return m.find() ? m.group(1).toLowerCase(java.util.Locale.ROOT) : null;
    }

    /** 绝对地址只认 https；相对路径拼到查询地址的源上。 */
    static String resolveUrl(String raw, String latestUrl) {
        try {
            URI resolved = URI.create(latestUrl).resolve(raw);
            return "https".equals(resolved.getScheme()) ? resolved.toString() : null;
        } catch (IllegalArgumentException error) {
            return null;
        }
    }

    static boolean isBad(String badList, String version) {
        if (badList == null || badList.isEmpty() || version == null) return false;
        for (String item : badList.split(",")) if (item.equals(version)) return true;
        return false;
    }

    static String addBad(String badList, String version) {
        Set<String> set = new LinkedHashSet<>();
        if (badList != null && !badList.isEmpty()) for (String item : badList.split(",")) set.add(item);
        if (version != null && VERSION.matcher(version).matches()) set.add(version);
        return String.join(",", set);
    }

    private static String field(String body, String name) {
        Matcher m = Pattern.compile("\"" + name + "\"\\s*:\\s*\"([^\"]*)\"").matcher(body);
        return m.find() ? m.group(1) : null;
    }
}
