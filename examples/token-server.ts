import http from 'node:http'

import './_env.js'
import { discoverOAuth2Metadata, resolveConfig } from '../src'

const PORT = 8787

/**
 * Tiny local token sidecar for the browser demo.
 * The browser never sees the API key — it only gets a short-lived bearer token.
 * (Same pattern as a Next.js /api/flyte/token Route Handler.)
 */
async function exchangeToken(): Promise<string> {
  const config = resolveConfig({ auth: { apiKey: process.env.FLYTE_API_KEY } })
  if (config.auth.mode !== 'client_credentials') {
    throw new Error('Set FLYTE_API_KEY')
  }
  const { clientId, clientSecret } = config.auth
  if (!clientSecret) {
    throw new Error('Set FLYTE_API_KEY (or an inline client secret)')
  }
  const oauth = await discoverOAuth2Metadata(config.endpoint)
  const basic = Buffer.from(
    `${encodeURIComponent(clientId)}:${encodeURIComponent(clientSecret)}`,
  ).toString('base64')
  const res = await fetch(oauth.tokenEndpoint!, {
    method: 'POST',
    headers: {
      'content-type': 'application/x-www-form-urlencoded',
      authorization: `Basic ${basic}`,
      accept: 'application/json',
    },
    body: new URLSearchParams({ grant_type: 'client_credentials', scope: 'all' }),
  })
  if (!res.ok) throw new Error(await res.text())
  const json = (await res.json()) as { access_token: string }
  return json.access_token
}

const server = http.createServer(async (req, res) => {
  res.setHeader('access-control-allow-origin', '*')
  res.setHeader('access-control-allow-methods', 'GET, OPTIONS')
  if (req.method === 'OPTIONS') {
    res.writeHead(204)
    res.end()
    return
  }
  if (req.url === '/token') {
    try {
      const accessToken = await exchangeToken()
      res.writeHead(200, { 'content-type': 'application/json' })
      res.end(JSON.stringify({ accessToken }))
    } catch (e) {
      res.writeHead(500, { 'content-type': 'application/json' })
      res.end(JSON.stringify({ error: e instanceof Error ? e.message : String(e) }))
    }
    return
  }
  res.writeHead(404)
  res.end()
})

server.listen(PORT, () => {
  console.log(`Token sidecar http://127.0.0.1:${PORT}/token`)
  console.log('(Uses FLYTE_API_KEY — browser demo fetches bearer token from here)')
})
