// ── 3D board renderer (Three.js) ──
// The whole board lives in a WebGL scene: 40 textured tiles in a ring, color
// bands, houses/hotels, 3D player tokens that hop tile-by-tile when they move.
// The camera is a rig that stays zoomed onto the ACTIVE piece and tracks it
// smoothly — from the moment the turn changes, through every hop of the move.
// In the lobby it falls back to a slow cinematic orbit.

import * as THREE from 'three'
import { BOARD, GROUP_COLORS, isStreet } from '../../shared/board.js'
import { createAvatar } from '../tokens3d.js'
import type { HostView } from '../../shared/types.js'

const TILE = 2
const TILE_W = 1.84
const RING_R = 11 / 2 // tiles from center

// grid position (1..11) → world position on the XZ plane
function gridRC(i: number): { r: number; c: number } {
  if (i === 0) return { r: 11, c: 11 }
  if (i < 10) return { r: 11, c: 11 - i }
  if (i === 10) return { r: 11, c: 1 }
  if (i < 20) return { r: 11 - (i - 10), c: 1 }
  if (i === 20) return { r: 1, c: 1 }
  if (i < 30) return { r: 1, c: 1 + (i - 20) }
  if (i === 30) return { r: 1, c: 11 }
  return { r: 1 + (i - 30), c: 11 }
}

function tileCenter(i: number): { x: number; z: number; r: number; c: number; region: string } {
  const { r, c } = gridRC(i)
  return { x: (c - 6) * TILE, z: (r - 6) * TILE, r, c, region: r === 11 ? 'bottom' : c === 1 ? 'left' : r === 1 ? 'top' : 'right' }
}

// shortest-path angular interpolation (unused for labels now that text is
// static, kept for future camera work) — removed to keep things honest.

// The camera sits OUTSIDE whichever side of the board the active piece is
// on, so that whole edge's static labels read upright on the TV:
// bottom row → viewed from the south, left column → from the west, etc.
function cameraOffset(i: number): THREE.Vector3 {
  const region = tileCenter(i).region
  if (region === 'bottom') return new THREE.Vector3(0, 11.5, 8.5)
  if (region === 'top') return new THREE.Vector3(0, 11.5, -8.5)
  if (region === 'left') return new THREE.Vector3(-8.5, 11.5, 0)
  return new THREE.Vector3(8.5, 11.5, 0)
}

const SEAT_OFFSETS: Array<[number, number]> = [
  [-0.5, -0.5], [0.5, -0.5], [-0.5, 0.5], [0.5, 0.5],
  [0, -0.65], [0, 0.65], [-0.65, 0], [0.65, 0],
]

// Avatar groups sit at their feet on the board surface (the slab top);
// hops bounce above that line.
const TOKEN_Y = 0.12

function labelTexture(sp: (typeof BOARD)[number], tileLabel: boolean, dark: boolean): THREE.Texture {
  const ink = dark ? '#e8efff' : '#1c2333'
  const accent = dark ? '#fbbf24' : '#8a5a00'
  const sub = dark ? '#7c89b8' : '#6b7280'
  const cv = document.createElement('canvas')
  cv.width = 256
  cv.height = 128
  const ctx = cv.getContext('2d')!
  ctx.textAlign = 'center'
  ctx.textBaseline = 'middle'
  if ('price' in sp) {
    // wrap the name
    const words = sp.name.split(' ')
    const lines: string[] = []
    let cur = ''
    for (const w of words) {
      if ((cur + ' ' + w).trim().length > 13) {
        lines.push(cur.trim())
        cur = w
      } else cur += ' ' + w
    }
    lines.push(cur.trim())
    ctx.fillStyle = ink
    // long names (e.g. "JR Central - Nozomi Shinkansen") wrap to 3 lines —
    // shrink the type and tighten the leading so the price keeps its spot
    const nameFont = lines.length >= 3 ? 24 : 30
    const lineH = lines.length >= 3 ? 26 : 34
    const startY = lines.length >= 3 ? 32 : lines.length > 1 ? 40 : 46
    ctx.font = `bold ${nameFont}px Segoe UI, sans-serif`
    lines.forEach((ln, k) => ctx.fillText(ln, 128, startY + k * lineH))
    ctx.fillStyle = accent
    ctx.font = 'bold 26px Segoe UI, sans-serif'
    ctx.fillText(`$${sp.price}`, 128, 104)
  } else if (tileLabel) {
    ctx.fillStyle = ink
    ctx.font = 'bold 34px Segoe UI, sans-serif'
    ctx.fillText(sp.name, 128, 56)
    ctx.fillStyle = sub
    ctx.font = '20px Segoe UI, sans-serif'
    const subText: Record<string, string> = {
      go: 'collect $200',
      jail: 'just visiting',
      gotojail: 'straight ahead',
      parking: 'take a breath',
    }
    ctx.fillText(subText[sp.kind] ?? '', 128, 96)
  } else {
    ctx.fillStyle = ink
    ctx.font = 'bold 30px Segoe UI, sans-serif'
    ctx.fillText(sp.kind === 'chance' ? 'CHANCE' : 'COMMUNITY', 128, 40)
    ctx.font = 'bold 24px Segoe UI, sans-serif'
    ctx.fillText(sp.kind === 'chance' ? 'Chance' : 'Community Chest', 128, 86)
  }
  const tex = new THREE.CanvasTexture(cv)
  tex.anisotropy = 4
  return tex
}

