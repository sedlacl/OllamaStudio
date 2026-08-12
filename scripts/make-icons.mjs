/**
 * Vygeneruje build/icon.ico + build/icon-256.png ze zdrojového PNG.
 * Běží v Electronu (nativeImage.resize) — bez extra závislostí.
 *
 * Usage: node scripts/make-icons.mjs <source.png> [--fit[=procenta]] [--transparent] [--preview]
 *
 * --fit          motiv (nepodkladové pixely) se zvětší tak, aby vyplnil zadaná procenta
 *                plochy; poměr stran i vzhled zůstávají, jen se přiblíží. Zakulacený
 *                okraj se obnoví z alfa kanálu originálu. Výchozí 96 %.
 * --transparent  odstraní tmavý podklad okolo motivu (průhledné pozadí ikony).
 * --preview      uloží do TEMP zvětšené náhledy 16/32/48 px pro kontrolu čitelnosti
 *                v titulku okna a na taskbaru.
 */
import { spawn } from 'child_process'
import { createRequire } from 'module'
import { existsSync, mkdirSync, writeFileSync } from 'fs'
import { tmpdir } from 'os'
import { dirname, join, resolve } from 'path'
import { fileURLToPath } from 'url'

const __dirname = dirname(fileURLToPath(import.meta.url))
const root = join(__dirname, '..')
const require = createRequire(import.meta.url)
const electronPath = require('electron')

const args = process.argv.slice(2)
const withPreview = args.includes('--preview')
const withTransparency = args.includes('--transparent')
const fitArg = args.find((a) => a === '--fit' || a.startsWith('--fit='))
const fitPercent = fitArg ? Number(fitArg.split('=')[1] ?? 96) : null
if (fitArg && (!Number.isFinite(fitPercent) || fitPercent <= 0 || fitPercent > 100)) {
  console.error(`Invalid --fit value: ${fitArg}`)
  process.exit(1)
}

const source = resolve(
  args.find((a) => !a.startsWith('--')) ?? join(root, 'build', 'icon-source.png')
)
if (!existsSync(source)) {
  console.error(`Source PNG not found: ${source}`)
  process.exit(1)
}

const previewDir = join(tmpdir(), 'ollamastudio-icon-preview')
if (withPreview) mkdirSync(previewDir, { recursive: true })

