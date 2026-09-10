import {
  closeSync,
  existsSync,
  fsyncSync,
  mkdirSync,
  openSync,
  renameSync,
  unlinkSync,
  writeFileSync
} from 'fs'
import { dirname } from 'path'
import { randomUUID } from 'crypto'

/** Zapíše JSON přes fsync + atomický rename ve stejném adresáři. */
export function atomicWriteJson(path: string, data: unknown): void {
  const dir = dirname(path)
  if (!existsSync(dir)) mkdirSync(dir, { recursive: true })
  const tmp = `${path}.${process.pid}.${randomUUID()}.tmp`
  let fd: number | null = null
  try {
    fd = openSync(tmp, 'wx')
    writeFileSync(fd, JSON.stringify(data, null, 2), 'utf-8')
    fsyncSync(fd)
    closeSync(fd)
    fd = null
    renameSync(tmp, path)
  } finally {
    if (fd != null) closeSync(fd)
    if (existsSync(tmp)) unlinkSync(tmp)
  }
}