interface Hop {
  playerIdx: number
  path: number[] // tile indices in order
  start: number // performance.now()
  perTile: number // ms per tile
  from: number // the tile the stroll starts from
}

export class Board3D {
  private renderer: THREE.WebGLRenderer
  private scene = new THREE.Scene()
  private camera: THREE.PerspectiveCamera
  private clock = new THREE.Clock()
  private raf = 0

  private tileMats: THREE.MeshStandardMaterial[] = []
  private tileMeshes: THREE.Mesh[] = []
  private bandMats: THREE.MeshStandardMaterial[] = []
  private labelMeshes: THREE.Mesh[] = []
  private labelHome: number[] = [] // outside-facing rotation per tile
  private activeTileIndex: number | null = null // the tile whose label faces the camera
  private houseGroups: THREE.Group[] = []
  private lastHouses: number[] = []
  private tokens: THREE.Object3D[] = []
  private tokenPos: THREE.Vector3[] = []
  private prevPos: number[] = []
  private hops: Hop[] = []

  private ringGold: THREE.Mesh
  private ringBlue: THREE.Mesh

  private lookTarget = new THREE.Vector3(0, 0, 0)
  private focusGoal = new THREE.Vector3(0, 0, 0)
  private posGoal = new THREE.Vector3(0, 30, 24)
  private idle = true
  private idleAngle = 0.6
  private disposed = false

  // user inspection: drag to orbit the board, release to glide back home
  private dragging = false
  private dragX = 0
  private dragY = 0
  private userYaw = 0
  private userPitch = 0
  private userZoom = 1
  private returning = false
  private wheelDeadline = 0
  private hopDelayMs = 0
  private theme: 'light' | 'dark' = 'light'
  private tileBase = 0xf3eee2
  private tileDim = 0xd9d2c2
  private titleMesh: THREE.Mesh | null = null
  private slabMat: THREE.MeshStandardMaterial | null = null
  private groundMat: THREE.MeshStandardMaterial | null = null
  private ambLight: THREE.AmbientLight | null = null
  private dirLight: THREE.DirectionalLight | null = null
  // touch pointers for pinch-zoom and two-finger pan (phones have no wheel)
  private pointers = new Map<number, { x: number; y: number }>()
  private pinchStart: { dist: number; zoom: number; cx: number; cy: number } | null = null
  // tap-to-inspect: a short, still press raycasts the tile under the finger
  private downX = 0
  private downY = 0
  private downTime = 0
  private raycaster = new THREE.Raycaster()
  /** Set by hosts that want tile inspection (the phone's pocket board). */
  onTileTap?: (space: number) => void
  // Free-roam mode (the pocket board): the camera stops chasing the game
  // and stops easing back after every gesture — the view stays exactly
  // where the player leaves it until they tap Reset or Follow.
  private roam = false

  constructor(container: HTMLElement) {
    this.renderer = new THREE.WebGLRenderer({ antialias: true })
    this.renderer.setPixelRatio(Math.min(window.devicePixelRatio, 2))
    this.renderer.setSize(window.innerWidth, window.innerHeight)
    this.renderer.setClearColor(0x0b0e1a)
    this.renderer.domElement.style.position = 'fixed'
    this.renderer.domElement.style.inset = '0'
    this.renderer.domElement.style.zIndex = '0'
    container.appendChild(this.renderer.domElement)

    this.scene.fog = new THREE.Fog(0x0b0e1a, 45, 110)
    this.camera = new THREE.PerspectiveCamera(46, window.innerWidth / window.innerHeight, 0.1, 200)
    this.camera.position.set(0, 30, 24)

    const amb = new THREE.AmbientLight(0xdde6ff, 0.55)
    this.ambLight = amb
    this.scene.add(amb)
    const dir = new THREE.DirectionalLight(0xffffff, 1.0)
    this.dirLight = dir
    dir.position.set(12, 26, 10)
    this.scene.add(dir)
    const warm = new THREE.PointLight(0x6c8cff, 30, 60)
    warm.position.set(0, 14, 0)
    this.scene.add(warm)

    this.buildBoard()
    this.ringGold = this.makeRing(0xfbbf24)
    this.ringBlue = this.makeRing(0x6c8cff)

    window.addEventListener('resize', this.onResize)
    // click-and-drag inspection: orbit around the current focus, zoom with
    // the wheel; on release (or wheel idle) the view eases back to default
    const dom = this.renderer.domElement
    dom.style.cursor = 'grab'
    dom.style.touchAction = 'none'
    dom.addEventListener('pointerdown', this.onPointerDown)
    window.addEventListener('pointermove', this.onPointerMove)
    window.addEventListener('pointerup', this.onPointerUp)
    dom.addEventListener('wheel', this.onWheel, { passive: false })
    this.animate()
  }

