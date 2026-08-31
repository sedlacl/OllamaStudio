/**
 * Dev-only CDP check: Tabby model table sizes/status + navigation persistence.
 * Usage: OLLAMA_STUDIO_REMOTE_DEBUG_PORT=9344 npx tsx scripts/e2e-tabby-model-sizes.mts
 */
import { mkdirSync, writeFileSync } from 'fs'
import { dirname, join } from 'path'
import { fileURLToPath } from 'url'
import { chromium, type Browser, type Page } from 'playwright'

const __dirname = dirname(fileURLToPath(import.meta.url))
const ROOT = join(__dirname, '..')
const OUTPUT_DIR = join(ROOT, '.tmp', 'e2e-output')
mkdirSync(OUTPUT_DIR, { recursive: true })

const port = Number.parseInt(process.env.OLLAMA_STUDIO_REMOTE_DEBUG_PORT ?? '9344', 10)
const CDP_URL = `http://127.0.0.1:${port}`

const COMPLETE = 'Qwen3.8-27B-exl3-SC_3.00bpw_H4-2-2'
const PARTIAL = 'Qwen3.8-27B-exl3-SC_3.00bpw_H4'

interface RowProbe {
  name: string
  sizeText: string
  statusText: string
  loadDisabled: boolean
}

async function wait(ms: number): Promise<void> {
  await new Promise((r) => setTimeout(r, ms))
}

async function pickRendererPage(browser: Browser): Promise<Page> {
  for (let i = 0; i < 120; i++) {
    for (const context of browser.contexts()) {
      for (const page of context.pages()) {
        const url = page.url().toLowerCase()
        if (url.includes('devtools://')) continue
        if (url.includes('localhost:5173') || url.includes('#/')) return page
      }
    }
    await wait(500)
  }
  throw new Error('renderer page not found')
}

async function readModelRows(page: Page): Promise<RowProbe[]> {
  return page.evaluate(() => {
    const rows = Array.from(document.querySelectorAll('table.table tbody tr'))
    return rows.map((row) => {
      const cells = row.querySelectorAll('td')
      const loadBtn = row.querySelector('button.btn-primary') as HTMLButtonElement | null
      return {
        name: (cells[0]?.textContent ?? '').trim(),
        sizeText: (cells[1]?.textContent ?? '').trim(),
        statusText: (cells[2]?.textContent ?? '').trim(),
        loadDisabled: loadBtn?.disabled ?? true
      }
    })
  })
}

async function ensureTabbyBackend(page: Page): Promise<void> {
  await page.evaluate(async () => {
    const w = window as Window & {
      ollamaStudio?: {
        getServeStatus?: () => Promise<{ backend?: string; status?: string }>
        switchBackend?: (b: 'tabby' | 'ollama') => Promise<unknown>
        startServer?: () => Promise<unknown>
      }
    }
    const status = await w.ollamaStudio?.getServeStatus?.()
    if (status?.backend !== 'tabby') {
      await w.ollamaStudio?.switchBackend?.('tabby')
    }
    const afterSwitch = await w.ollamaStudio?.getServeStatus?.()
    if (afterSwitch?.status !== 'running') {
      await w.ollamaStudio?.startServer?.()
    }
  })
  await wait(8000)
}

async function waitForModelRows(page: Page, timeoutMs = 60_000): Promise<RowProbe[]> {
  const end = Date.now() + timeoutMs
  while (Date.now() < end) {
    const rows = await readModelRows(page)
    if (rows.length > 0) return rows
    await wait(1000)
  }
  return readModelRows(page)
}

async function navigateHash(page: Page, hash: string): Promise<void> {
  await page.evaluate((h) => {
    location.hash = h
  }, hash)
  await wait(1500)
}

async function main(): Promise<void> {
  const summary: Record<string, unknown> = { cdpUrl: CDP_URL, startedAt: new Date().toISOString() }

  let browser: Browser | null = null
  try {
    browser = await chromium.connectOverCDP(CDP_URL)
    const page = await pickRendererPage(browser)

    await navigateHash(page, '#/models')
    await ensureTabbyBackend(page)
    await navigateHash(page, '#/models')
    const initial = await waitForModelRows(page)
    summary.initialRows = initial
    await page.screenshot({ path: join(OUTPUT_DIR, 'tabby-model-sizes.png'), fullPage: true })

    await navigateHash(page, '#/server')
    await navigateHash(page, '#/resources')
    await navigateHash(page, '#/models')
    const afterNav = await waitForModelRows(page)
    summary.afterNavRows = afterNav

    const complete = afterNav.find((r) => r.name === COMPLETE)
    const partial = afterNav.find((r) => r.name === PARTIAL)

    const checks = {
      completeFound: Boolean(complete),
      partialFound: Boolean(partial),
      completeSizeNotZeroB: complete ? !/^0\s*B$/i.test(complete.sizeText) : false,
      partialSizeNotZeroB: partial ? !/^0\s*B$/i.test(partial.sizeText) : false,
      completeLoadEnabled: complete ? !complete.loadDisabled : false,
      partialLoadDisabled: partial ? partial.loadDisabled : false,
      partialIncompleteStatus: partial
        ? /incomplete|nekompletn/i.test(partial.statusText)
        : false,
      sizesPersistAfterNav:
        complete && afterNav.find((r) => r.name === COMPLETE)?.sizeText === complete.sizeText
    }
    summary.checks = checks

    writeFileSync(join(OUTPUT_DIR, 'tabby-model-sizes-summary.json'), JSON.stringify(summary, null, 2))
    const failed = Object.entries(checks).filter(([, ok]) => !ok)
    if (failed.length) {
      console.error('FAILED checks:', failed)
      process.exit(1)
    }
    console.log('OK', JSON.stringify(checks, null, 2))
  } catch (err) {
    summary.error = err instanceof Error ? err.message : String(err)
    writeFileSync(join(OUTPUT_DIR, 'tabby-model-sizes-summary.json'), JSON.stringify(summary, null, 2))
    console.error(err)
    process.exit(1)
  } finally {
    await browser?.close().catch(() => {})
  }
}

void main()
