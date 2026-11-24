// ── 3D player avatars ──
// One distinct avatar per allowed emoji (see shared/tokens.ts), shared by
// the TV board and the phone's piece picker, so the piece you choose on
// your phone is exactly the piece that walks the board. Origins sit at the
// avatar's feet; callers place the group on the tile surface.

import * as THREE from 'three'

function box(w: number, h: number, d: number, x: number, y: number, z: number, mat: THREE.Material, rz = 0): THREE.Mesh {
  const m = new THREE.Mesh(new THREE.BoxGeometry(w, h, d), mat)
  m.position.set(x, y, z)
  m.rotation.z = rz
  return m
}

function cyl(r: number, h: number, x: number, y: number, z: number, mat: THREE.Material, rot?: 'x' | 'z', rz = 0): THREE.Mesh {
  const m = new THREE.Mesh(new THREE.CylinderGeometry(r, r, h, 18), mat)
  m.position.set(x, y, z)
  if (rot === 'x') m.rotation.x = Math.PI / 2
  if (rot === 'z') m.rotation.z = Math.PI / 2 + rz
  else if (rz) m.rotation.z = rz
  return m
}

function sph(r: number, x: number, y: number, z: number, mat: THREE.Material, sx = 1, sy = 1, sz = 1): THREE.Mesh {
  const m = new THREE.Mesh(new THREE.SphereGeometry(r, 22, 16), mat)
  m.position.set(x, y, z)
  m.scale.set(sx, sy, sz)
  return m
}

function cone(r: number, h: number, x: number, y: number, z: number, mat: THREE.Material, rz = 0): THREE.Mesh {
  const m = new THREE.Mesh(new THREE.ConeGeometry(r, h, 18), mat)
  m.position.set(x, y, z)
  m.rotation.z = rz
  return m
}

// The star is the only extruded shape — five points, lying flat like a piece.
function starMat4(): THREE.BufferGeometry {
  const shape = new THREE.Shape()
  const spikes = 5
  const outer = 0.32
  const inner = 0.14
  for (let i = 0; i < spikes * 2; i++) {
    const r = i % 2 === 0 ? outer : inner
    const a = (i / (spikes * 2)) * Math.PI * 2 - Math.PI / 2
    const px = Math.cos(a) * r
    const py = Math.sin(a) * r
    if (i === 0) shape.moveTo(px, py)
    else shape.lineTo(px, py)
  }
  shape.closePath()
  const geo = new THREE.ExtrudeGeometry(shape, { depth: 0.1, bevelEnabled: true, bevelSize: 0.02, bevelThickness: 0.02, bevelSegments: 1 })
  geo.rotateX(-Math.PI / 2)
  return geo
}

