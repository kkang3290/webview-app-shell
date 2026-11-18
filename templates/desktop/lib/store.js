'use strict'
// NativeRecorder 的落盘部分（主进程）。与 iOS / Android 同一语义：每段 PCM 先写 chunk-%08d.pcm，
// 再推事件；页面补拉 readChunks、确认 ack 后才删除。桌面端原件是 MediaRecorder 写的 webm（Opus）。

const fs = require('node:fs')
const fsp = require('node:fs/promises')
const path = require('node:path')
const crypto = require('node:crypto')

const META_FILE = 'session.json'
const ARCHIVE_FILE = 'recording.webm'
const UUID = /^[0-9A-F]{8}-[0-9A-F]{4}-[0-9A-F]{4}-[0-9A-F]{4}-[0-9A-F]{12}$/

function chunkName(seq) {
  return `chunk-${String(seq).padStart(8, '0')}.pcm`
}

/** 只接受 UUID 形式的会话 ID，挡住页面传来的路径穿越。 */
function sessionDir(root, id) {
  if (typeof id !== 'string' || !UUID.test(id.toUpperCase())) throw new Error('invalid sessionId')
  const dir = path.join(root, id.toUpperCase())
  if (!fs.existsSync(dir)) throw new Error(`unknown session ${id}`)
  return dir
}

async function createSession(root) {
  const id = crypto.randomUUID().toUpperCase()
  const dir = path.join(root, id)
  await fsp.mkdir(dir, { recursive: true })
  return { id, dir }
}

async function atomicWrite(file, data) {
  const tmp = `${file}.tmp`
  await fsp.writeFile(tmp, data)
  await fsp.rename(tmp, file)
}

async function writeMeta(dir, meta) {
  await atomicWrite(path.join(dir, META_FILE), JSON.stringify(meta))
}

async function readMeta(dir) {
  return JSON.parse(await fsp.readFile(path.join(dir, META_FILE), 'utf8'))
}

async function writeChunk(dir, seq, pcm) {
  await atomicWrite(path.join(dir, chunkName(seq)), pcm)
}

async function readChunks(dir, afterSeq, limit) {
  const meta = await readMeta(dir)
  const chunks = []
  let seq = afterSeq + 1
  while (seq <= meta.lastSeq && chunks.length < limit) {
    try {
      chunks.push({ seq, pcm: await fsp.readFile(path.join(dir, chunkName(seq))) })
    } catch (error) {
      if (error.code !== 'ENOENT') throw error
    }
    seq += 1
  }
  return { lastSeq: meta.lastSeq, sampleRate: meta.sampleRate, chunks, hasMore: seq <= meta.lastSeq }
}

async function deleteChunks(dir, uptoSeq) {
  let removed = 0
  for (const name of await fsp.readdir(dir)) {
    const match = /^chunk-(\d{8})\.pcm$/.exec(name)
    if (match && Number(match[1]) <= uptoSeq) {
      await fsp.rm(path.join(dir, name), { force: true })
      removed += 1
    }
  }
  return removed
}

async function list(root) {
  let names
  try {
    names = await fsp.readdir(root)
  } catch (error) {
    if (error.code === 'ENOENT') return []
    throw error
  }
  const sessions = []
  for (const name of names) {
    try {
      const meta = await readMeta(path.join(root, name))
      sessions.push({ ...meta, filePath: path.join(root, name, ARCHIVE_FILE) })
    } catch {
      // 半成品目录（建了还没写元数据）跳过
    }
  }
  return sessions
}

/** 16 位小端 PCM 的峰值电平 0..1（三位小数）。 */
function level(pcm) {
  let peak = 0
  for (let i = 0; i + 1 < pcm.length; i += 2) peak = Math.max(peak, Math.abs(pcm.readInt16LE(i)))
  return Math.round((peak / 32768) * 1000) / 1000
}

module.exports = {
  META_FILE, ARCHIVE_FILE, chunkName, sessionDir, createSession, writeMeta, readMeta, writeChunk, readChunks,
  deleteChunks, list, level,
}
