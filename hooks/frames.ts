// Pure pixel helpers: no `$`, no state.

// The environment has these (ES2025); TypeScript's es2023 lib does not declare them yet.
declare global {
  interface Uint8Array {
    toBase64(): string
  }
  interface Uint8ArrayConstructor {
    fromBase64(base64: string): Uint8Array
  }
}

export type Frame = { width: number; height: number; rgb: Uint8Array }

const UPPER_HALF = 0x2580 // ▀: foreground paints the top pixel, background the bottom

// Binary PPM (P6, maxval 255) as ffmpeg writes it.
export function parsePpm(bytes: Uint8Array): Frame {
  let at = 0
  const token = () => {
    while (at < bytes.length && /\s/.test(String.fromCharCode(bytes[at] ?? 32))) at += 1
    const start = at
    while (at < bytes.length && !/\s/.test(String.fromCharCode(bytes[at] ?? 32))) at += 1
    return String.fromCharCode(...bytes.subarray(start, at))
  }
  if (token() !== 'P6') throw new Error('not a P6 ppm')
  const width = Number(token())
  const height = Number(token())
  token() // maxval
  at += 1 // the single whitespace before the pixels

  return { width, height, rgb: bytes.subarray(at, at + width * height * 3) }
}

// The largest cell box with the clip's aspect that fits, two pixels per cell vertically.
export function fitCells(width: number, height: number, maxColumns: number, maxRows: number) {
  let columns = Math.max(1, Math.min(512, maxColumns))
  let rows = Math.round((columns * height) / width / 2)
  if (rows > maxRows) {
    rows = maxRows
    columns = Math.round((rows * 2 * width) / height)
  }

  return { columns: Math.max(1, Math.min(512, columns)), rows: Math.max(1, Math.min(256, rows)) }
}

function sample(frame: Frame, x: number, y: number, columns: number, pixelRows: number) {
  const sx = Math.min(frame.width - 1, Math.floor(((x + 0.5) * frame.width) / columns))
  const sy = Math.min(frame.height - 1, Math.floor(((y + 0.5) * frame.height) / pixelRows))
  const i = (sy * frame.width + sx) * 3

  return ((frame.rgb[i] ?? 0) << 16) | ((frame.rgb[i + 1] ?? 0) << 8) | (frame.rgb[i + 2] ?? 0)
}

// RasterProps `cells`: base64 of [codePoint, fg, bg] u32 triplets, row-major.
export function toCells(frame: Frame | undefined, columns: number, rows: number): string {
  const words = new Uint32Array(columns * rows * 3)
  for (let row = 0; row < rows; row += 1) {
    for (let x = 0; x < columns; x += 1) {
      const at = (row * columns + x) * 3
      words[at] = UPPER_HALF
      words[at + 1] = frame ? sample(frame, x, row * 2, columns, rows * 2) : 0
      words[at + 2] = frame ? sample(frame, x, row * 2 + 1, columns, rows * 2) : 0
    }
  }

  return new Uint8Array(words.buffer).toBase64()
}

// A 24-bit BMP of the frame, for the desktop's Svg (no zlib needed, unlike PNG).
function toBmp(frame: Frame): Uint8Array {
  const stride = (frame.width * 3 + 3) & ~3
  const size = 54 + stride * frame.height
  const out = new Uint8Array(size)
  const view = new DataView(out.buffer)
  out[0] = 0x42
  out[1] = 0x4d
  view.setUint32(2, size, true)
  view.setUint32(10, 54, true)
  view.setUint32(14, 40, true)
  view.setInt32(18, frame.width, true)
  view.setInt32(22, -frame.height, true) // top-down rows
  view.setUint16(26, 1, true)
  view.setUint16(28, 24, true)
  view.setUint32(34, stride * frame.height, true)
  for (let y = 0; y < frame.height; y += 1) {
    for (let x = 0; x < frame.width; x += 1) {
      const from = (y * frame.width + x) * 3
      const to = 54 + y * stride + x * 3
      out[to] = frame.rgb[from + 2] ?? 0
      out[to + 1] = frame.rgb[from + 1] ?? 0
      out[to + 2] = frame.rgb[from] ?? 0
    }
  }

  return out
}

export function toSvg(frame: Frame | undefined, width: number, height: number): string {
  const body = frame
    ? `<image href="data:image/bmp;base64,${toBmp(frame).toBase64()}" width="${width}" height="${height}" preserveAspectRatio="none" style="image-rendering:pixelated"/>`
    : `<rect width="${width}" height="${height}" fill="#000"/>`

  return `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 ${width} ${height}" width="${width * 4}" height="${height * 4}">${body}</svg>`
}
