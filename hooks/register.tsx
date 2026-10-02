import { atom, read, update } from 'claude-code'
import type { EngineInterface, Register } from 'claude-code'

import type { SurfClip, SurfStatus } from '../types'
import { fitCells, parsePpm, toCells, toSvg } from './frames'
import type { Frame } from './frames'

const PANE = 'subway-surfers'
const TITLE = 'Subway Surfers'
const MAX_SIDE = 192 // decoded frame's longest side, in pixels
const MAX_SECONDS = 180
const PREFETCH = 24
const BAKED = 'media/subway-surfers.mp4'

const status = atom({ plugin: 'subway-surfers', key: 'status' } as const, 'idle' as SurfStatus)
const message = atom({ plugin: 'subway-surfers', key: 'message' } as const, '')
const clipAtom = atom({ plugin: 'subway-surfers', key: 'clip' } as const, null as SurfClip | null)
const isPlaying = atom({ plugin: 'subway-surfers', key: 'isPlaying' } as const, false)
const isMuted = atom({ plugin: 'subway-surfers', key: 'isMuted' } as const, true)
const isAutoplay = atom({ plugin: 'subway-surfers', key: 'isAutoplay' } as const, true)
const tick = atom({ plugin: 'subway-surfers', key: 'tick' } as const, 0)
const position = atom({ plugin: 'subway-surfers', key: 'position' } as const, 0)

type $ = EngineInterface

// Pixel data and timers are the module's; anything a reload should keep is in $.state.

const isUrl = (source: string) => /^https?:\/\//i.test(source)
const frameName = (index: number) => `f${String(index + 1).padStart(5, '0')}.ppm`

async function hashOf(text: string) {
  const digest = await crypto.subtle.digest('SHA-1', new TextEncoder().encode(text))

  return [...new Uint8Array(digest)].slice(0, 6).map(b => b.toString(16).padStart(2, '0')).join('')
}

let fps = 12
let clip: SurfClip | null = null
let frameIndex = 0
let timer: { cancel: () => void } | null = null
let isTicking = false
let audio: AbortController | null = null
let audioBase64: string | null = null
let terminalBox: { columns: number; rows: number } | null = null
let isDesktopMounted = false
const frames = new Map<number, Promise<Frame | undefined>>()

function frameAt($: $, index: number) {
  if (!clip) return Promise.resolve(undefined)
  let pending = frames.get(index)
  if (!pending) {
    const dir = clip.dir
    pending = $.fs
      .read(`${dir}/${frameName(index)}`, { as: 'bytes' })
      .then(({ base64 }) => parsePpm(Uint8Array.fromBase64(base64)))
      .catch(() => undefined)
    frames.set(index, pending)
  }

  return pending
}

function prefetch($: $) {
  if (!clip) return
  for (let ahead = 1; ahead <= PREFETCH; ahead += 1) void frameAt($, (frameIndex + ahead) % clip.frameCount)
  for (const index of frames.keys()) {
    const behind = (frameIndex - index + clip.frameCount) % clip.frameCount
    if (behind > 2 && behind < clip.frameCount - PREFETCH - 1) frames.delete(index)
  }
}

async function findTool($: $, name: string) {
  for (const dir of ['/opt/homebrew/bin', '/usr/local/bin', '/usr/bin']) {
    if (await $.fs.exists(`${dir}/${name}`)) return `${dir}/${name}`
  }

  return name
}

function stopAudio() {
  audio?.abort()
  audio = null
}

async function startAudio($: $) {
  if (!clip?.hasAudio || audio || (await read($, isMuted))) return
  audioBase64 ??= (await $.fs.read(`${clip.dir}/audio.m4a`, { as: 'bytes' }).catch(() => null))?.base64 ?? null
  if (!audioBase64) return
  audio = new AbortController()
  $.audio
    .play({ base64: audioBase64, mime: 'audio/mp4' }, { shouldLoop: true, signal: audio.signal })
    .catch(error => $.ui.log(`subway-surfers: audio failed: ${String(error)}`, { to: 'debug' }))
}

async function step($: $) {
  if (!clip || isTicking) return
  isTicking = true
  try {
    frameIndex = (frameIndex + 1) % clip.frameCount
    prefetch($)
    if (terminalBox) {
      const frame = await frameAt($, frameIndex)
      const { columns, rows } = terminalBox
      void $.ui.blit({ requestId: PANE, key: 'video', cells: toCells(frame, columns, rows), columns, rows })
    }
    if (isDesktopMounted) await update($, tick, () => frameIndex)
    if (frameIndex % (fps * 2) === 0) await update($, position, () => frameIndex)
  } finally {
    isTicking = false
  }
}

