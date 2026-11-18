'use strict'
// MediaRecorder 写出的 WebM 没有时长（Segment/Info 里缺 Duration）：能播，但拖动进度、读时长都不对，
// 服务端按容器读时长的流程也会拿到空值。录音结束后在 Info 里补一个 Duration 元素。
// MediaRecorder 的 Segment 尺寸是「未知」，所以 Info 变长不需要改 Segment 头。

const ID_SEGMENT = 0x18538067
const ID_INFO = 0x1549a966
const ID_DURATION = 0x4489
const ID_TIMECODE_SCALE = 0x2ad7b1

function readId(buf, pos) {
  const first = buf[pos]
  let length = 1
  while (length <= 4 && !(first & (0x80 >> (length - 1)))) length++
  if (length > 4) throw new Error('bad EBML id')
  let value = 0
  for (let i = 0; i < length; i++) value = value * 256 + buf[pos + i]
  return { value, length }
}

function readSize(buf, pos) {
  const first = buf[pos]
  let length = 1
  while (length <= 8 && !(first & (0x80 >> (length - 1)))) length++
  if (length > 8) throw new Error('bad EBML size')
  let value = first & (0xff >> length)
  let unknown = value === (0xff >> length)
  for (let i = 1; i < length; i++) {
    value = value * 256 + buf[pos + i]
    if (buf[pos + i] !== 0xff) unknown = false
  }
  return { value, length, unknown }
}

function encodeSize(value) {
  for (let length = 1; length <= 8; length++) {
    if (value < 2 ** (7 * length) - 1) {
      const out = Buffer.alloc(length)
      let rest = value
      for (let i = length - 1; i >= 0; i--) {
        out[i] = rest % 256
        rest = Math.floor(rest / 256)
      }
      out[0] |= 0x80 >> (length - 1)
      return out
    }
  }
  throw new Error('size too large')
}

function readUInt(buf, pos, length) {
  let value = 0
  for (let i = 0; i < length; i++) value = value * 256 + buf[pos + i]
  return value
}

/** 返回补好时长的新 Buffer；已有 Duration 或结构不认识时原样返回。 */
function fixDuration(buf, durationMs) {
  let pos = 0
  // EBML 头
  const header = readId(buf, pos)
  if (header.value !== 0x1a45dfa3) return buf
  pos += header.length
  const headerSize = readSize(buf, pos)
  pos += headerSize.length + headerSize.value
  // Segment
  const segment = readId(buf, pos)
  if (segment.value !== ID_SEGMENT) return buf
  pos += segment.length
  pos += readSize(buf, pos).length
  // 在 Segment 里找 Info（一般紧跟在 SeekHead 之后，位于第一个 Cluster 之前）
  while (pos < buf.length) {
    const id = readId(buf, pos)
    const size = readSize(buf, pos + id.length)
    const contentStart = pos + id.length + size.length
    if (id.value === ID_INFO) {
      if (size.unknown) return buf
      const contentEnd = contentStart + size.value
      let scale = 1_000_000
      for (let p = contentStart; p < contentEnd;) {
        const childId = readId(buf, p)
        const childSize = readSize(buf, p + childId.length)
        const childStart = p + childId.length + childSize.length
        if (childId.value === ID_DURATION) return buf
        if (childId.value === ID_TIMECODE_SCALE) scale = readUInt(buf, childStart, childSize.value)
        p = childStart + childSize.value
      }
      const duration = Buffer.alloc(8)
      duration.writeDoubleBE((durationMs * 1_000_000) / scale)
      const element = Buffer.concat([Buffer.from([0x44, 0x89, 0x88]), duration])
      const content = Buffer.concat([buf.subarray(contentStart, contentEnd), element])
      const info = Buffer.concat([Buffer.from([0x15, 0x49, 0xa9, 0x66]), encodeSize(content.length), content])
      return Buffer.concat([buf.subarray(0, pos), info, buf.subarray(contentEnd)])
    }
    if (size.unknown || id.value === 0x1f43b675) return buf // 到了 Cluster 还没见到 Info
    pos = contentStart + size.value
  }
  return buf
}

module.exports = { fixDuration, readId, readSize, encodeSize }
