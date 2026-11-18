'use strict'
// NativeRecorder 主进程侧：采集在页面（预加载脚本）里做——桌面端不会挂起页面——每段 PCM 与原件片段
// 经 IPC 交到这里落盘。会话目录与手机端同一结构，补拉 / 确认 / 恢复语义一致。

const fsp = require('node:fs/promises')
const path = require('node:path')
const { powerSaveBlocker } = require('electron')
const store = require('./store')
const { fixDuration } = require('./webm')

function createRecorder({ root, guard }) {
  let active = null // { id, dir, meta, blocker, archive }

  async function persist() {
    await store.writeMeta(active.dir, active.meta)
  }

  function requireActive(sessionId) {
    if (!active || active.id !== String(sessionId).toUpperCase()) throw new Error('no active recording with this sessionId')
    return active
  }

  guard.handle('appshell:recorder:begin', async ({ sampleRate, chunkMs, label }) => {
    if (active) throw new Error('a recording is already active')
    if (![8000, 16000, 24000, 48000].includes(sampleRate)) throw new Error('sampleRate must be 8000, 16000, 24000 or 48000')
    if (!Number.isInteger(chunkMs) || chunkMs < 200 || chunkMs > 5000) throw new Error('chunkMs must be 200..5000')
    const { id, dir } = await store.createSession(root)
    active = {
      id,
      dir,
      // 录音期间不让系统睡眠挂起应用（屏幕可以关）。
      blocker: powerSaveBlocker.start('prevent-app-suspension'),
      archive: await fsp.open(path.join(dir, store.ARCHIVE_FILE), 'a'),
      meta: {
        sessionId: id, label: typeof label === 'string' ? label : '', state: 'recording', lastSeq: 0, sampleRate,
        startedAt: new Date().toISOString(), durationMs: 0, interruptions: 0,
      },
    }
    await persist()
    return { sessionId: id, filePath: path.join(dir, store.ARCHIVE_FILE) }
  })

  guard.handle('appshell:recorder:chunk', async ({ sessionId, seq, pcm }) => {
    const session = requireActive(sessionId)
    if (seq !== session.meta.lastSeq + 1) throw new Error(`out of order chunk ${seq} (expected ${session.meta.lastSeq + 1})`)
    const data = Buffer.from(pcm)
    if (data.length % 2 !== 0) throw new Error('pcm must be 16-bit')
    await store.writeChunk(session.dir, seq, data)
    session.meta.lastSeq = seq
    session.meta.durationMs += Math.round((data.length / 2 / session.meta.sampleRate) * 1000)
    await persist()
    return { level: store.level(data) }
  })

  guard.handle('appshell:recorder:archive', async ({ sessionId, data }) => {
    const session = requireActive(sessionId)
    await session.archive.write(Buffer.from(data))
    return true
  })

  guard.handle('appshell:recorder:state', async ({ sessionId, state, interrupted }) => {
    const session = requireActive(sessionId)
    if (!['recording', 'paused', 'interrupted'].includes(state)) throw new Error('bad state')
    session.meta.state = state
    if (interrupted) session.meta.interruptions += 1
    await persist()
    return true
  })

  guard.handle('appshell:recorder:finish', async ({ sessionId }) => {
    const session = requireActive(sessionId)
    active = null
    powerSaveBlocker.stop(session.blocker)
    await session.archive.close()
    // MediaRecorder 的 WebM 没有时长；补上 Duration，播放器与服务端才读得到时长。
    const archivePath = path.join(session.dir, store.ARCHIVE_FILE)
    try {
      const original = await fsp.readFile(archivePath)
      const fixed = fixDuration(original, session.meta.durationMs)
      if (fixed !== original) {
        await fsp.writeFile(`${archivePath}.tmp`, fixed)
        await fsp.rename(`${archivePath}.tmp`, archivePath)
      }
    } catch (error) {
      console.error('[appshell] webm duration fix failed', error)
    }
    session.meta.state = 'stopped'
    await store.writeMeta(session.dir, session.meta)
    return { ...session.meta, filePath: path.join(session.dir, store.ARCHIVE_FILE) }
  })

  guard.handle('appshell:recorder:readChunks', async ({ sessionId, afterSeq, limit }) => {
    if (!Number.isInteger(afterSeq) || !Number.isInteger(limit) || limit < 1 || limit > 120) {
      throw new Error('sessionId, afterSeq and limit (1..120) are required')
    }
    const page = await store.readChunks(store.sessionDir(root, sessionId), afterSeq, limit)
    return {
      sessionId: String(sessionId).toUpperCase(),
      lastSeq: page.lastSeq,
      hasMore: page.hasMore,
      chunks: page.chunks.map(chunk => ({
        seq: chunk.seq, sampleRate: page.sampleRate, level: store.level(chunk.pcm), data: chunk.pcm.toString('base64'),
      })),
    }
  })

  guard.handle('appshell:recorder:ack', async ({ sessionId, uptoSeq }) => {
    if (!Number.isInteger(uptoSeq)) throw new Error('uptoSeq is required')
    return { removed: await store.deleteChunks(store.sessionDir(root, sessionId), uptoSeq) }
  })

  guard.handle('appshell:recorder:list', async () => {
    const sessions = await store.list(root)
    return { sessions: sessions.map(meta => ({ ...meta, active: active !== null && meta.sessionId === active.id })) }
  })

  guard.handle('appshell:recorder:discard', async ({ sessionId }) => {
    const dir = store.sessionDir(root, sessionId)
    if (active && active.dir === dir) throw new Error('stop the recording before discarding it')
    await fsp.rm(dir, { recursive: true, force: true })
    return true
  })

  return {
    hasActive: () => active !== null,
    /** 退出前收尾：页面来不及 stop 时至少把元数据与原件句柄关好，已落盘的段留给下次恢复。 */
    async abandon() {
      if (!active) return
      const session = active
      active = null
      powerSaveBlocker.stop(session.blocker)
      session.meta.state = 'interrupted'
      await session.archive.close().catch(() => {})
      await store.writeMeta(session.dir, session.meta).catch(() => {})
    },
  }
}

module.exports = { createRecorder }