  private onPointerDown = (ev: PointerEvent): void => {
    if (ev.button !== 0) return
    this.pointers.set(ev.pointerId, { x: ev.clientX, y: ev.clientY })
    this.dragging = true
    this.returning = false
    this.wheelDeadline = 0
    this.dragX = ev.clientX
    this.dragY = ev.clientY
    this.downX = ev.clientX
    this.downY = ev.clientY
    this.downTime = performance.now()
    this.renderer.domElement.style.cursor = 'grabbing'
    this.startPinch()
  }

  private onPointerMove = (ev: PointerEvent): void => {
    if (!this.pointers.has(ev.pointerId)) {
      if (!this.dragging) return
      const dx = ev.clientX - this.dragX
      const dy = ev.clientY - this.dragY
      this.dragX = ev.clientX
      this.dragY = ev.clientY
      this.userYaw -= dx * 0.005
      this.userPitch = THREE.MathUtils.clamp(this.userPitch + dy * 0.004, -1.15, 1.15)
      return
    }
    this.pointers.set(ev.pointerId, { x: ev.clientX, y: ev.clientY })
    // two fingers: pinch to zoom, or pan when the pair moves together
    if (this.pointers.size >= 2 && this.pinchStart) {
      this.pinchOrPan()
      return
    }
    if (!this.dragging) return
    const dx = ev.clientX - this.dragX
    const dy = ev.clientY - this.dragY
    this.dragX = ev.clientX
    this.dragY = ev.clientY
    this.userYaw -= dx * 0.005
    this.userPitch = THREE.MathUtils.clamp(this.userPitch + dy * 0.004, -1.15, 1.15)
  }

  private onPointerUp = (ev: PointerEvent): void => {
    const wasTap =
      this.pointers.size === 1 &&
      Math.hypot(ev.clientX - this.downX, ev.clientY - this.downY) < 8 &&
      performance.now() - this.downTime < 400
    this.pointers.delete(ev.pointerId)
    if (this.pointers.size < 2) this.pinchStart = null
    if (this.pointers.size === 0) {
      if (!this.dragging) return
      this.dragging = false
      // tracking mode glides back to the followed action; roaming keeps
      // the view exactly where the player left it
      this.returning = !this.roam
      this.renderer.domElement.style.cursor = 'grab'
      // tap-to-inspect (roam view): a short, still press names the tile
      if (wasTap && this.onTileTap && this.roam) {
        const space = this.tryTapTile(ev.clientX, ev.clientY)
        if (space != null) this.onTileTap(space)
      }
    }
  }

  private startPinch(): void {
    if (this.pointers.size < 2) return
    const [a, b] = [...this.pointers.values()]
    this.pinchStart = { dist: Math.hypot(a.x - b.x, a.y - b.y), zoom: this.userZoom, cx: (a.x + b.x) / 2, cy: (a.y + b.y) / 2 }
  }

  // Two fingers: pinch when the spread changes, pan (lateral movement)
  // when the pair moves together — map-style. Rebased every event so both
  // stay incremental.
  private pinchOrPan(): void {
    if (!this.pinchStart) return
    const [a, b] = [...this.pointers.values()]
    const dist = Math.hypot(a.x - b.x, a.y - b.y)
    const cx = (a.x + b.x) / 2
    const cy = (a.y + b.y) / 2
    const distDelta = Math.abs(dist - this.pinchStart.dist)
    const centroidDelta = Math.hypot(cx - this.pinchStart.cx, cy - this.pinchStart.cy)
    if (centroidDelta > 6 && distDelta < 24) {
      this.panBy((cx - this.pinchStart.cx) / window.innerWidth, (cy - this.pinchStart.cy) / window.innerHeight)
    } else if (this.pinchStart.dist > 0 && distDelta > 2) {
      this.userZoom = THREE.MathUtils.clamp(this.pinchStart.zoom * (dist / this.pinchStart.dist), 0.45, 2.6)
      this.wheelDeadline = this.roam ? 0 : performance.now() + 2000
    }
    this.pinchStart = { dist, zoom: this.userZoom, cx, cy }
  }