async function play($: $) {
  if (!clip) return
  await update($, isPlaying, () => true)
  if (!timer) timer = $.clock.every(Math.round(1000 / fps), () => void step($))
  await startAudio($)
}

async function pause($: $) {
  timer?.cancel()
  timer = null
  stopAudio()
  await update($, isPlaying, () => false)
  await update($, position, () => frameIndex)
}

async function run($: $, argv: string[], timeoutMs = 600_000) {
  const result = await $.process.run(argv, { timeoutMs })
  if (result.exitCode !== 0) throw new Error(`${argv[0]?.split('/').pop()}: ${result.stderr.trim().split('\n').pop() ?? 'failed'}`)
}

async function load($: $, source: string) {
  await pause($)
  await update($, status, () => 'loading')
  try {
    const home = await $.env.get('HOME')
    const dir = `${home}/.cache/claude-subway-surfers/${await hashOf(`${source}@${fps}`)}`
    const metaPath = `${dir}/meta.json`
    let next: SurfClip
    if (await $.fs.exists(metaPath)) {
      next = JSON.parse(await $.fs.read(metaPath))
    } else {
      await run($, ['/bin/mkdir', '-p', dir])
      // No shell runs ffmpeg, so a leading ~ is ours to expand.
      let input = source.replace(/^~(?=\/|$)/, home ?? '~')
      const ffmpeg = await findTool($, 'ffmpeg')
      if (isUrl(source)) {
        await update($, message, () => 'Downloading clip…')
        input = `${dir}/src.mp4`
        const args = ['-q', '--no-playlist', '--ffmpeg-location', ffmpeg, '-f', 'b[height<=480]/bv*[height<=480]+ba/b', '--merge-output-format', 'mp4', '-o', input, source]
        const ytdlp = await findTool($, 'yt-dlp')
        // YouTube breaks older yt-dlp releases (HTTP 403): retry with the latest one via uvx.
        await run($, [ytdlp, ...args]).catch(async error => {
          const uvx = await findTool($, 'uvx')
          if (uvx === 'uvx') throw error
          await update($, message, () => 'Downloading clip with the latest yt-dlp…')
          await run($, [uvx, '--from', 'yt-dlp[default]@latest', 'yt-dlp', ...args])
        })
      }
      await update($, message, () => 'Decoding frames…')
      const scale = `scale='if(gt(iw,ih),${MAX_SIDE},-2)':'if(gt(iw,ih),-2,${MAX_SIDE})'`
      await run($, [ffmpeg, '-y', '-loglevel', 'error', '-t', String(MAX_SECONDS), '-i', input, '-vf', `fps=${fps},${scale}`, `${dir}/f%05d.ppm`])
      await update($, message, () => 'Extracting audio…')
      const hasAudio = await run($, [ffmpeg, '-y', '-loglevel', 'error', '-t', String(MAX_SECONDS), '-i', input, '-vn', '-c:a', 'aac', '-b:a', '96k', `${dir}/audio.m4a`])
        .then(() => true)
        .catch(() => false)
      const names = (await $.fs.list(dir)).map(entry => entry.name).filter(name => /^f\d+\.ppm$/.test(name))
      if (names.length === 0) throw new Error('ffmpeg produced no frames')
      const first = parsePpm(Uint8Array.fromBase64((await $.fs.read(`${dir}/${frameName(0)}`, { as: 'bytes' })).base64))
      next = { source, dir, frameCount: names.length, fps, width: first.width, height: first.height, hasAudio }
      await $.fs.write(metaPath, JSON.stringify(next))
    }
    clip = next
    frames.clear()
    audioBase64 = null
    frameIndex = 0
    await update($, clipAtom, () => next)
    await update($, position, () => 0)
    await update($, status, () => 'ready')
    await update($, message, () => '')
    $.ui.status(undefined)
    prefetch($)
  } catch (error) {
    await update($, status, () => 'error')
    await update($, message, () => error instanceof Error ? error.message : String(error))
    $.ui.toast(`Subway Surfers: ${error instanceof Error ? error.message : String(error)}`)
  }
}