// idx maps 1:1 to shared/tokens.ts TOKENS order:
// 🎩 🚗 🐕 🚢 👞 🐈 🛴 🦆 🚂 🚁 🛩️ 🐎 🐘 🚀 ⭐ 🍒
export function createAvatar(idx: number, color: string): THREE.Group {
  const g = new THREE.Group()
  const main = new THREE.MeshStandardMaterial({
    color: new THREE.Color(color),
    roughness: 0.45,
    metalness: 0.2,
    emissive: new THREE.Color(color),
    emissiveIntensity: 0.16,
  })
  const dark = new THREE.MeshStandardMaterial({ color: new THREE.Color(color).multiplyScalar(0.45), roughness: 0.6 })
  const gold = new THREE.MeshStandardMaterial({ color: 0xfbbf24, roughness: 0.35, metalness: 0.5 })

  switch (idx % 16) {
    case 0: { // 🎩 top hat
      g.add(cyl(0.34, 0.05, 0, 0.025, 0, main))
      g.add(cyl(0.2, 0.36, 0, 0.23, 0, main))
      g.add(cyl(0.21, 0.09, 0, 0.13, 0, gold))
      break
    }
    case 1: { // 🚗 car
      g.add(box(0.62, 0.2, 0.34, 0, 0.2, 0, main))
      g.add(box(0.3, 0.15, 0.3, -0.03, 0.35, 0, main))
      g.add(cyl(0.09, 0.05, 0.22, 0.1, 0.18, dark, 'x'), cyl(0.09, 0.05, 0.22, 0.1, -0.18, dark, 'x'))
      g.add(cyl(0.09, 0.05, -0.22, 0.1, 0.18, dark, 'x'), cyl(0.09, 0.05, -0.22, 0.1, -0.18, dark, 'x'))
      g.add(cyl(0.04, 0.1, 0.32, 0.24, 0, gold))
      break
    }
    case 2: { // 🐕 dog
      g.add(sph(0.26, 0, 0.26, 0, main, 1.25, 0.9, 0.9))
      g.add(sph(0.17, 0.3, 0.4, 0, main))
      g.add(box(0.12, 0.1, 0.14, 0.42, 0.36, 0, main))
      g.add(box(0.05, 0.15, 0.09, 0.26, 0.5, 0.1, main, 0.25))
      g.add(box(0.05, 0.15, 0.09, 0.26, 0.5, -0.1, main, -0.25))
      g.add(cyl(0.035, 0.2, -0.32, 0.4, 0, main, undefined, -0.9))
      break
    }
    case 3: { // 🚢 ship
      g.add(box(0.68, 0.16, 0.3, 0, 0.14, 0, main))
      g.add(box(0.48, 0.08, 0.22, -0.04, 0.26, 0, main))
      g.add(cyl(0.07, 0.18, -0.12, 0.38, 0, dark))
      g.add(cyl(0.06, 0.16, -0.12, 0.28, 0, gold))
      break
    }
    case 4: { // 👞 boot
      g.add(box(0.24, 0.34, 0.26, -0.06, 0.19, 0, main))
      g.add(box(0.3, 0.14, 0.26, 0.14, 0.07, 0, main))
      g.add(box(0.1, 0.1, 0.26, 0.28, 0.05, 0, dark))
      break
    }
    case 5: { // 🐈 cat
      g.add(sph(0.24, 0, 0.24, 0, main, 1.3, 0.9, 0.9))
      g.add(sph(0.15, 0.28, 0.38, 0, main))
      g.add(cone(0.06, 0.13, 0.24, 0.52, 0.08, main))
      g.add(cone(0.06, 0.13, 0.24, 0.52, -0.08, main))
      g.add(cyl(0.035, 0.26, -0.3, 0.36, 0, main, undefined, -1))
      break
    }
    case 6: { // 🛴 scooter
      g.add(box(0.56, 0.07, 0.22, 0.02, 0.17, 0, main))
      g.add(cyl(0.04, 0.5, -0.24, 0.42, 0, main, 'z', 0.22))
      g.add(box(0.26, 0.05, 0.05, -0.34, 0.66, 0, dark))
      g.add(cyl(0.1, 0.06, 0.24, 0.1, 0, dark, 'x'))
      g.add(cyl(0.1, 0.06, -0.2, 0.1, 0, dark, 'x'))
      break
    }
    case 7: { // 🦆 duck
      g.add(sph(0.27, 0, 0.22, 0, main, 1.15, 0.95, 0.95))
      g.add(sph(0.15, 0.22, 0.42, 0, main))
      g.add(cone(0.06, 0.13, 0.38, 0.42, 0, gold, -Math.PI / 2))
      g.add(sph(0.05, 0.5, 0.5, 0, dark))
      break
    }
    case 8: { // 🚂 train
      g.add(cyl(0.15, 0.44, 0.06, 0.24, 0, main, 'z'))
      g.add(box(0.2, 0.32, 0.28, -0.26, 0.3, 0, main))
      g.add(cyl(0.06, 0.16, 0.24, 0.44, 0, dark))
      g.add(cyl(0.08, 0.05, 0.24, 0.09, 0.14, dark, 'x'))
      g.add(cyl(0.08, 0.05, 0.24, 0.09, -0.14, dark, 'x'))
      g.add(cyl(0.08, 0.05, -0.26, 0.09, 0.14, dark, 'x'))
      g.add(cyl(0.08, 0.05, -0.26, 0.09, -0.14, dark, 'x'))
      break
    }
    case 9: { // 🚁 helicopter
      g.add(sph(0.21, 0.02, 0.24, 0, main, 1.2, 0.9, 0.9))
      g.add(cyl(0.04, 0.42, -0.36, 0.3, 0, main, 'z'))
      g.add(box(0.1, 0.14, 0.04, -0.55, 0.36, 0, main))
      g.add(box(0.85, 0.03, 0.09, 0.02, 0.5, 0, dark))
      g.add(box(0.03, 0.22, 0.06, -0.55, 0.42, 0.05, dark))
      break
    }
    case 10: { // 🛩️ plane
      g.add(cyl(0.12, 0.56, 0, 0.28, 0, main, 'z'))
      g.add(cone(0.12, 0.14, 0.35, 0.28, 0, main, -Math.PI / 2))
      g.add(box(0.18, 0.05, 0.8, 0, 0.28, 0, main))
      g.add(box(0.14, 0.14, 0.05, -0.26, 0.38, 0, main))
      g.add(cyl(0.05, 0.09, -0.27, 0.21, 0.12, dark))
      g.add(cyl(0.05, 0.09, -0.27, 0.21, -0.12, dark))
      break
    }
    case 11: { // 🐎 horse
      g.add(box(0.46, 0.26, 0.2, 0, 0.34, 0, main))
      g.add(box(0.14, 0.28, 0.14, 0.2, 0.52, 0, main, -0.4))
      g.add(box(0.22, 0.11, 0.11, 0.34, 0.62, 0, main))
      for (const [x, z] of [[0.16, 0.07], [0.16, -0.07], [-0.16, 0.07], [-0.16, -0.07]] as const) {
        g.add(cyl(0.045, 0.24, x, 0.12, z, dark))
      }
      break
    }
    case 12: { // 🐘 elephant
      g.add(sph(0.28, 0, 0.3, 0, main, 1.2, 1, 1))
      g.add(sph(0.19, 0.34, 0.32, 0, main))
      g.add(cyl(0.055, 0.26, 0.52, 0.22, 0, main, undefined, 0.55))
      g.add(box(0.04, 0.16, 0.16, 0.3, 0.4, 0.17, main, 0.2))
      g.add(box(0.04, 0.16, 0.16, 0.3, 0.4, -0.17, main, -0.2))
      g.add(cyl(0.06, 0.22, 0.14, 0.03, 0.1, dark))
      g.add(cyl(0.06, 0.22, 0.14, 0.03, -0.1, dark))
      g.add(cyl(0.06, 0.22, -0.2, 0.03, 0.1, dark))
      g.add(cyl(0.06, 0.22, -0.2, 0.03, -0.1, dark))
      break
    }
    case 13: { // 🚀 rocket
      g.add(cyl(0.15, 0.4, 0, 0.32, 0, main))
      g.add(cone(0.15, 0.24, 0, 0.64, 0, main))
      g.add(box(0.05, 0.2, 0.14, 0.17, 0.14, 0, main, 0.5))
      g.add(box(0.05, 0.2, 0.14, -0.17, 0.14, 0, main, -0.5))
      g.add(cyl(0.06, 0.12, 0, 0.08, 0, gold))
      break
    }
    case 14: { // ⭐ star
      const m = new THREE.Mesh(starMat4(), gold)
      m.position.y = 0.16
      g.add(m)
      break
    }
    case 15: { // 🍒 cherries
      g.add(sph(0.15, 0.13, 0.15, 0.04, main))
      g.add(sph(0.15, -0.13, 0.15, -0.04, main))
      g.add(cyl(0.02, 0.28, 0.07, 0.34, 0.04, dark, undefined, -0.35))
      g.add(cyl(0.02, 0.28, -0.07, 0.34, -0.04, dark, undefined, 0.35))
      g.add(box(0.16, 0.03, 0.08, 0.1, 0.48, 0, main, 0.3))
      break
    }
  }
  return g
}