  // Translate the view along the camera's ground plane — drag moves the
  // board with the fingers, like a map.
  private panBy(dx: number, dy: number): void {
    const scale = this.camera.position.distanceTo(this.lookTarget) * 0.9
    const right = new THREE.Vector3().setFromMatrixColumn(this.camera.matrix, 0)
    right.y = 0
    right.normalize()
    const fwd = new THREE.Vector3()
    this.camera.getWorldDirection(fwd)
    fwd.y = 0
    fwd.normalize()
    const delta = right.multiplyScalar(-dx * scale).add(fwd.multiplyScalar(-dy * scale))
    this.focusGoal.add(delta)
    this.posGoal.add(delta)
    this.lookTarget.add(delta)
    // keep the board somewhere in view
    this.focusGoal.x = THREE.MathUtils.clamp(this.focusGoal.x, -16, 16)
    this.focusGoal.z = THREE.MathUtils.clamp(this.focusGoal.z, -16, 16)
  }

  private tryTapTile(x: number, y: number): number | null {
    const ndc = new THREE.Vector2((x / window.innerWidth) * 2 - 1, -(y / window.innerHeight) * 2 + 1)
    this.raycaster.setFromCamera(ndc, this.camera)
    const hits = this.raycaster.intersectObjects(this.tileMeshes, false)
    return hits.length > 0 && typeof hits[0].object.userData.space === 'number' ? (hits[0].object.userData.space as number) : null
  }

  private onWheel = (ev: WheelEvent): void => {
    ev.preventDefault()
    this.userZoom = THREE.MathUtils.clamp(this.userZoom * (ev.deltaY > 0 ? 1.08 : 0.93), 0.45, 2.6)
    // zoom eases home after idle only when tracking the game — roaming keeps it
    this.wheelDeadline = this.roam ? 0 : performance.now() + 2000
  }

  private onResize = (): void => {
    this.camera.aspect = window.innerWidth / window.innerHeight
    this.camera.updateProjectionMatrix()
    this.renderer.setSize(window.innerWidth, window.innerHeight)
  }

  private makeRing(color: number): THREE.Mesh {
    const geo = new THREE.RingGeometry(1.06, 1.24, 48)
    geo.rotateX(-Math.PI / 2)
    const mat = new THREE.MeshBasicMaterial({ color, transparent: true, opacity: 0.85, side: THREE.DoubleSide })
    const mesh = new THREE.Mesh(geo, mat)
    mesh.position.y = 0.26
    mesh.visible = false
    this.scene.add(mesh)
    return mesh
  }

