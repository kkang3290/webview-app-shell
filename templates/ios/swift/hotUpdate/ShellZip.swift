import Foundation

/// 只为解热更新包写的最小 zip 读取器：按中央目录逐个条目解出，支持「存储」与 DEFLATE 两种方式。
/// 不支持 zip64、加密、分卷——appshell 打的热更新包用不到；遇到就报错，不猜。
enum ShellZip {
    enum Failure: Error { case malformed(String), unsupported(String), unsafePath(String) }

    private static let maxEntries = 20000
    private static let maxTotalBytes = 600 * 1024 * 1024

    static func extract(_ archive: URL, to directory: URL) throws {
        let data = try Data(contentsOf: archive, options: .mappedIfSafe)
        let end = try self.endOfCentralDirectory(in: data)
        let count = Int(self.u16(data, end + 10))
        let directorySize = Int(self.u32(data, end + 12))
        var offset = Int(self.u32(data, end + 16))
        if count == 0xFFFF || directorySize == 0xFFFF_FFFF || offset == 0xFFFF_FFFF { throw Failure.unsupported("zip64") }
        guard count <= self.maxEntries, offset + directorySize <= data.count else { throw Failure.malformed("central directory") }
        let root = directory.standardizedFileURL.path + "/"
        var total = 0
        for _ in 0 ..< count {
            guard offset + 46 <= data.count, self.u32(data, offset) == 0x0201_4B50 else { throw Failure.malformed("central header") }
            let flags = self.u16(data, offset + 8)
            let method = self.u16(data, offset + 10)
            let compressedSize = Int(self.u32(data, offset + 20))
            let size = Int(self.u32(data, offset + 24))
            let nameLength = Int(self.u16(data, offset + 28))
            let extraLength = Int(self.u16(data, offset + 30))
            let commentLength = Int(self.u16(data, offset + 32))
            let local = Int(self.u32(data, offset + 42))
            guard offset + 46 + nameLength <= data.count,
                  let name = String(data: data.subdata(in: offset + 46 ..< offset + 46 + nameLength), encoding: .utf8)
            else { throw Failure.malformed("entry name") }
            offset += 46 + nameLength + extraLength + commentLength
            if flags & 0x1 != 0 { throw Failure.unsupported("encrypted entry") }
            if compressedSize == 0xFFFF_FFFF || size == 0xFFFF_FFFF || local == 0xFFFF_FFFF { throw Failure.unsupported("zip64") }

            // zip-slip：条目名里的 ../、绝对路径、反斜杠都可能把文件写出目标目录
            let parts = name.split(separator: "/", omittingEmptySubsequences: true)
            guard !name.hasPrefix("/"), !name.contains("\\"), !parts.contains(".."), !parts.isEmpty else { throw Failure.unsafePath(name) }
            let target = directory.appendingPathComponent(parts.joined(separator: "/")).standardizedFileURL
            guard target.path.hasPrefix(root) else { throw Failure.unsafePath(name) }
            if name.hasSuffix("/") {
                try FileManager.default.createDirectory(at: target, withIntermediateDirectories: true)
                continue
            }
            total += size
            guard total <= self.maxTotalBytes else { throw Failure.unsupported("archive too large") }

            guard local + 30 <= data.count, self.u32(data, local) == 0x0403_4B50 else { throw Failure.malformed("local header") }
            let start = local + 30 + Int(self.u16(data, local + 26)) + Int(self.u16(data, local + 28))
            guard start + compressedSize <= data.count else { throw Failure.malformed("entry data") }
            let raw = data.subdata(in: start ..< start + compressedSize)
            let content: Data
            switch method {
            case 0: content = raw
            case 8: content = size == 0 ? Data() : try (raw as NSData).decompressed(using: .zlib) as Data
            default: throw Failure.unsupported("compression method \(method)")
            }
            guard content.count == size else { throw Failure.malformed("size mismatch: \(name)") }
            try FileManager.default.createDirectory(at: target.deletingLastPathComponent(), withIntermediateDirectories: true)
            try content.write(to: target)
        }
    }

    private static func endOfCentralDirectory(in data: Data) throws -> Int {
        guard data.count >= 22 else { throw Failure.malformed("too small") }
        var index = data.count - 22
        let lowest = max(0, data.count - 22 - 0xFFFF)
        while index >= lowest {
            if self.u32(data, index) == 0x0605_4B50 { return index }
            index -= 1
        }
        throw Failure.malformed("end of central directory not found")
    }

    private static func u16(_ data: Data, _ offset: Int) -> UInt16 {
        UInt16(data[data.startIndex + offset]) | UInt16(data[data.startIndex + offset + 1]) << 8
    }

    private static func u32(_ data: Data, _ offset: Int) -> UInt32 {
        UInt32(self.u16(data, offset)) | UInt32(self.u16(data, offset + 2)) << 16
    }
}
