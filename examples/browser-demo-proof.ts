/**
 * Automated proof: Flyte SDK in a real browser (Playwright → Vite demo page).
 *
 *   cp .env.example .env   # fill in values
 *   pnpm demo:browser:proof
 */

import { spawn, type ChildProcess } from 'node:child_process'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

import { requireEnv } from './_env'

const dir = path.dirname(fileURLToPath(import.meta.url))
const root = path.join(dir, '..')

function sleep(ms: number) {
  return new Promise((r) => setTimeout(r, ms))
}

async function waitForHttp(url: string, timeoutMs = 30_000): Promise<void> {
  const start = Date.now()
  while (Date.now() - start < timeoutMs) {
    try {
      const res = await fetch(url, { redirect: 'follow' })
      if (res.ok || res.status === 404) return
    } catch {
      /* retry */
    }
    await sleep(300)
  }
  throw new Error(`Timed out waiting for ${url}`)
}

function start(cmd: string, args: string[], env?: NodeJS.ProcessEnv): ChildProcess {
  return spawn(cmd, args, {
    cwd: root,
    env: { ...process.env, ...env },
    stdio: ['ignore', 'pipe', 'pipe'],
    shell: true,
  })
}

async function main() {
  requireEnv('FLYTE_API_KEY')
  const devHost = requireEnv('FLYTE_DEMO_HOST')
  const devPort = process.env.FLYTE_DEMO_PORT ?? '8080'
  const demoUrl = `https://${devHost}:${devPort}/`

  let chromium: typeof import('playwright').chromium
  try {
    ;({ chromium } = await import('playwright'))
  } catch {
    console.error('Install Playwright: pnpm add -D playwright && npx playwright install chromium')
    process.exit(1)
  }

  const token = start('pnpm', ['demo:token'])
  const vite = start('pnpm', ['demo:client'])

  const cleanup = () => {
    token.kill('SIGTERM')
    vite.kill('SIGTERM')
  }
  process.on('exit', cleanup)
  process.on('SIGINT', () => {
    cleanup()
    process.exit(130)
  })

  let ready = false
  vite.stdout?.on('data', (buf: Buffer) => {
    const line = buf.toString()
    process.stdout.write(`[vite] ${line}`)
    if (/Local:\s+https:\/\//.test(line)) ready = true
  })
  vite.stderr?.on('data', (buf: Buffer) => process.stderr.write(`[vite] ${buf}`))
  token.stdout?.on('data', (buf: Buffer) => process.stdout.write(`[token] ${buf}`))
  token.stderr?.on('data', (buf: Buffer) => process.stderr.write(`[token] ${buf}`))

  console.log('Starting token sidecar + Vite…')
  await waitForHttp('http://127.0.0.1:8787/token')
  const viteDeadline = Date.now() + 30_000
  while (!ready && Date.now() < viteDeadline) await sleep(300)

  console.log(`Opening ${demoUrl}`)

  const browser = await chromium.launch({ headless: true })
  const context = await browser.newContext({ ignoreHTTPSErrors: true })
  const page = await context.newPage()
  try {
    await page.goto(demoUrl, { timeout: 15_000 })
    await page.locator('input[value="bearer"]').check()
    await page.getByRole('button', { name: 'Run task' }).click()
    await page.waitForFunction(
      () => {
        const t = document.getElementById('log')?.textContent || ''
        return t.includes('SUCCEEDED') || (t.includes('✗') && !t.includes('fetching bearer'))
      },
      { timeout: 120_000 },
    )
    const log = (await page.locator('#log').textContent()) ?? ''
    console.log('\n--- browser log ---')
    console.log(log)
    console.log('--- end ---\n')

    if (!log.includes('SUCCEEDED')) {
      console.error('✗ Browser demo did not reach SUCCEEDED')
      process.exit(1)
    }
    console.log('✓ Browser client proof passed (Flyte.init + run.wait in Chrome)')
  } finally {
    await context.close()
    await browser.close()
    cleanup()
  }
}

main().catch((e) => {
  console.error(e)
  process.exit(1)
})