  private buildBoard(): void {
    // center slab
    const slabMat = new THREE.MeshStandardMaterial({ color: 0xf3eee2, roughness: 0.9 })
    this.slabMat = slabMat
    const slab = new THREE.Mesh(
      new THREE.BoxGeometry(9 * TILE - 0.3, 0.24, 9 * TILE - 0.3),
      slabMat,
    )
    slab.position.y = 0.02
    this.scene.add(slab)

    // center title
    const title = new THREE.Mesh(
      new THREE.PlaneGeometry(12, 6),
      new THREE.MeshBasicMaterial({ transparent: true }),
    )
    title.rotation.x = -Math.PI / 2
    title.position.y = 0.16
    this.titleMesh = title
    this.scene.add(title)
    this.drawTitle()

    // the ground
    const groundMat = new THREE.MeshStandardMaterial({ color: 0xded7c6, roughness: 1 })
    this.groundMat = groundMat
    const ground = new THREE.Mesh(new THREE.PlaneGeometry(140, 140), groundMat)
    ground.rotation.x = -Math.PI / 2
    ground.position.y = -0.12
    this.scene.add(ground)

    for (let i = 0; i < BOARD.length; i++) {
      const sp = BOARD[i]
      const t = tileCenter(i)
      const purch = 'price' in sp

      const base = new THREE.MeshStandardMaterial({ color: this.tileBase, roughness: 0.85 })
      const tile = new THREE.Mesh(new THREE.BoxGeometry(TILE_W, 0.22, TILE_W), base)
      tile.position.set(t.x, 0.11, t.z)
      tile.userData.space = i
      this.scene.add(tile)
      this.tileMats[i] = base
      this.tileMeshes[i] = tile

      // label
      const geo = new THREE.PlaneGeometry(1.78, 0.89)
      geo.rotateX(-Math.PI / 2)
      const label = new THREE.Mesh(geo, new THREE.MeshBasicMaterial({ map: labelTexture(sp, !purch && sp.kind !== 'chance' && sp.kind !== 'chest', this.theme === 'dark'), transparent: true }))
      label.position.set(t.x, 0.235, t.z)
      // orient so the label reads from OUTSIDE the board (classic layout)
      // left column: -90° (reads from the west), right column: +90° (east)
      const homeRot =
        t.region === 'bottom' ? 0
        : t.region === 'top' ? Math.PI
        : t.region === 'left' ? -Math.PI / 2
        : Math.PI / 2
      label.rotation.y = homeRot
      this.labelHome[i] = homeRot
      this.scene.add(label)
      this.labelMeshes[i] = label

      // color band on the inner edge
      let bandColor = 0x2c3a63
      if (isStreet(sp)) bandColor = new THREE.Color(GROUP_COLORS[sp.group]).getHex()
      else if (sp.kind === 'rail') bandColor = 0x3a3f4d
      else if (sp.kind === 'utility') bandColor = 0x8a93a6
      const bandMat = new THREE.MeshStandardMaterial({ color: bandColor, roughness: 0.6 })
      const horizontal = t.region === 'bottom' || t.region === 'top'
      const bandGeo = horizontal ? new THREE.BoxGeometry(TILE_W, 0.12, 0.55) : new THREE.BoxGeometry(0.55, 0.12, TILE_W)
      const band = new THREE.Mesh(bandGeo, bandMat)
      const off = 0.645
      if (t.region === 'bottom') band.position.set(t.x, 0.17, t.z - off)
      if (t.region === 'top') band.position.set(t.x, 0.17, t.z + off)
      if (t.region === 'left') band.position.set(t.x + off, 0.17, t.z)
      if (t.region === 'right') band.position.set(t.x - off, 0.17, t.z)
      this.scene.add(band)
      this.bandMats[i] = bandMat
      if (!purch) band.visible = false

      const hg = new THREE.Group()
      this.scene.add(hg)
      this.houseGroups[i] = hg
      this.lastHouses[i] = 0
    }
  }

  private ensureToken(idx: number, color: string): THREE.Object3D {
    if (this.tokens[idx]) return this.tokens[idx]
    // One distinct avatar per emoji (see tokens3d.ts) — feet on the tile.
    const obj = createAvatar(idx, color)
    this.scene.add(obj)
    this.tokens[idx] = obj
    this.tokenPos[idx] = obj.position.clone()
    return obj
  }

  private setHouses(i: number, count: number, region: string): void {
    const g = this.houseGroups[i]
    if (this.lastHouses[i] === count) return
    this.lastHouses[i] = count
    while (g.children.length) g.remove(g.children[0])
    if (count <= 0) return
    const t = tileCenter(i)
    const hotel = count === 5
    if (hotel) {
      const m = new THREE.Mesh(
        new THREE.BoxGeometry(0.5, 0.3, 0.42),
        new THREE.MeshStandardMaterial({ color: 0xd6449e, roughness: 0.5 }),
      )
      m.position.set(t.x, 0.34, t.z + (region === 'bottom' ? -0.645 : region === 'top' ? 0.645 : 0))
      if (region === 'left') m.position.set(t.x + 0.645, 0.34, t.z)
      if (region === 'right') m.position.set(t.x - 0.645, 0.34, t.z)
      g.add(m)
      return
    }
    const houseMat = new THREE.MeshStandardMaterial({ color: 0xf3f6ff, roughness: 0.4 })
    for (let k = 0; k < count; k++) {
      const m = new THREE.Mesh(new THREE.BoxGeometry(0.2, 0.18, 0.16), houseMat)
      const along = -0.42 + k * 0.28
      if (region === 'bottom' || region === 'top') m.position.set(t.x + along, 0.31, t.z + (region === 'bottom' ? -0.645 : 0.645))
      else m.position.set(t.x + (region === 'left' ? 0.645 : -0.645), 0.31, t.z + along)
      g.add(m)
    }
  }

  // ── public API ──

  // Free-roam mode for the pocket board: the whole board in view, no
  // chasing the current player, no snap-back after gestures.
  setRoam(on: boolean): void {
    this.roam = on
    if (on) this.resetRoamView()
  }