const runner = join(root, 'scripts', '_make-icons-main.mjs')
writeFileSync(
  runner,
  `
import { app, nativeImage } from 'electron'
import { writeFileSync } from 'fs'
import { join } from 'path'

const source = ${JSON.stringify(source)}
const buildDir = ${JSON.stringify(join(root, 'build'))}
const previewDir = ${JSON.stringify(withPreview ? previewDir : null)}
const fitPercent = ${JSON.stringify(fitPercent)}
const transparent = ${JSON.stringify(withTransparency)}
const SIZES = [16, 24, 32, 48, 64, 128, 256]

/** Podklad je tmavý, motiv barevný — stačí prahovat nejsvětlejší kanál. */
const SUBJECT_MIN_CHANNEL = 60

/** ICO se PNG payloadem (podporuje Windows Vista+). */
function buildIco(entries) {
  const header = Buffer.alloc(6)
  header.writeUInt16LE(0, 0)
  header.writeUInt16LE(1, 2)
  header.writeUInt16LE(entries.length, 4)

  const dir = Buffer.alloc(16 * entries.length)
  let offset = header.length + dir.length

  entries.forEach((entry, i) => {
    const base = i * 16
    dir.writeUInt8(entry.size >= 256 ? 0 : entry.size, base)
    dir.writeUInt8(entry.size >= 256 ? 0 : entry.size, base + 1)
    dir.writeUInt8(0, base + 2)
    dir.writeUInt8(0, base + 3)
    dir.writeUInt16LE(1, base + 4)
    dir.writeUInt16LE(32, base + 6)
    dir.writeUInt32LE(entry.png.length, base + 8)
    dir.writeUInt32LE(offset, base + 12)
    offset += entry.png.length
  })

  return Buffer.concat([header, dir, ...entries.map((e) => e.png)])
}

/** Obálka barevného motivu v BGRA bitmapě. */
function subjectBounds(bmp, width, height) {
  let minX = width
  let minY = height
  let maxX = -1
  let maxY = -1

  for (let y = 0; y < height; y++) {
    for (let x = 0; x < width; x++) {
      const i = (y * width + x) * 4
      if (bmp[i + 3] < 8) continue
      if (Math.max(bmp[i], bmp[i + 1], bmp[i + 2]) <= SUBJECT_MIN_CHANNEL) continue
      if (x < minX) minX = x
      if (x > maxX) maxX = x
      if (y < minY) minY = y
      if (y > maxY) maxY = y
    }
  }

  return maxX < 0 ? null : { minX, minY, maxX, maxY }
}

/**
 * Přiblíží obrázek tak, aby motiv vyplnil fitPercent plochy: zvětší celou grafiku
 * a vyřízne z ní původní rozměr se středem na motivu. Zakulacený okraj se obnoví
 * podle alfa kanálu originálu (BGRA je premultiplikovaná, proto i škálování RGB).
 */
function fitSubject(img, percent) {
  const { width, height } = img.getSize()
  const bmp = img.toBitmap()
  const box = subjectBounds(bmp, width, height)
  if (!box) return { img, scale: 1 }

  const boxW = box.maxX - box.minX + 1
  const boxH = box.maxY - box.minY + 1
  const target = percent / 100
  const scale = Math.min((width * target) / boxW, (height * target) / boxH)
  if (scale <= 1.001) return { img, scale: 1 }

  const scaledW = Math.round(width * scale)
  const scaledH = Math.round(height * scale)
  const scaled = img.resize({ width: scaledW, height: scaledH, quality: 'best' })

  const centerX = ((box.minX + box.maxX + 1) / 2) * scale
  const centerY = ((box.minY + box.maxY + 1) / 2) * scale
  const x = Math.max(0, Math.min(scaledW - width, Math.round(centerX - width / 2)))
  const y = Math.max(0, Math.min(scaledH - height, Math.round(centerY - height / 2)))

  const out = Buffer.from(scaled.crop({ x, y, width, height }).toBitmap())
  for (let i = 0; i < out.length; i += 4) {
    const a = bmp[i + 3]
    if (a === 255) continue
    const f = a / 255
    out[i] = Math.round(out[i] * f)
    out[i + 1] = Math.round(out[i + 1] * f)
    out[i + 2] = Math.round(out[i + 2] * f)
    out[i + 3] = a
  }

  return { img: nativeImage.createFromBitmap(out, { width, height }), scale }
}

/** Podklad hledáme zaplavením od okraje, aby tmavé detaily uvnitř motivu zůstaly. */
const PLATE_MAX_CHANNEL = 200
/** Mez pro „ještě podklad“ počítáme z histogramu, tohle je jen bezpečný rozsah. */
const PLATE_FLOOR_MIN = 8
const PLATE_FLOOR_MAX = 96

/** Zbytková alfa pod touto hodnotou je závoj z vinětace, ne hrana kresby. */
const ALPHA_EPSILON = 12

/**
 * Podklad není čistě černý (vinětace, komprese), práh proto bereme z 99. percentilu
 * jeho úrovní — nad ním už jsou jen vyhlazené hrany motivu.
 */
function plateFloor(levels, count) {
  let seen = 0
  const limit = count * 0.99
  for (let level = 0; level < levels.length; level++) {
    seen += levels[level]
    if (seen >= limit) {
      return Math.max(PLATE_FLOOR_MIN, Math.min(PLATE_FLOOR_MAX, level + 2))
    }
  }
  return PLATE_FLOOR_MIN
}

/**
 * Zprůhledňuje tmavý podklad. Motiv je vykreslený na černé, takže hodnota pixelu
 * odpovídá jeho krytí — z ní vzniká alfa a RGB zůstává (BGRA je premultiplikovaná),
 * což zachová hladké hrany bez tmavého lemu.
 */
function dropDarkBackground(img) {
  const { width, height } = img.getSize()
  const out = Buffer.from(img.toBitmap())
  const background = new Uint8Array(width * height)
  const stack = []

  const consider = (x, y) => {
    if (x < 0 || y < 0 || x >= width || y >= height) return
    const p = y * width + x
    if (background[p]) return
    const i = p * 4
    if (Math.max(out[i], out[i + 1], out[i + 2]) > PLATE_MAX_CHANNEL) return
    background[p] = 1
    stack.push(p)
  }

  for (let x = 0; x < width; x++) {
    consider(x, 0)
    consider(x, height - 1)
  }
  for (let y = 0; y < height; y++) {
    consider(0, y)
    consider(width - 1, y)
  }

  while (stack.length) {
    const p = stack.pop()
    const x = p % width
    const y = (p - x) / width
    consider(x - 1, y)
    consider(x + 1, y)
    consider(x, y - 1)
    consider(x, y + 1)
  }

  const levels = new Uint32Array(256)
  let backgroundCount = 0
  for (let p = 0; p < background.length; p++) {
    if (!background[p]) continue
    const i = p * 4
    levels[Math.max(out[i], out[i + 1], out[i + 2])]++
    backgroundCount++
  }

  const floor = plateFloor(levels, backgroundCount)
  const span = 255 - floor
  let cleared = 0

  for (let p = 0; p < background.length; p++) {
    if (!background[p]) continue
    const i = p * 4
    const level = Math.max(out[i], out[i + 1], out[i + 2])
    const raw = level <= floor ? 0 : Math.round(((level - floor) / span) * 255)
    const alpha = raw <= ALPHA_EPSILON ? 0 : raw
    out[i + 3] = Math.min(out[i + 3], alpha)
    if (out[i + 3] === 0) {
      // Nulová alfa s nenulovým RGB dá po un-premultiply bílý závoj.
      out[i] = 0
      out[i + 1] = 0
      out[i + 2] = 0
      cleared++
    }
  }

  return {
    img: nativeImage.createFromBitmap(out, { width, height }),
    floor,
    clearedPercent: (cleared / background.length) * 100
  }
}

app.whenReady().then(() => {
  let img = nativeImage.createFromPath(source)
  if (img.isEmpty()) {
    console.error('Failed to read source image')
    app.exit(1)
    return
  }

  if (fitPercent != null) {
    const fitted = fitSubject(img, fitPercent)
    img = fitted.img
    console.log('fit ' + fitPercent + '%: motiv zvětšen ' + fitted.scale.toFixed(3) + 'x')
  }

  if (transparent) {
    const cut = dropDarkBackground(img)
    img = cut.img
    console.log(
      'transparent: práh ' + cut.floor + ', průhledných ' + cut.clearedPercent.toFixed(1) + ' % plochy'
    )
  }

  const entries = SIZES.map((size) => {
    const small = img.resize({ width: size, height: size, quality: 'best' })
    return { size, small, png: small.toPNG() }
  })

  writeFileSync(join(buildDir, 'icon.ico'), buildIco(entries))
  writeFileSync(join(buildDir, 'icon-256.png'), entries.find((e) => e.size === 256).png)
  console.log('wrote build/icon.ico (' + SIZES.join(',') + ') and build/icon-256.png')

  if (previewDir) {
    for (const size of [16, 32, 48]) {
      const small = entries.find((e) => e.size === size).small
      // 8x zvětšení bez dalšího vyhlazení ukáže, co z detailu v malé velikosti zbylo
      const zoomed = small.resize({ width: size * 8, height: size * 8, quality: 'good' })
      writeFileSync(join(previewDir, 'preview-' + size + '.png'), zoomed.toPNG())
    }
    console.log('previews: ' + previewDir)
  }

  app.exit(0)
})
`.trim(),
  'utf-8'
)

const env = { ...process.env }
delete env.NODE_OPTIONS

const child = spawn(electronPath, [runner], {
  cwd: root,
  stdio: 'inherit',
  env,
  windowsHide: true
})

child.on('exit', (code) => process.exit(code ?? 0))
