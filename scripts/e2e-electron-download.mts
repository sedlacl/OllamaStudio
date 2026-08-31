/**
 * Dev-only Playwright/CDP harness — connects to a running Electron renderer with preload.
 * Non-destructive: no Logs page, no auth reads, no downloads, no folder deletes.
 *
 * Usage: OLLAMA_STUDIO_REMOTE_DEBUG_PORT=9344 npm run e2e:electron-download
 */
import { execFileSync, spawn, type ChildProcess } from 'child_process'
import { createWriteStream, existsSync, mkdirSync, readFileSync, statSync, writeFileSync } from 'fs'
import { dirname, join } from 'path'
import { fileURLToPath } from 'url'
import { chromium, type Browser, type ConsoleMessage, type Page } from 'playwright'

const __dirname = dirname(fileURLToPath(import.meta.url))
const ROOT = join(__dirname, '..')
const OUTPUT_DIR = join(ROOT, '.tmp', 'e2e-output')
const DEFAULT_PORT = 9344
const REMOTE_DEBUG_ENV = 'OLLAMA_STUDIO_REMOTE_DEBUG_PORT'
const REPO_MARKER = 'OllamaStudio'

mkdirSync(OUTPUT_DIR, { recursive: true })

const port = Number.parseInt(process.env[REMOTE_DEBUG_ENV] ?? String(DEFAULT_PORT), 10)
if (!Number.isInteger(port) || port < 1024 || port > 65535) {
  console.error(`Invalid ${REMOTE_DEBUG_ENV}: ${process.env[REMOTE_DEBUG_ENV]}`)
  process.exit(2)
}

const CDP_URL = `http://127.0.0.1:${port}`
const summary: Record<string, unknown> = {
  startedAt: new Date().toISOString(),
  port,
  cdpUrl: CDP_URL,
  devRestarted: false,
  connectedToElectronRenderer: false,
  preload: { windowElectron: false, windowOllamaStudio: false },
  blocker: null as string | null,
  navigation: [] as string[],
  downloadDiagnostics: null as unknown,
  uiDiagnostics: null as unknown,
  screenshots: [] as string[],
  consoleSummary: [] as { type: string; text: string }[]
}

function log(msg: string): void {
  console.log(msg)
}

function fail(blocker: string, code = 1): never {
  summary.blocker = blocker
  writeSummary()
  console.error(`BLOCKER: ${blocker}`)
  process.exit(code)
}

function writeSummary(): void {
  summary.finishedAt = new Date().toISOString()
  writeFileSync(join(OUTPUT_DIR, 'summary.json'), JSON.stringify(summary, null, 2), 'utf8')
}

function userDataDir(): string {
  if (process.platform === 'win32') {
    const appData = process.env.APPDATA
    if (!appData) return join(process.env.USERPROFILE ?? '', 'AppData', 'Roaming', 'ollamastudio')
    return join(appData, 'ollamastudio')
  }
  const home = process.env.HOME ?? ''
  return join(home, '.config', 'ollamastudio')
}

interface PersistedDownloadProbe {
  active: boolean
  reason: string
  status?: string
  folderName?: string
  updatedAt?: number
  folderMtimeMs?: number
}

function probeActiveDownload(): PersistedDownloadProbe {
  const persistFile = join(userDataDir(), 'tabby-download.json')
  if (!existsSync(persistFile)) {
    return { active: false, reason: 'no-persist-file' }
  }

  let parsed: { session?: { status?: string; folderName?: string; updatedAt?: number } }
  try {
    parsed = JSON.parse(readFileSync(persistFile, 'utf8'))
  } catch {
    return { active: false, reason: 'unreadable-persist-file' }
  }

  const session = parsed.session
  if (!session) return { active: false, reason: 'no-session-in-persist' }

  const status = session.status ?? 'unknown'
  if (status !== 'running') {
    return { active: false, reason: 'session-not-running', status }
  }

  const updatedAt = session.updatedAt ?? 0
  const ageMs = Date.now() - updatedAt
  const recentlyUpdated = ageMs >= 0 && ageMs < 120_000

  let folderMtimeMs: number | undefined
  const configFile = join(userDataDir(), 'config.json')
  if (existsSync(configFile) && session.folderName) {
    try {
      const config = JSON.parse(readFileSync(configFile, 'utf8')) as {
        tabby?: { installDir?: string; modelDir?: string }
      }
      const installDir = config.tabby?.installDir ?? 'D:\\AI\\Tabby'
      const modelRoot = config.tabby?.modelDir?.trim()
        ? config.tabby.modelDir
        : join(installDir, 'models')
      const folderPath = join(modelRoot, session.folderName)
      if (existsSync(folderPath)) {
        folderMtimeMs = statSync(folderPath).mtimeMs
        const folderAgeMs = Date.now() - folderMtimeMs
        if (folderAgeMs < 60_000) {
          return {
            active: true,
            reason: 'running-session-with-recent-folder-mtime',
            status,
            folderName: session.folderName,
            updatedAt,
            folderMtimeMs
          }
        }
      }
    } catch {
      /* ignore config parse errors */
    }
  }

  if (recentlyUpdated) {
    return {
      active: true,
      reason: 'running-session-recently-updated',
      status,
      folderName: session.folderName,
      updatedAt,
      folderMtimeMs
    }
  }

  return {
    active: false,
    reason: 'stale-running-session-marker',
    status,
    folderName: session.folderName,
    updatedAt,
    folderMtimeMs
  }
}