  // The overview the player can always return to with one tap.
  resetRoamView(): void {
    this.userYaw = 0
    this.userPitch = 0
    this.userZoom = 1
    this.returning = false
    this.wheelDeadline = 0
    this.focusGoal.set(0, 0, 0)
    this.posGoal.set(0, 34, 26)
    this.lookTarget.set(0, 0, 0)
  }

  setIdle(): void {
    this.idle = true
    this.ringGold.visible = false
    this.ringBlue.visible = false
    this.activeTileIndex = null
  }

  // Hold freshly-detected hops until the dice animation finishes on the TV.
  delayHops(ms: number): void {
    this.hopDelayMs = ms
  }

  // Bright light mode is the default; dark mode keeps the moody original.
  setTheme(theme: 'light' | 'dark'): void {
    this.theme = theme
    const dark = theme === 'dark'
    this.tileBase = dark ? 0x16203c : 0xf3eee2
    this.tileDim = dark ? 0x0c1220 : 0xd9d2c2
    this.renderer.setClearColor(dark ? 0x0b0e1a : 0xece7db)
    if (this.scene.fog) this.scene.fog.color.set(dark ? 0x0b0e1a : 0xece7db)
    if (this.ambLight) this.ambLight.intensity = dark ? 0.55 : 0.9
    if (this.dirLight) this.dirLight.intensity = dark ? 1.0 : 1.15
    if (this.groundMat) this.groundMat.color.set(dark ? 0x070911 : 0xded7c6)
    if (this.slabMat) this.slabMat.color.set(dark ? 0x0d1426 : 0xf3eee2)
    this.drawTitle()
    for (let i = 0; i < BOARD.length; i++) {
      const label = this.labelMeshes[i]
      const sp = BOARD[i]
      if (!label) continue
      const purch = 'price' in sp
      const mat = label.material as THREE.MeshBasicMaterial
      mat.map?.dispose()
      mat.map = labelTexture(sp, !purch && sp.kind !== 'chance' && sp.kind !== 'chest', dark)
      mat.needsUpdate = true
    }
  }

  private drawTitle(): void {
    if (!this.titleMesh) return
    const dark = this.theme === 'dark'
    const cv = document.createElement('canvas')
    cv.width = 1024
    cv.height = 512
    const cctx = cv.getContext('2d')!
    cctx.textAlign = 'center'
    cctx.textBaseline = 'middle'
    cctx.fillStyle = dark ? '#dfe7ff' : '#1c2333'
    cctx.font = 'bold 120px Segoe UI, sans-serif'
    cctx.fillText('MONOPOLY', 512, 170)
    cctx.fillStyle = dark ? '#6c8cff' : '#2c4bd8'
    cctx.fillText('PARTY', 512, 320)
    const mat = this.titleMesh.material as THREE.MeshBasicMaterial
    mat.map?.dispose()
    mat.map = new THREE.CanvasTexture(cv)
    mat.needsUpdate = true
  }

