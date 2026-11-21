// ── Monopoly Party server ──
// Serves the TV app at / and the phone app at /join, and speaks Socket.IO.
// Binds 0.0.0.0 so phones on the same Wi-Fi can connect; deploy-ready behind
// any reverse proxy (the join URL is never baked in — the host screen shows
// whatever LAN address or public URL the server detects).

import express from 'express'
import { createServer } from 'node:http'
import { networkInterfaces } from 'node:os'
import path from 'node:path'
import { Server } from 'socket.io'
import { attach } from './rooms.js'

const PORT = Number(process.env.PORT ?? 3000)

const app = express()
const pub = path.resolve('public')
app.use(express.static(pub))
app.get('/', (_q, res) => res.sendFile(path.join(pub, 'host.html')))
app.get('/join', (_q, res) => res.sendFile(path.join(pub, 'controller.html')))
app.get('/simulate', (_q, res) => res.sendFile(path.join(pub, 'sim.html')))

const http = createServer(app)
const io = new Server(http)

function lanJoinUrls(): string[] {
  const urls: string[] = []
  for (const list of Object.values(networkInterfaces())) {
    for (const ni of list ?? []) {
      if (ni.family === 'IPv4' && !ni.internal) urls.push(`http://${ni.address}:${PORT}/join`)
    }
  }
  return urls
}

attach(io, () => lanJoinUrls(), path.resolve(process.env.SNAP_DIR ?? 'snapshots'))

http.listen(PORT, '0.0.0.0', () => {
  console.log('')
  console.log('  🎲 Monopoly Party')
  console.log(`  📺 TV / host:      http://localhost:${PORT}`)
  const urls = lanJoinUrls()
  if (urls.length > 0) {
    for (const u of urls) console.log(`  📱 Phones join at:  ${u}`)
  } else {
    console.log(`  📱 Phones join at:  http://<this machine's IP>:${PORT}/join`)
  }
  console.log('')
})
