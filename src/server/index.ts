// ── Monopoly Party server ──
// Serves the TV app at / and the phone app at /join, and speaks Socket.IO.
// Binds 0.0.0.0 so phones on the same Wi-Fi can connect; deploy-ready behind
// any reverse proxy. The join URL is never baked in at build time: set
// PUBLIC_URL (e.g. https://monopoly.example.com) behind a tunnel/proxy, or
// the host screen advertises the machine's LAN address. For a short-lived
// public instance, PARTY_KEY gates every page and socket (see README).

import express, { type ErrorRequestHandler } from 'express'
import { timingSafeEqual } from 'node:crypto'
import { createServer, type IncomingHttpHeaders } from 'node:http'
import { readFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import { networkInterfaces } from 'node:os'
import path from 'node:path'
import { Server } from 'socket.io'
import { attach, flushSnapshots } from './rooms.js'

const PORT = Number(process.env.PORT ?? 3000)

// Public origin for links the host screen hands out to phones. Behind a tunnel
// or reverse proxy the machine's LAN address is unreachable from the table, so
// the deployer sets this instead. Accepts a bare host and assumes https.
const PUBLIC_URL = (() => {
  const raw = process.env.PUBLIC_URL?.trim()
  if (!raw) return ''
  const withScheme = /^https?:\/\//i.test(raw) ? raw : `https://${raw}`
  return withScheme.replace(/\/+$/, '')
})()

// Shared-secret gate for short-lived public instances. Unset (local play),
// every request passes as before. When set, `?key=<PARTY_KEY>` mints a
// session cookie so it is typed once per device, and the QR/join links
// embed the key so phones that scan them never type anything.
const PARTY_KEY = process.env.PARTY_KEY?.trim() ?? ''
const KEY_COOKIE = 'mp_party_key'

function keyMatches(candidate: unknown): boolean {
  if (!PARTY_KEY || typeof candidate !== 'string' || !candidate) return false
  const a = Buffer.from(candidate)
  const b = Buffer.from(PARTY_KEY)
  return a.length === b.length && timingSafeEqual(a, b)
}

function parseCookies(header: string | undefined): Record<string, string> {
  const out: Record<string, string> = {}
  for (const part of header?.split(';') ?? []) {
    const i = part.indexOf('=')
    if (i > 0) {
      const k = part.slice(0, i).trim()
      const raw = part.slice(i + 1).trim()
      // A foreign app's malformed cookie value (bad %-escape) must never be
      // able to crash the process — keep the raw string if it won't decode.
      try {
        out[k] = decodeURIComponent(raw)
      } catch {
        out[k] = raw
      }
    }
  }
  return out
}

// Basic auth accepts any username with the party key as the password (kept as
// the desktop/curl fallback); `Authorization: Bearer <key>` also works.
function headerCredential(header: string | undefined): string | null {
  if (!header) return null
  if (header.startsWith('Bearer ')) return header.slice(7)
  if (!header.startsWith('Basic ')) return null
  const decoded = Buffer.from(header.slice(6), 'base64').toString('utf8')
  const i = decoded.indexOf(':')
  return i < 0 ? null : decoded.slice(i + 1)
}

// Behind a proxy the socket address is the proxy itself; trust the edge
// headers (CF-Connecting-IP is authoritative; last XFF entry is the hop
// closest to us) so AUTHFAIL lines carry the real client for fail2ban.
function clientIp(headers: IncomingHttpHeaders, remote: string | undefined): string {
  const cf = headers['cf-connecting-ip']
  if (typeof cf === 'string' && cf.trim()) return cf.trim()
  const xff = headers['x-forwarded-for']
  if (typeof xff === 'string') {
    const parts = xff.split(',').map((s) => s.trim()).filter(Boolean)
    if (parts.length > 0) return parts[parts.length - 1]
  }
  return remote ?? '?'
}

const app = express()

// HTTP gate: pages and bundles. Engine.io handshakes never pass through
// express, so the socket side is guarded separately below (io.use).
if (PARTY_KEY) {
  app.use((req, res, next) => {
    try {
      if (keyMatches(req.query.key)) {
        const secure = req.secure || req.headers['x-forwarded-proto'] === 'https'
        res.append(
          'Set-Cookie',
          `${KEY_COOKIE}=${encodeURIComponent(PARTY_KEY)}; Path=/; HttpOnly; SameSite=Lax${secure ? '; Secure' : ''}`,
        )
        return next()
      }
      if (keyMatches(parseCookies(req.headers.cookie)[KEY_COOKIE])) return next()
      if (keyMatches(headerCredential(req.headers.authorization))) return next()
      console.log(`AUTHFAIL ip=${clientIp(req.headers, req.socket.remoteAddress)} path=${req.url}`)
      res.set('WWW-Authenticate', 'Basic realm="Monopoly Party", charset="UTF-8"')
      res.status(401).send(
        'Private party server. Open the share link that includes ?key=…, ' +
          'or sign in with any username and the party key as the password.',
      )
    } catch (e) {
      // Fail closed, and never leak a stack trace to the client.
      console.error('[gate] express auth check threw:', e)
      res.status(500).send('Server error')
    }
  })
}
const pub = path.resolve('public')
// Bundles must never be served stale: idle phone tabs can hold old code
// for days, which causes missing-button bugs after a deploy.
app.get(['/host.js', '/controller.js', '/sim.js'], (_q, res, next) => {
  res.set('Cache-Control', 'no-store')
  next()
})
// Build id, minted at build time (scripts/build-clients.mjs writes both the
// esbuild define into the client bundles and this file). Read per request —
// a few tiny FS reads a minute are free, and a files-swapped-without-restart
// deploy still flips instantly. Gated like every other route; clients
// compare their baked id against this and prompt to refresh on inequality.
const BUILD_ID_FILE = fileURLToPath(new URL('../../dist/build-id.json', import.meta.url))
function currentBuildId(): string {
  try {
    const raw = JSON.parse(readFileSync(BUILD_ID_FILE, 'utf8')) as { id?: unknown }
    return typeof raw.id === 'string' ? raw.id : ''
  } catch {
    return ''
  }
}
app.get('/version', (_q, res) => {
  res.set('Cache-Control', 'no-store')
  res.json({ id: currentBuildId() })
})
app.use(express.static(pub))
app.get('/', (_q, res) => res.sendFile(path.join(pub, 'host.html')))
app.get('/join', (_q, res) => res.sendFile(path.join(pub, 'controller.html')))
app.get('/simulate', (_q, res) => res.sendFile(path.join(pub, 'sim.html')))

// Last-resort error handler: log the details server-side, show the client a
// plain message — express's default page leaks stack traces.
app.use(((err, _req, res, next) => {
  console.error('[http] request failed:', err)
  if (res.headersSent) return next(err)
  res.status(500).send('Server error')
}) as ErrorRequestHandler)

const http = createServer(app)
const io = new Server(http)

// Socket gate: browsers carry the cookie minted by the page load on the
// handshake; raw clients may use auth.key, ?key=, or a bearer/basic header.
// The gate itself must never throw — a malformed cookie from any other app
// on the domain used to kill the process here.
io.use((socket, next) => {
  try {
    if (!PARTY_KEY) return next()
    const h = socket.handshake
    const q = h.query as Record<string, unknown>
    if (
      keyMatches(q?.key) ||
      keyMatches(h.auth?.key) ||
      keyMatches(parseCookies(h.headers.cookie)[KEY_COOKIE]) ||
      keyMatches(headerCredential(h.headers.authorization))
    ) {
      return next()
    }
    console.log(`AUTHFAIL ip=${clientIp(h.headers, h.address)} path=socket.io`)
    next(new Error('unauthorized'))
  } catch (e) {
    console.error('[gate] socket auth check threw:', e)
    next(new Error('unauthorized'))
  }
})

function joinUrls(): string[] {
  // Advertised links carry the key: the QR code on the TV becomes a one-tap
  // sign-in for phones. The key is on the big screen anyway — it gates the
  // internet, not the room (room codes still do that).
  const key = PARTY_KEY ? `?key=${encodeURIComponent(PARTY_KEY)}` : ''
  if (PUBLIC_URL) return [`${PUBLIC_URL}/join${key}`]
  const urls: string[] = []
  for (const list of Object.values(networkInterfaces())) {
    for (const ni of list ?? []) {
      if (ni.family === 'IPv4' && !ni.internal) urls.push(`http://${ni.address}:${PORT}/join${key}`)
    }
  }
  return urls
}

attach(io, () => joinUrls(), path.resolve(process.env.SNAP_DIR ?? 'snapshots'))

// A restart must not lose acknowledged moves: snapshot writes are batched
// over ~250ms, so flush whatever is pending before the process goes down.
for (const sig of ['SIGTERM', 'SIGINT'] as const) {
  process.on(sig, () => {
    void flushSnapshots().finally(() => process.exit(0))
  })
}

http.listen(PORT, '0.0.0.0', () => {
  console.log('')
  console.log('  🎲 Monopoly Party')
  console.log(`  📺 TV / host:      ${PUBLIC_URL || `http://localhost:${PORT}`}`)
  const urls = joinUrls()
  if (urls.length > 0) {
    for (const u of urls) console.log(`  📱 Phones join at:  ${u}`)
  } else {
    console.log(`  📱 Phones join at:  http://<this machine's IP>:${PORT}/join`)
  }
  if (PUBLIC_URL) console.log(`  🖥  Local:          http://localhost:${PORT}`)
  if (PARTY_KEY) {
    console.log(`  🔑 Party gate ON — open:  ${PUBLIC_URL || `http://localhost:${PORT}`}/?key=<your PARTY_KEY>`)
  }
  console.log('')
})