  sync(v: HostView): void {
    this.idle = false

    // properties: owners, mortgages, houses
    for (let i = 0; i < BOARD.length; i++) {
      const st = v.props[i]
      const sp = BOARD[i]
      if (!st || !('price' in sp)) continue
      const mat = this.tileMats[i]
      const band = this.bandMats[i]
      if (st.owner) {
        const owner = v.players.find((p) => p.id === st.owner)
        const oc = new THREE.Color(owner?.color ?? '#888')
        mat.color.set(this.tileBase).lerp(oc, 0.4)
      } else {
        mat.color.set(this.tileBase)
      }
      if (isStreet(sp)) {
        const base = new THREE.Color(GROUP_COLORS[sp.group])
        band.color.copy(base).lerp(new THREE.Color(0x333845), st.mortgaged ? 0.8 : 0)
        mat.color.lerp(new THREE.Color(this.tileDim), st.mortgaged ? 0.5 : 0)
        this.setHouses(i, st.houses, tileCenter(i).region)
      } else if (st.mortgaged) {
        band.color.set(0x333845)
      }
    }

    // tokens + movement detection
    for (let idx = 0; idx < v.players.length; idx++) {
      const p = v.players[idx]
      const mesh = this.ensureToken(idx, p.color)
      mesh.visible = !p.bankrupt
      const prev = this.prevPos[idx] ?? p.pos
      this.prevPos[idx] = p.pos // always track — the ?? fallback above must
      // only apply on the very first sight of a token, never on later syncs
      if (p.pos !== prev) {
        const mv = v.lastMove
        if (mv && mv.playerId === p.id && mv.path.length > 0 && mv.path[mv.path.length - 1] === p.pos) {
          // a real stroll — dice moves AND card advances ("nearest utility",
          // "advance to GO") walk tile-by-tile; long strolls roll quicker
          const perTile = mv.path.length > 8 ? 110 : 170
          this.hops = this.hops.filter((h) => h.playerIdx !== idx)
          this.hops.push({ playerIdx: idx, path: mv.path, start: performance.now() + this.hopDelayMs, perTile, from: prev })
        } else {
          // jail sends, god teleports, imports: snap to the destination
          const t = tileCenter(p.pos)
          const seat = SEAT_OFFSETS[idx % SEAT_OFFSETS.length]
          mesh.position.set(t.x + seat[0], TOKEN_Y, t.z + seat[1])
        }
        this.prevPos[idx] = p.pos
      } else if (!this.hops.some((h) => h.playerIdx === idx)) {
        const t = tileCenter(p.pos)
        const seat = SEAT_OFFSETS[idx % SEAT_OFFSETS.length]
        mesh.position.set(t.x + seat[0], TOKEN_Y, t.z + seat[1])
      }
    }
    for (let idx = v.players.length; idx < this.tokens.length; idx++) {
      if (this.tokens[idx]) this.tokens[idx].visible = false
    }

    // highlights — the ring and the "reads well on TV" label follow the same
    // focus: the current player, or the debtor while a debt resolves
    const focusPlayer = v.debt
      ? v.players.find((p) => p.id === v.debt?.debtor)
      : v.players.find((p) => p.id === v.currentPlayerId)
    if (v.phase !== 'GAME_OVER' && focusPlayer && !focusPlayer.bankrupt) {
      const t = tileCenter(focusPlayer.pos)
      this.ringBlue.position.set(t.x, 0.26, t.z)
      this.ringBlue.visible = true
      this.activeTileIndex = focusPlayer.pos
    } else {
      this.ringBlue.visible = false
      this.activeTileIndex = null
    }
    const decision = v.pendingPurchase ?? v.auction?.space ?? null
    if (decision != null) {
      const t = tileCenter(decision)
      this.ringGold.position.set(t.x, 0.27, t.z)
      this.ringGold.visible = true
    } else {
      this.ringGold.visible = false
    }

    // camera focus: the active piece, viewed from OUTSIDE its own side of
    // the board — Pacific Ave (right edge) faces east, Illinois (top) faces
    // north, and so on. Labels stay static; the camera does the moving.
    // Roaming skips all of this: the player owns the camera.
    if (this.roam) {
      // keep the clock/reschedule bookkeeping consistent, drop the goals
    } else {
      const focusIdx = v.debt ? v.players.findIndex((p) => p.id === v.debt?.debtor) : v.players.findIndex((p) => p.id === v.currentPlayerId)
      if (v.phase === 'GAME_OVER' || focusIdx < 0) {
        this.focusGoal.set(0, 0, 0)
        this.posGoal.set(0, 34, 26)
      } else {
        const player = v.players[focusIdx]
        // Focus the tile the player is ON, never the mesh: on the landing
        // view the mesh still sits at the pre-hop tile while the hop plays
        // out, so a mesh-based focus left the camera easing back to the OLD
        // position once the stroll ended. The hop chase still tracks the
        // live token; this is the resting goal it eases back to.
        if (player) {
          const t = tileCenter(player.pos)
          this.focusGoal.set(t.x, 0, t.z)
          this.posGoal.set(t.x, 0, t.z).add(cameraOffset(player.pos))
        }
      }
    }

    // the hop delay is one-shot: only hops from the fresh roll wait for dice
    this.hopDelayMs = 0
  }

  dispose(): void {
    this.disposed = true
    cancelAnimationFrame(this.raf)
    window.removeEventListener('resize', this.onResize)
    window.removeEventListener('pointermove', this.onPointerMove)
    window.removeEventListener('pointerup', this.onPointerUp)
    this.renderer.domElement.removeEventListener('pointerdown', this.onPointerDown)
    this.renderer.domElement.removeEventListener('wheel', this.onWheel)
    this.renderer.dispose()
    this.renderer.domElement.remove()
  }

  // ── frame loop ──