function powershell(script: string): string {
  return execFileSync(
    'powershell',
    ['-NoProfile', '-EncodedCommand', Buffer.from(script, 'utf16le').toString('base64')],
    { windowsHide: true, encoding: 'utf-8' }
  )
}

function listRepoDevPids(): number[] {
  if (process.platform !== 'win32') return []
  try {
    const out = powershell(
      [
        "$ErrorActionPreference = 'SilentlyContinue'",
        `$marker = '${REPO_MARKER}'`,
        '$pids = @()',
        "Get-CimInstance Win32_Process | Where-Object {",
        '  $_.CommandLine -and $_.CommandLine -like "*$marker*" -and (',
        "    $_.Name -eq 'node.exe' -or $_.Name -eq 'electron.exe' -or $_.Name -eq 'esbuild.exe'",
        '  )',
        '} | ForEach-Object { $pids += $_.ProcessId }',
        '$pids | Sort-Object -Unique'
      ].join('\n')
    )
    return out
      .split(/\r?\n/)
      .map((line) => line.replace(/[^\d]/g, ''))
      .map((line) => Number.parseInt(line, 10))
      .filter((n) => Number.isInteger(n) && n > 0)
  } catch {
    return []
  }
}

function stopRepoDevProcesses(): void {
  const pids = listRepoDevPids()
  log(`repo dev pids to stop: ${pids.join(', ') || '(none)'}`)
  for (const pid of pids) {
    try {
      execFileSync('taskkill', ['/PID', String(pid), '/T', '/F'], {
        windowsHide: true,
        stdio: 'ignore'
      })
      log(`stopped repo dev pid ${pid}`)
    } catch {
      /* already gone */
    }
  }
  if (pids.length > 0) {
    execFileSync('powershell', ['-NoProfile', '-Command', 'Start-Sleep -Seconds 2'], {
      windowsHide: true,
      stdio: 'ignore'
    })
  }
}

async function wait(ms: number): Promise<void> {
  await new Promise((r) => setTimeout(r, ms))
}

async function cdpReachable(): Promise<boolean> {
  for (const path of ['/json/version', '/json/list']) {
    try {
      const res = await fetch(`${CDP_URL}${path}`, { signal: AbortSignal.timeout(3000) })
      if (res.ok) return true
    } catch {
      /* try next */
    }
  }
  return false
}

function devLogShowsCdp(): boolean {
  const logPath = join(OUTPUT_DIR, 'dev-stdout.log')
  if (!existsSync(logPath)) return false
  try {
    const text = readFileSync(logPath, 'utf8')
    return text.includes(`127.0.0.1:${port}`) && text.includes('DevTools listening on ws://')
  } catch {
    return false
  }
}

let devChild: ChildProcess | null = null

function startDevWithDebugPort(): void {
  const logPath = join(OUTPUT_DIR, 'dev-stdout.log')
  writeFileSync(logPath, '', 'utf8')
  const env = {
    ...process.env,
    NODE_ENV: 'development',
    [REMOTE_DEBUG_ENV]: String(port)
  }
  delete env.NODE_OPTIONS

  devChild = spawn(process.execPath, [join(ROOT, 'scripts', 'electron-vite.mjs'), 'dev'], {
    cwd: ROOT,
    env,
    stdio: ['ignore', 'pipe', 'pipe'],
    windowsHide: false
  })

  const logStream = createWriteStream(join(OUTPUT_DIR, 'dev-stdout.log'), { flags: 'a' })
  devChild.stdout?.pipe(logStream)
  devChild.stderr?.pipe(logStream)
}

