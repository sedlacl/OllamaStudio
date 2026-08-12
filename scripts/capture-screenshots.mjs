/**
 * Spustí out/main v maximalizovaném okně, rozjede na pozadí chat požadavek proti
 * ollama serve (aby Přehled i GPU stránka ukazovaly reálná data) a přes CDP
 * pořídí docs/screenshots/{dashboard,gpu}.png
 */
import { execFileSync, spawn } from 'child_process'
import { createRequire } from 'module'
import { mkdirSync, writeFileSync, existsSync } from 'fs'
import { dirname, join } from 'path'
import { fileURLToPath } from 'url'

const __dirname = dirname(fileURLToPath(import.meta.url))
const root = join(__dirname, '..')
const require = createRequire(import.meta.url)
const electronPath = require('electron')
const outDir = join(root, 'docs', 'screenshots')
mkdirSync(outDir, { recursive: true })

const PORT = 9333
const OLLAMA = process.env.OLLAMA_HOST_URL ?? 'http://127.0.0.1:11434'
const PROMPT =
  'Vysvětli podrobně a v češtině, jak probíhá inference velkého jazykového modelu ' +
  'na lokální GPU — od načtení vrstev do VRAM až po generování tokenů. ' +
  'Piš nejméně deset odstavců.'

const env = { ...process.env, OLLAMASTUDIO_START_MAXIMIZED: '1' }
delete env.NODE_OPTIONS

function powershell(script) {
  return execFileSync(
    'powershell',
    ['-NoProfile', '-EncodedCommand', Buffer.from(script, 'utf16le').toString('base64')],
    { windowsHide: true, encoding: 'utf-8' }
  )
}

/**
 * Zbytky z předchozích běhů drží single-instance lock (nová instance se hned ukončí)
 * a obsazený port 11434. Cílíme jen na *náš* electron a na osiřelé ollama procesy.
 */
function cleanupStale() {
  if (process.platform !== 'win32') return
  try {
    powershell(
      [
        "$ErrorActionPreference = 'SilentlyContinue'",
        `$appPath = ${JSON.stringify(electronPath)}`,
        "Get-CimInstance Win32_Process -Filter \"Name='electron.exe'\" |",
        '  Where-Object { $_.ExecutablePath -eq $appPath } |',
        '  ForEach-Object { taskkill /PID $_.ProcessId /T /F | Out-Null }',
        "foreach ($n in @('ollama.exe', 'llama-server.exe')) {",
        '  Get-CimInstance Win32_Process -Filter "Name=\'$n\'" | ForEach-Object {',
        '    $parent = Get-Process -Id $_.ParentProcessId -ErrorAction SilentlyContinue',
        '    if (-not $parent) { taskkill /PID $_.ProcessId /T /F | Out-Null }',
        '  }',
        '}'
      ].join('\n')
    )
  } catch {
    /* nejde-li uklidit, zkusíme spustit i tak */
  }
}

cleanupStale()

const child = spawn(electronPath, ['.', `--remote-debugging-port=${PORT}`], {
  cwd: root,
  env,
  stdio: 'ignore',
  windowsHide: false
})

const wait = (ms) => new Promise((r) => setTimeout(r, ms))

async function waitForPage() {
  for (let i = 0; i < 60; i++) {
    try {
      const res = await fetch(`http://127.0.0.1:${PORT}/json/list`)
      const list = await res.json()
      const page = list.find((t) => t.type === 'page' && t.webSocketDebuggerUrl)
      if (page) return page
    } catch {
      /* retry */
    }
    await wait(400)
  }
  throw new Error('CDP page not found')
}

class Cdp {
  constructor(url) {
    this.url = url
    this.nextId = 1
    this.pending = new Map()
  }

  async connect() {
    this.ws = new WebSocket(this.url)
    await new Promise((resolve, reject) => {
      const t = setTimeout(() => reject(new Error('WS timeout')), 10000)
      this.ws.onopen = () => {
        clearTimeout(t)
        resolve()
      }
      this.ws.onerror = (e) => {
        clearTimeout(t)
        reject(e)
      }
    })
    this.ws.onmessage = (ev) => {
      const msg = JSON.parse(String(ev.data))
      if (msg.id != null && this.pending.has(msg.id)) {
        const { resolve, reject } = this.pending.get(msg.id)
        this.pending.delete(msg.id)
        if (msg.error) reject(new Error(JSON.stringify(msg.error)))
        else resolve(msg.result)
      }
    }
  }

  send(method, params = {}) {
    const id = this.nextId++
    return new Promise((resolve, reject) => {
      const t = setTimeout(() => {
        this.pending.delete(id)
        reject(new Error(`timeout ${method}`))
      }, 20000)
      this.pending.set(id, {
        resolve: (v) => {
          clearTimeout(t)
          resolve(v)
        },
        reject: (e) => {
          clearTimeout(t)
          reject(e)
        }
      })
      this.ws.send(JSON.stringify({ id, method, params }))
    })
  }

  async eval(expression) {
    const result = await this.send('Runtime.evaluate', {
      expression,
      returnByValue: true,
      awaitPromise: true
    })
    return result?.result?.value
  }

  close() {
    try {
      this.ws.close()
    } catch {
      /* ignore */
    }
  }
}

