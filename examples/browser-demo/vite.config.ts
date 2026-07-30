import fs from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { defineConfig, loadEnv } from 'vite'

const dir = path.dirname(fileURLToPath(import.meta.url))
const certDir = path.join(dir, 'certificate')
const certFile = path.join(certDir, 'server.crt')
const keyFile = path.join(certDir, 'server.key')

export default defineConfig(({ mode }) => {
  const env = loadEnv(mode, path.join(dir, '../..'), '')
  const devHost = env.FLYTE_DEMO_HOST
  const port = Number(env.FLYTE_DEMO_PORT ?? 8080)

  if (!devHost) {
    throw new Error(
      'Set FLYTE_DEMO_HOST (e.g. localhost.my-flyte.example.com). See .env.example.',
    )
  }

  const hasMkcert = fs.existsSync(certFile) && fs.existsSync(keyFile)
  if (!hasMkcert) {
    console.warn(`[browser-demo] No mkcert certs in ${certDir}. Run: pnpm demo:ssl`)
  }

  return {
    root: dir,
    envDir: path.join(dir, '../..'),
    server: {
      host: devHost,
      port,
      strictPort: true,
      open: `https://${devHost}:${port}/`,
      https: hasMkcert
        ? {
            cert: fs.readFileSync(certFile),
            key: fs.readFileSync(keyFile),
          }
        : undefined,
    },
  }
})