export const register: Register = (on, options) => {
  fps = Math.max(1, Math.min(30, Number(options.fps) || 12))

  on('session.start', async ($, e, next) => {
    await $.command.register({
      name: 'brainrot',
      description: 'Subway Surfers while Claude works: /brainrot [file|url|on|off|sound|stop]',
      argumentHint: '[file|url|on|off|sound|stop]',
    })
    // A reload keeps $.state: pick the clip and the playhead back up.
    clip = await read($, clipAtom)
    frameIndex = await read($, position)
    if (clip && !(await $.fs.exists(`${clip.dir}/meta.json`))) clip = null
    if (!clip) {
      await update($, isMuted, () => !options.sound)
      await update($, isAutoplay, () => options.autoplay !== false)
      // The clip baked into the mod, unless the `video` option names another.
      const source = String(options.video || '') || `${$.plugin.root}/${BAKED}`
      $.clock.after(0, () => void load($, source))
    } else if (await read($, isPlaying)) {
      await update($, isPlaying, () => false)
    }

    return next(e)
  })

  on('command.run', { command: 'brainrot' }, async ($, e) => {
    const arg = e.args.trim()
    if (arg === 'on' || arg === 'off') {
      await update($, isAutoplay, () => arg === 'on')

      return { text: `Subway Surfers autoplay ${arg}.` }
    }
    if (arg === 'sound') {
      const muted = await update($, isMuted, value => !value)
      if (muted) stopAudio()
      else if (await read($, isPlaying)) await startAudio($)

      return { text: `Subway Surfers sound ${muted ? 'off' : 'on'}.` }
    }
    if (arg === 'stop') {
      await pause($)
      await $.ui.close({ id: PANE })

      return { text: 'Subway Surfers stopped.' }
    }
    await $.ui.open({ id: PANE, title: TITLE })
    if (arg || !clip) {
      const source = arg || String(options.video || '') || `${$.plugin.root}/${BAKED}`
      $.clock.after(0, () => void load($, source).then(() => play($)))

      return { text: arg ? `Loading ${arg} into Subway Surfers…` : 'Loading Subway Surfers…' }
    }
    await play($)

    return { text: 'Surfing.' }
  })

  on('turn.start', async ($, e, next) => {
    if (clip && (await read($, isAutoplay))) {
      await $.ui.open({ id: PANE, title: TITLE })
      await play($)
    }

    return next(e)
  })

  on('turn.complete', async ($, e, next) => {
    if (!e.agentId && timer) await pause($)

    return next(e)
  })

  on('ui.close', async ($, e, next) => {
    if (e.id === PANE) {
      await pause($)
      terminalBox = null
      isDesktopMounted = false
    }

    return next(e)
  })

  on('ui.render', { component: 'Pane', requestId: PANE }, async ($, e) => {
    const { Box, Text, Button } = $.ui.resolve(e)
    const state = await read($, status)
    const note = await read($, message)
    const playing = await read($, isPlaying)
    const muted = await read($, isMuted)
    const current = await read($, clipAtom)

    const header = (
      <Box flexDirection="row" gap={1}>
        <Text bold color="#f5c518">
          {playing ? '▶' : '⏸'} Subway Surfers
        </Text>
        {current && !playing && <Text dimColor>your turn</Text>}
        {current && (
          <Button key="play" hotkey="p" plain label={playing ? 'pause' : 'play'} onPress={() => (playing ? pause($) : play($))} />
        )}
        {current?.hasAudio && (
          <Button
            key="mute"
            hotkey="m"
            plain
            label={muted ? 'sound off' : 'sound on'}
            onPress={async () => {
              const next = await update($, isMuted, value => !value)
              if (next) stopAudio()
              else if (await read($, isPlaying)) await startAudio($)
            }}
          />
        )}
      </Box>
    )

    if (!current || state === 'loading' || state === 'error') {
      const line =
        state === 'loading'
          ? note || 'Loading…'
          : state === 'error'
            ? `Could not load: ${note}`
            : 'No clip loaded. /brainrot plays the built-in one.'

      return (
        <Box flexDirection="column">
          {header}
          <Text dimColor={state !== 'error'} color={state === 'error' ? 'red' : undefined}>
            {line}
          </Text>
        </Box>
      )
    }

    if (e.surface === 'terminal') {
      const { Raster } = $.ui.resolve(e)
      const box = fitCells(current.width, current.height, e.props.bodyColumns, Math.max(4, (e.viewport?.rows ?? 30) - 6))
      terminalBox = box
      const frame = await frameAt($, frameIndex)

      return (
        <Box flexDirection="column">
          {header}
          <Raster key="video" columns={box.columns} rows={box.rows} cells={toCells(frame, box.columns, box.rows)} />
        </Box>
      )
    }

    if (e.surface === 'desktop') {
      const { Svg } = $.ui.resolve(e)
      isDesktopMounted = true
      const index = await read($, tick)
      const frame = await frameAt($, index % current.frameCount)

      return (
        <Box flexDirection="column">
          {header}
          <Svg source={toSvg(frame, current.width, current.height)} alt="Subway Surfers gameplay" />
        </Box>
      )
    }

    return (
      <Box flexDirection="column">
        {header}
        <Text dimColor>The clip plays in the terminal and the desktop app.</Text>
      </Box>
    )
  })
}