async function waitText(cdp, needles, ms) {
  const end = Date.now() + ms
  while (Date.now() < end) {
    const ok = await cdp.eval(
      `(${JSON.stringify(needles)}).some((n) => (document.body && document.body.innerText || '').includes(n))`
    )
    if (ok) return true
    await wait(500)
  }
  return false
}

async function waitGone(cdp, needle, ms) {
  const end = Date.now() + ms
  while (Date.now() < end) {
    const present = await cdp.eval(
      `((document.body && document.body.innerText) || '').includes(${JSON.stringify(needle)})`
    )
    if (!present) return true
    await wait(500)
  }
  return false
}

/** Nejmenší nainstalovaný model — nabíhá nejrychleji. */
async function pickModel() {
  const res = await fetch(`${OLLAMA}/api/tags`)
  const { models } = await res.json()
  if (!models?.length) return null
  return [...models].sort((a, b) => (a.size ?? 0) - (b.size ?? 0))[0].name
}

async function chat(model, numPredict, signal, onChunk) {
  const res = await fetch(`${OLLAMA}/api/chat`, {
    method: 'POST',
    signal,
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({
      model,
      stream: true,
      messages: [{ role: 'user', content: PROMPT }],
      options: { num_predict: numPredict }
    })
  })
  if (!res.ok) throw new Error(`/api/chat ${res.status}`)
  const decoder = new TextDecoder()
  for await (const chunk of res.body) {
    const lines = decoder.decode(chunk, { stream: true }).split('\n').filter(Boolean)
    onChunk?.(lines.length)
  }
}

/**
 * Drží serve vytížený, dokud nezavoláme stop() — jeden request by mohl skončit
 * dřív, než pořídíme oba screenshoty.
 */
function startChatLoad(model) {
  const ctrl = new AbortController()
  const state = { chunks: 0, error: null }

  const run = async () => {
    while (!ctrl.signal.aborted) {
      await chat(model, 600, ctrl.signal, (n) => {
        state.chunks += n
      })
    }
  }

  run().catch((e) => {
    if (!ctrl.signal.aborted) state.error = e
  })

  return { stop: () => ctrl.abort(), state }
}

async function shot(cdp, file) {
  const { data } = await cdp.send('Page.captureScreenshot', {
    format: 'png',
    fromSurface: true,
    captureBeyondViewport: false
  })
  writeFileSync(join(outDir, file), Buffer.from(data, 'base64'))
  console.log('wrote', file)
}

/** Bez /T zůstane běžet ollama serve spuštěný aplikací a blokne další běh. */
function killChild() {
  if (!child.pid) return
  try {
    if (process.platform === 'win32') {
      execFileSync('taskkill', ['/PID', String(child.pid), '/T', '/F'], {
        windowsHide: true,
        stdio: 'ignore'
      })
    } else {
      process.kill(child.pid)
    }
  } catch {
    /* ignore */
  }
}

let load = null

try {
  if (!existsSync(join(root, 'out', 'main', 'index.js'))) {
    throw new Error('run npm run build first')
  }

  await wait(2500)
  const page = await waitForPage()
  const cdp = new Cdp(page.webSocketDebuggerUrl)
  await cdp.connect()
  await cdp.send('Page.enable')
  await cdp.send('Runtime.enable')

  // Počkej na běh serve, ať Přehled není „Spouští se / Odpojeno“
  const running = await waitText(cdp, ['Běží'], 35000)
  if (!running) console.warn('Serve not fully running yet')
  await wait(2000)

  const model = await pickModel()
  if (!model) throw new Error('žádný nainstalovaný model — nelze vygenerovat aktivitu')
  console.log('model:', model)

  await cdp.eval(`location.hash = '#/'`)
  await waitText(cdp, ['Aktivita', 'Přehled'], 10000)

  // Krátký request doběhne → v Aktivitě je vidět historie a model už je ve VRAM.
  console.log('warm-up request…')
  await chat(model, 24)
  const hasHistory = await waitGone(cdp, 'Zatím žádná historie požadavků', 20000)
  if (!hasHistory) console.warn('historie požadavků zůstala prázdná')

  // Druhý request běží při capture, ať Přehled ukazuje živý progress a tokeny/s.
  load = startChatLoad(model)
  const generating = await waitText(cdp, ['Generování'], 60000)
  if (!generating) console.warn('UI se nedostalo do fáze generování')
  if (load.state.error) console.warn('chat load error:', load.state.error.message)
  await wait(2500)
  await shot(cdp, 'dashboard.png')

  await cdp.eval(`location.hash = '#/resources'`)
  const ready = await waitText(
    cdp,
    ['Procesy Ollama', 'CPU zátěž', 'Systémová RAM', 'Součet VRAM'],
    20000
  )
  if (!ready) console.warn('GPU page may still be loading')
  await wait(4000)
  await shot(cdp, 'gpu.png')

  cdp.close()
  console.log(`ok (model ${model}, ${load.state.chunks} chunků)`)
} catch (e) {
  console.error(e)
  process.exitCode = 1
} finally {
  load?.stop()
  killChild()
  await wait(400)
  process.exit(process.exitCode ?? 0)
}
