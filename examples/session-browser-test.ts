/**
 * Session auth in a real browser (Playwright). Log in once, then SDK runs list + run.
 * See examples/README.md · Run: pnpm example:session
 */

import { createServer } from 'node:http'
import fs from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { spawn } from 'node:child_process'

import { exampleScope } from './_env'

const BUNDLE_PORT = 8765
const dir = path.dirname(fileURLToPath(import.meta.url))
const BUNDLE_PATH = path.join(dir, '.session-bundle.js')

function waitForEnter(prompt: string): Promise<void> {
  return new Promise((resolve) => {
    process.stdout.write(prompt)
    process.stdin.resume()
    process.stdin.once('data', () => {
      process.stdin.pause()
      resolve()
    })
  })
}

async function buildBrowserBundle(): Promise<void> {
  console.log('Bundling SDK session test for browser…')
  await new Promise<void>((resolve, reject) => {
    const proc = spawn(
      'npx',
      [
        'esbuild',
        path.join(dir, 'session-browser-runner.ts'),
        '--bundle',
        '--format=iife',
        '--platform=browser',
        `--outfile=${BUNDLE_PATH}`,
        '--log-level=warning',
      ],
      { stdio: 'inherit', shell: true },
    )
    proc.on('exit', (code) => (code === 0 ? resolve() : reject(new Error('esbuild failed'))))
  })
}

function startBundleServer(): Promise<{ close: () => void }> {
  return new Promise((resolve) => {
    const server = createServer((req, res) => {
      if (req.url === '/session-bundle.js') {
        res.writeHead(200, { 'content-type': 'application/javascript' })
        res.end(fs.readFileSync(BUNDLE_PATH))
        return
      }
      res.writeHead(404)
      res.end()
    })
    server.listen(BUNDLE_PORT, () => {
      resolve({ close: () => server.close() })
    })
  })
}

async function main() {
  const scope = exampleScope()
  const consoleUrl = `${scope.endpoint}/v2/projects`

  console.log('=== Session auth test — Flyte SDK ===\n')

  let chromium: typeof import('playwright').chromium
  try {
    ;({ chromium } = await import('playwright'))
  } catch {
    console.error('Install Playwright: pnpm add -D playwright && npx playwright install chromium')
    process.exit(1)
  }

  await buildBrowserBundle()
  const bundleServer = await startBundleServer()

  const userDataDir = path.join(dir, '.session-profile')
  const context = await chromium.launchPersistentContext(userDataDir, { headless: false })
  const page = await context.newPage()

  try {
    console.log('Opening', consoleUrl)
    await page.goto(consoleUrl, { waitUntil: 'domcontentloaded', timeout: 120_000 })

    if (page.url().includes('signin') || page.url().includes('/login')) {
      console.log('Sign in in the browser, then press Enter.')
      await waitForEnter('Press Enter after login… ')
      await page.goto(consoleUrl, { waitUntil: 'domcontentloaded', timeout: 120_000 })
    }

    console.log('Injecting SDK bundle and running listTasks + run()…\n')
    await page.addScriptTag({
      url: `http://127.0.0.1:${BUNDLE_PORT}/session-bundle.js`,
    })

    const result = await page.evaluate(
      async (cfg) => {
        const run = window.__flyteSessionTest
        if (!run) throw new Error('SDK bundle did not load')
        return run(cfg)
      },
      {
        endpoint: scope.endpoint,
        org: scope.org,
        project: scope.project,
        domain: scope.domain,
      },
    )

    console.log('✓ Session auth via Flyte SDK')
    console.log('  tasks:', result.tasks.join(', ') || '(none)')
    console.log('  run:  ', result.runName)
    console.log('  url:  ', result.runUrl)
    console.log('  phase:', result.finalPhase)
  } finally {
    await context.close()
    bundleServer.close()
  }
}

main().catch((e) => {
  console.error(e)
  process.exit(1)
})