// One-time offscreen render of each avatar — the picker grids show these
// instead of emoji, so what you tap is exactly what walks the board. The
// cache is per (model, colour): pickers use the gold default; in-game the
// thumbnail renders in the player's chosen colour, replacing the emoji
// beside every player's name.
//
// One shared offscreen renderer for all thumbnails: creating WebGL
// contexts per uncached call caused 20-60ms churn inside renderGame's
// innerHTML build (a one-time hitch on weak TV browsers, and rapid
// context create/destroy competes with the live Board3D context).
const thumbs = new Map<string, string>()
let thumbRig: {
  renderer: THREE.WebGLRenderer
  scene: THREE.Scene
  camera: THREE.PerspectiveCamera
} | null = null

function thumbRenderer(): { renderer: THREE.WebGLRenderer; scene: THREE.Scene; camera: THREE.PerspectiveCamera } {
  if (thumbRig) return thumbRig
  const renderer = new THREE.WebGLRenderer({ antialias: true, alpha: true, preserveDrawingBuffer: true })
  renderer.setPixelRatio(1)
  renderer.setSize(128, 128)
  const scene = new THREE.Scene()
  scene.add(new THREE.AmbientLight(0xffffff, 0.85))
  const dir = new THREE.DirectionalLight(0xffffff, 1.0)
  dir.position.set(3, 5, 2)
  scene.add(dir)
  const camera = new THREE.PerspectiveCamera(36, 1, 0.1, 50)
  camera.position.set(1.15, 1.05, 1.6)
  camera.lookAt(0, 0.28, 0)
  thumbRig = { renderer, scene, camera }
  return thumbRig
}