  private animate = (): void => {
    if (this.disposed) return
    this.raf = requestAnimationFrame(this.animate)
    const dt = Math.min(this.clock.getDelta(), 0.1)
    const now = performance.now()

    // advance hops
    for (const hop of [...this.hops]) {
      const mesh = this.tokens[hop.playerIdx]
      if (!mesh) continue
      const elapsed = now - hop.start
      if (elapsed < 0) continue // waiting for the dice animation to finish
      const done = Math.floor(elapsed / hop.perTile)
      if (done >= hop.path.length) {
        const last = tileCenter(hop.path[hop.path.length - 1])
        const seat = SEAT_OFFSETS[hop.playerIdx % SEAT_OFFSETS.length]
        mesh.position.set(last.x + seat[0], TOKEN_Y, last.z + seat[1])
        this.hops = this.hops.filter((h) => h !== hop)
        continue
      }
      const from = tileCenter(done === 0 ? hop.from : hop.path[done - 1])
      const to = tileCenter(hop.path[done])
      const frac = (elapsed % hop.perTile) / hop.perTile
      const seat = SEAT_OFFSETS[hop.playerIdx % SEAT_OFFSETS.length]
      const x = THREE.MathUtils.lerp(from.x, to.x, frac) + seat[0]
      const z = THREE.MathUtils.lerp(from.z, to.z, frac) + seat[1]
      const y = TOKEN_Y + Math.sin(frac * Math.PI) * 0.9
      mesh.position.set(x, y, z)
    }

    // rings pulse
    const s = 1 + Math.sin(now / 260) * 0.06
    if (this.ringGold.visible) this.ringGold.scale.setScalar(s)
    if (this.ringBlue.visible) this.ringBlue.scale.setScalar(1 + Math.sin(now / 380) * 0.04)

    // labels: text is STATIC — every tile keeps its outside-facing home
    // rotation; only the active tile's label scales up a touch for the
    // close-up (the camera handles readability by facing the piece's side)
    const k = 1 - Math.pow(0.004, dt)
    for (let i = 0; i < this.labelMeshes.length; i++) {
      const label = this.labelMeshes[i]
      if (!label) continue
      const target = i === this.activeTileIndex ? 1.18 : 1
      if (Math.abs(label.scale.x - target) > 0.001) {
        label.scale.setScalar(label.scale.x + (target - label.scale.x) * k)
      }
    }

    // camera rig
    if (this.idle) {
      this.idleAngle += dt * 0.12
      this.posGoal.set(Math.sin(this.idleAngle) * 27, 24, Math.cos(this.idleAngle) * 27)
      this.focusGoal.set(0, 0, 0)
    }
    const followFocus = !this.idle && this.hops.length > 0 ? this.focusGoal.clone() : this.focusGoal
    // while a token is hopping, the camera chases its live position
    // (roaming owns the camera — no chase)
    if (!this.idle && !this.roam) {
      const hop = this.hops[0]
      if (hop) {
        const mesh = this.tokens[hop.playerIdx]
        if (mesh) {
          followFocus.copy(mesh.position)
          this.posGoal.copy(mesh.position).add(cameraOffset(hop.path[hop.path.length - 1]))
        }
      }
    }
    const ease = 1 - Math.pow(0.0012, dt)
    const easeLook = 1 - Math.pow(0.0018, dt)

    // user inspection: while dragging (or easing back after release), the
    // camera is placed directly from the default offset + the user's orbit
    const inspecting =
      this.dragging ||
      Math.abs(this.userYaw) > 0.0005 ||
      Math.abs(this.userPitch) > 0.0005 ||
      Math.abs(this.userZoom - 1) > 0.0005
    if (!this.dragging && inspecting && (this.returning || (this.wheelDeadline > 0 && now > this.wheelDeadline))) {
      // release (or wheel idle): glide the orbit back to the default view
      const k = 1 - Math.pow(0.02, dt)
      this.userYaw += (0 - this.userYaw) * k
      this.userPitch += (0 - this.userPitch) * k
      this.userZoom += (1 - this.userZoom) * k
      if (Math.abs(this.userYaw) < 0.0005 && Math.abs(this.userPitch) < 0.0005 && Math.abs(this.userZoom - 1) < 0.0005) {
        this.userYaw = 0
        this.userPitch = 0
        this.userZoom = 1
        this.returning = false
        this.wheelDeadline = 0
      }
    }
    if (inspecting) {
      // pivot keeps tracking the focus so nothing jumps after the release
      this.lookTarget.lerp(followFocus, easeLook)
      const base = this.posGoal.clone().sub(this.lookTarget).multiplyScalar(this.userZoom)
      const sph = new THREE.Spherical().setFromVector3(base)
      sph.theta += this.userYaw
      sph.phi = THREE.MathUtils.clamp(sph.phi - this.userPitch, 0.12, Math.PI / 2 - 0.02)
      this.camera.position.copy(this.lookTarget).add(new THREE.Vector3().setFromSpherical(sph))
      this.camera.lookAt(this.lookTarget)
    } else {
      this.camera.position.lerp(this.posGoal, ease)
      this.lookTarget.lerp(followFocus, easeLook)
      this.camera.lookAt(this.lookTarget)
    }

    this.renderer.render(this.scene, this.camera)
  }
}
