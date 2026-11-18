package org.appshell;

/** 原生侧共用的文件名清洗：Web 传来的名字不可信，录音落盘与图片保存走同一套规则。 */
final class FileNames {
    static final int MAX_NAME_LENGTH = 128;

    private FileNames() {}

    /** Web 传来的文件名不可信：剥掉路径分隔符和控制字符，再截长度。 */
    static String sanitize(String raw, String fallback) {
        if (raw == null) return fallback;
        StringBuilder out = new StringBuilder();
        for (int i = 0; i < raw.length(); i++) {
            char c = raw.charAt(i);
            if (c == '/' || c == '\\') continue;
            if (c < 0x20 || c == 0x7f) continue;
            out.append(c);
        }
        // 删完分隔符还要再剥开头的点：`../etc/passwd` 剩下的是 `..etcpasswd`，
        // 而 `.` 开头本身就是隐藏文件——用户「录了但找不到」跟没保存没区别。
        int start = 0;
        while (start < out.length() && (out.charAt(start) == '.' || Character.isWhitespace(out.charAt(start)))) {
            start++;
        }
        String cleaned = out.substring(start).trim();
        if (cleaned.isEmpty()) return fallback;
        return truncateKeepingExtension(cleaned, MAX_NAME_LENGTH);
    }

    /**
     * 截长度时保住扩展名：硬截会把 `.webm` 整个削掉，而 MediaStore 那条路径是直接拿这个名字
     * 当 DISPLAY_NAME 的——交一个没有扩展名的名字过去，MediaProvider 只能自己按 MIME 猜一个补上，
     * 用户看到的文件名就不是他给的那个了。要短的是中间的名字，不是尾巴。
     */
    static String truncateKeepingExtension(String name, int max) {
        if (name.length() <= max) return name;
        int dot = name.lastIndexOf('.');
        // 与 extension() 同一条判定：dot <= 0 是「没有扩展名」（`.webm` 整个是名字）。
        String ext = (dot <= 0 || dot == name.length() - 1) ? "" : name.substring(dot);
        // 扩展名本身就吃满了预算，那它也不像扩展名，退回硬截。
        if (ext.length() >= max) ext = "";
        String head = name.substring(0, max - ext.length());
        String trimmed = head.trim();
        return (trimmed.isEmpty() ? head : trimmed) + ext;
    }

    static String baseName(String filename) {
        int dot = filename.lastIndexOf('.');
        return dot <= 0 ? filename : filename.substring(0, dot);
    }
}