export function avatarThumbnail(idx: number, color = '#f59e0b'): string {
  const key = `${idx}|${color}`
  const cached = thumbs.get(key)
  if (cached) return cached
  const { renderer, scene, camera } = thumbRenderer()
  // one figurine at a time; removed after the shot so the rig is reusable
  const fig = createAvatar(idx, color)
  scene.add(fig)
  renderer.render(scene, camera)
  const url = renderer.domElement.toDataURL()
  scene.remove(fig)
  thumbs.set(key, url)
  return url
}

// A tiny rotating pedestal view of one avatar — the phone's piece picker.
export class AvatarPreview {
  private renderer: THREE.WebGLRenderer
  private scene = new THREE.Scene()
  private camera: THREE.PerspectiveCamera
  private current: THREE.Group | null = null
  private raf = 0
  private disposed = false

  constructor(container: HTMLElement) {
    const w = container.clientWidth || 200
    const h = container.clientHeight || 200
    this.renderer = new THREE.WebGLRenderer({ antialias: true, alpha: true })
    this.renderer.setPixelRatio(Math.min(window.devicePixelRatio, 2))
    this.renderer.setSize(w, h)
    this.renderer.domElement.style.width = '100%'
    this.renderer.domElement.style.height = '100%'
    container.appendChild(this.renderer.domElement)
    this.camera = new THREE.PerspectiveCamera(36, w / h, 0.1, 50)
    this.camera.position.set(1.35, 1.25, 1.9)
    this.camera.lookAt(0, 0.3, 0)
    this.scene.add(new THREE.AmbientLight(0xffffff, 0.75))
    const dir = new THREE.DirectionalLight(0xffffff, 1.1)
    dir.position.set(3, 5, 2)
    this.scene.add(dir)
    this.animate()
  }

  show(idx: number, color: string): void {
    if (this.current) this.scene.remove(this.current)
    this.current = createAvatar(idx, color)
    this.scene.add(this.current)
  }

  private animate = (): void => {
    if (this.disposed) return
    this.raf = requestAnimationFrame(this.animate)
    if (this.current) this.current.rotation.y += 0.018
    this.renderer.render(this.scene, this.camera)
  }

  dispose(): void {
    this.disposed = true
    cancelAnimationFrame(this.raf)
    this.renderer.dispose()
    this.renderer.domElement.remove()
  }
}