async function waitForCdp(timeoutMs = 120_000): Promise<void> {
  const end = Date.now() + timeoutMs
  while (Date.now() < end) {
    if (await cdpReachable()) return
    if (devLogShowsCdp()) {
      await wait(1500)
      if (await cdpReachable()) return
    }
    await wait(500)
  }
  fail(`CDP not reachable at ${CDP_URL} within ${timeoutMs}ms`)
}

function isDevToolsTarget(url: string, title: string): boolean {
  const u = url.toLowerCase()
  const t = title.toLowerCase()
  return (
    u.startsWith('devtools://') ||
    t.includes('devtools') ||
    u.includes('chrome-devtools') ||
    t.includes('inspector')
  )
}

function isAppRendererTarget(url: string): boolean {
  const u = url.toLowerCase()
  return (
    u.includes('localhost:5173') ||
    u.includes('localhost:5174') ||
    u.includes('127.0.0.1:5173') ||
    u.includes('127.0.0.1:5174') ||
    u.includes('#/')
  )
}

const SENSITIVE_TEXT =
  /\b(hf_[a-z0-9]{20,}|api[_-]?key\s*[:=]|Bearer\s+[A-Za-z0-9._-]{20,}|sk-[A-Za-z0-9]{20,})/i

async function pageLooksSensitive(page: Page): Promise<boolean> {
  return page.evaluate(() => {
    const body = document.body?.innerText ?? ''
    const secretish =
      /\b(hf_[a-z0-9]{20,}|api[_-]?key\s*[:=]|Bearer\s+[A-Za-z0-9._-]{20,}|sk-[A-Za-z0-9]{20,})/i.test(
        body
      )
    const passwordFilled = Array.from(document.querySelectorAll('input[type="password"]')).some(
      (el) => (el as HTMLInputElement).value.trim().length > 0
    )
    return secretish || passwordFilled
  })
}

async function safeScreenshot(page: Page, filename: string): Promise<void> {
  if (await pageLooksSensitive(page)) {
    summary.screenshots.push(`${filename} (skipped — sensitive UI detected)`)
    log(`screenshot skipped (${filename}): sensitive UI detected`)
    return
  }
  const path = join(OUTPUT_DIR, filename)
  await page.screenshot({ path, fullPage: true })
  summary.screenshots.push(path)
  log(`screenshot ${path}`)
}

async function pickRendererPage(browser: Browser): Promise<Page> {
  const deadline = Date.now() + 60_000
  while (Date.now() < deadline) {
    for (const context of browser.contexts()) {
      for (const page of context.pages()) {
        const url = page.url()
        const title = await page.title().catch(() => '')
        if (isDevToolsTarget(url, title)) continue
        if (isAppRendererTarget(url)) return page
      }
    }
    await wait(400)
  }
  fail('No OllamaStudio renderer page found via CDP (non-DevTools)')
}

async function verifyPreload(page: Page): Promise<void> {
  const probe = await page.evaluate(() => {
    const w = window as Window & {
      electron?: unknown
      ollamaStudio?: { getTabbyDownloadStatus?: () => Promise<unknown> }
    }
    const hasElectron = typeof w.electron !== 'undefined'
    const hasOllamaStudio = typeof w.ollamaStudio !== 'undefined'
    const apiMethodCount =
      hasOllamaStudio && w.ollamaStudio
        ? Object.keys(w.ollamaStudio).filter(
            (k) => !/token|secret|auth|key|password/i.test(k)
          ).length
        : 0
    return { hasElectron, hasOllamaStudio, apiMethodCount }
  })

  summary.preload = {
    windowElectron: probe.hasElectron,
    windowOllamaStudio: probe.hasOllamaStudio,
    apiMethodCount: probe.apiMethodCount
  }

  if (!probe.hasOllamaStudio) {
    fail('Connected page lacks window.ollamaStudio preload bridge (likely bare Vite, not Electron)')
  }
  summary.connectedToElectronRenderer = true
}

async function readDownloadStatusViaPreload(page: Page): Promise<unknown> {
  return page.evaluate(async () => {
    const w = window as Window & {
      ollamaStudio?: { getTabbyDownloadStatus?: () => Promise<unknown> }
    }
    if (!w.ollamaStudio?.getTabbyDownloadStatus) return { error: 'missing-getTabbyDownloadStatus' }
    const snap = await w.ollamaStudio.getTabbyDownloadStatus()
    const json = JSON.stringify(snap)
    if (/\b(hf_[a-z0-9]{20,}|api[_-]?key|Bearer\s)/i.test(json)) {
      return { redacted: true, reason: 'snapshot contained secret-like substring' }
    }
    return snap
  })
}

