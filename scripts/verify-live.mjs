// throwaway: confirm the user's live game (room WMKG) survived the restart
import { readFileSync } from 'node:fs'
import { io } from 'socket.io-client'

const snap = JSON.parse(readFileSync('snapshots/WMKG.json', 'utf8'))
const token = snap.players[0].token
const socket = io('http://localhost:3000', { reconnection: false })

socket.on('view', (v) => {
  const me = v.players.find((p) => p.id === v.you)
  console.log(`rejoined: ${me.name} — room ${v.code}, turn ${v.turn}, phase ${v.phase}, my cash $${me.cash}, my pos ${me.pos}`)
  console.log(v.turn === 3 ? 'GAME SURVIVED: resumed at the exact turn' : `NOTE: turn is ${v.turn}, snapshot said 3`)
  process.exit(0)
})

socket.on('connect', () => {
  socket.emit('room:rejoin', { token }, (res) => {
    if (!res.ok) {
      console.log('REJOIN FAILED:', res.error)
      process.exit(1)
    }
  })
})

setTimeout(() => {
  console.log('timeout: no view arrived')
  process.exit(1)
}, 8000)
