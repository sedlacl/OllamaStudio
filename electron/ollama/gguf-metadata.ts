import { openSync, readSync, closeSync, statSync } from 'fs'

const GGUF_MAGIC = 0x46554747
const MAX_HEADER_BYTES = 2 * 1024 * 1024

const GGUF_TYPE = {
  UINT8: 0,
  INT8: 1,
  UINT16: 2,
  INT16: 3,
  UINT32: 4,
  INT32: 5,
  FLOAT32: 6,
  BOOL: 7,
  STRING: 8,
  ARRAY: 9,
  UINT64: 10,
  INT64: 11,
  FLOAT64: 12
} as const

export function readGgufStringMetadata(filePath: string, keys: string[]): Record<string, string> {
  const size = statSync(filePath).size
  const length = Math.min(size, MAX_HEADER_BYTES)
  const buf = Buffer.alloc(length)
  const fd = openSync(filePath, 'r')
  try {
    readSync(fd, buf, 0, length, 0)
  } finally {
    closeSync(fd)
  }
  return parseGgufStringMetadata(buf, keys)
}

export function parseGgufStringMetadata(buf: Buffer, keys: string[]): Record<string, string> {
  const wanted = new Set(keys)
  const found: Record<string, string> = {}
  if (buf.length < 24) return found
  const view = new DataView(buf.buffer, buf.byteOffset, buf.byteLength)
  if (view.getUint32(0, true) !== GGUF_MAGIC) return found
  let offset = 8
  const version = view.getUint32(4, true)
  if (version >= 2) {
    offset = 24
  } else {
    return found
  }
  const kvCount = Number(view.getBigUint64(16, true))
  if (!Number.isFinite(kvCount) || kvCount < 0 || kvCount > 10_000) return found

  for (let i = 0; i < kvCount && offset < buf.length; i++) {
    const key = readString(view, buf, offset)
    if (!key) break
    offset = key.next
    const valueType = view.getUint32(offset, true)
    offset += 4
    if (valueType === GGUF_TYPE.STRING) {
      const value = readString(view, buf, offset)
      if (!value) break
      offset = value.next
      if (wanted.has(key.value)) found[key.value] = value.value
    } else {
      const skipped = skipValue(view, buf, offset, valueType)
      if (skipped == null) break
      offset = skipped
    }
    if (found && Object.keys(found).length === wanted.size) break
  }
  return found
}

export function ggufIsMmproj(filePath: string): boolean {
  const meta = readGgufStringMetadata(filePath, ['general.type', 'clip.projector_type'])
  const type = meta['general.type']?.trim().toLowerCase()
  if (type === 'mmproj' || type === 'clip') return true
  if (meta['clip.projector_type']) return true
  return false
}

function readString(
  view: DataView,
  buf: Buffer,
  offset: number
): { value: string; next: number } | null {
  if (offset + 8 > buf.length) return null
  const len = Number(view.getBigUint64(offset, true))
  const start = offset + 8
  if (!Number.isFinite(len) || len < 0 || start + len > buf.length) return null
  return {
    value: buf.subarray(start, start + len).toString('utf8'),
    next: start + len
  }
}

function skipValue(view: DataView, buf: Buffer, offset: number, valueType: number): number | null {
  const size = primitiveSize(valueType)
  if (size != null) {
    const next = offset + size
    return next > buf.length ? null : next
  }
  if (valueType === GGUF_TYPE.STRING) {
    const str = readString(view, buf, offset)
    return str?.next ?? null
  }
  if (valueType === GGUF_TYPE.ARRAY) {
    if (offset + 12 > buf.length) return null
    const itemType = view.getUint32(offset, true)
    const count = Number(view.getBigUint64(offset + 4, true))
    if (!Number.isFinite(count) || count < 0 || count > 1_000_000) return null
    let next = offset + 12
    const itemSize = primitiveSize(itemType)
    if (itemSize != null) {
      next += itemSize * count
      return next > buf.length ? null : next
    }
    for (let i = 0; i < count; i++) {
      const skipped = skipValue(view, buf, next, itemType)
      if (skipped == null) return null
      next = skipped
    }
    return next
  }
  return null
}

function primitiveSize(valueType: number): number | null {
  switch (valueType) {
    case GGUF_TYPE.UINT8:
    case GGUF_TYPE.INT8:
    case GGUF_TYPE.BOOL:
      return 1
    case GGUF_TYPE.UINT16:
    case GGUF_TYPE.INT16:
      return 2
    case GGUF_TYPE.UINT32:
    case GGUF_TYPE.INT32:
    case GGUF_TYPE.FLOAT32:
      return 4
    case GGUF_TYPE.UINT64:
    case GGUF_TYPE.INT64:
    case GGUF_TYPE.FLOAT64:
      return 8
    default:
      return null
  }
}