async function collectUiDiagnostics(page: Page): Promise<unknown> {
  return page.evaluate(() => {
    const panel = document.querySelector('.download-status-panel')
    const formRepo = (document.querySelector('input[placeholder*="huggingface" i], input') as
      | HTMLInputElement
      | null)?.value
    const navLinks = Array.from(document.querySelectorAll('a.nav-link, .nav-link')).map(
      (a) => (a as HTMLAnchorElement).pathname || a.textContent?.trim() || ''
    )
    const conflictBtn = Array.from(document.querySelectorAll('button')).find((b) =>
      /smazat složku|delete folder/i.test(b.textContent ?? '')
    )
    const downloadBtn = Array.from(document.querySelectorAll('button.btn-primary')).find((b) =>
      /stáhnout|download/i.test(b.textContent ?? '')
    )
    return {
      route: location.hash,
      downloadPanel: panel
        ? {
            status: panel.getAttribute('data-status'),
            textPreview: (panel.textContent ?? '').replace(/\s+/g, ' ').trim().slice(0, 500)
          }
        : null,
      formRepoIdLength: formRepo?.length ?? 0,
      navLinks,
      conflictButtonVisible: Boolean(conflictBtn),
      conflictButtonDisabled: conflictBtn?.disabled ?? null,
      downloadButtonDisabled: downloadBtn?.disabled ?? null,
      errorHints: Array.from(document.querySelectorAll('.download-status-hint[style*="error"], .error-banner, [role="alert"]'))
        .map((el) => (el.textContent ?? '').replace(/\s+/g, ' ').trim().slice(0, 300))
        .filter(Boolean)
    }
  })
}

async function navigateHash(page: Page, hash: string, label: string): Promise<void> {
  await page.evaluate((h) => {
    location.hash = h
  }, hash)
  await page.waitForTimeout(1200)
  summary.navigation.push(`${label}:${hash}`)
}

async function runHarness(): Promise<void> {
  const downloadProbe = probeActiveDownload()
  summary.downloadProbeBeforeRestart = downloadProbe

  const alreadyUp = await cdpReachable()
  if (!alreadyUp) {
    if (downloadProbe.active) {
      fail(
        `Active download detected (${downloadProbe.reason}); refusing dev restart. ` +
          `status=${downloadProbe.status ?? '?'} folder=${downloadProbe.folderName ?? '?'}`
      )
    }
    log('CDP not up — stopping repo dev processes and restarting with debug port')
    stopRepoDevProcesses()
    startDevWithDebugPort()
    summary.devRestarted = true
    await waitForCdp()
  } else {
    log(`CDP already reachable at ${CDP_URL}`)
  }

  let browser: Browser | null = null
  const consoleLines: { type: string; text: string }[] = []

  try {
    browser = await chromium.connectOverCDP(CDP_URL)
    const page = await pickRendererPage(browser)

    page.on('console', (msg: ConsoleMessage) => {
      const text = msg.text()
      if (SENSITIVE_TEXT.test(text)) {
        consoleLines.push({ type: msg.type(), text: '[redacted console line]' })
        return
      }
      consoleLines.push({ type: msg.type(), text: text.slice(0, 500) })
    })

    await verifyPreload(page)

    await navigateHash(page, '#/models', 'models-initial')
    summary.downloadDiagnostics = await readDownloadStatusViaPreload(page)
    summary.uiDiagnostics = await collectUiDiagnostics(page)
    await safeScreenshot(page, 'models-initial.png')

    await navigateHash(page, '#/server', 'server')
    await navigateHash(page, '#/resources', 'resources')
    await navigateHash(page, '#/models', 'models-after-nav')

    const afterNavSnap = await readDownloadStatusViaPreload(page)
    summary.downloadDiagnosticsAfterNav = afterNavSnap
    summary.uiDiagnosticsAfterNav = await collectUiDiagnostics(page)

    const formPersistence = await page.evaluate(() => {
      const inputs = Array.from(document.querySelectorAll('input')).map((el) => ({
        type: (el as HTMLInputElement).type,
        len: (el as HTMLInputElement).value.length
      }))
      return { inputValueLengths: inputs }
    })
    summary.formPersistence = formPersistence

    await safeScreenshot(page, 'models-after-nav.png')

    summary.consoleSummary = consoleLines.slice(-40)
  } finally {
    if (browser) await browser.close().catch(() => {})
  }

  writeSummary()
  log(`summary written to ${join(OUTPUT_DIR, 'summary.json')}`)
}

runHarness().catch((err: unknown) => {
  summary.error = err instanceof Error ? err.message : String(err)
  writeSummary()
  console.error(err)
  process.exit(1)
})
