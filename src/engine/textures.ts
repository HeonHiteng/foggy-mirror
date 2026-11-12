// Procedurally generated textures: fog haze, condensation, droplets, steam, bathroom backdrop.

export function makeCanvas(w: number, h: number): HTMLCanvasElement {
  const c = document.createElement('canvas')
  c.width = Math.max(1, Math.round(w))
  c.height = Math.max(1, Math.round(h))
  return c
}

function ctx2d(c: HTMLCanvasElement) {
  return c.getContext('2d')!
}

function mulberry32(seed: number) {
  return () => {
    seed |= 0
    seed = (seed + 0x6d2b79f5) | 0
    let t = Math.imul(seed ^ (seed >>> 15), 1 | seed)
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296
  }
}

/** Fractal value noise in [0,1] for a cw x ch grid. */
function fbm(cw: number, ch: number, seed: number, baseCells = 3, octaves = 5): Float32Array {
  const rnd = mulberry32(seed)
  const out = new Float32Array(cw * ch)
  let amp = 0.5
  let total = 0
  for (let o = 0; o < octaves; o++) {
    const cells = baseCells * 2 ** o
    const gx = cells + 1
    const gy = Math.ceil(cells * (ch / cw)) + 1
    const grid = new Float32Array((gx + 1) * (gy + 1))
    for (let i = 0; i < grid.length; i++) grid[i] = rnd()
    for (let y = 0; y < ch; y++) {
      const fy = (y / cw) * cells
      const iy = Math.floor(fy)
      let ty = fy - iy
      ty = ty * ty * (3 - 2 * ty)
      for (let x = 0; x < cw; x++) {
        const fx = (x / cw) * cells
        const ix = Math.floor(fx)
        let tx = fx - ix
        tx = tx * tx * (3 - 2 * tx)
        const a = grid[iy * (gx + 1) + ix]
        const b = grid[iy * (gx + 1) + ix + 1]
        const c = grid[(iy + 1) * (gx + 1) + ix]
        const d = grid[(iy + 1) * (gx + 1) + ix + 1]
        out[y * cw + x] += amp * (a + (b - a) * tx + (c - a) * ty + (a - b - c + d) * tx * ty)
      }
    }
    total += amp
    amp *= 0.5
  }
  for (let i = 0; i < out.length; i++) out[i] /= total
  return out
}

/** Soft white condensation haze, denser at the edges, lit warmly from the top. */
export function makeHaze(w: number, h: number): HTMLCanvasElement {
  const cw = Math.max(32, Math.round(w / 4))
  const ch = Math.max(32, Math.round(h / 4))
  const n = fbm(cw, ch, 1337, 3, 5)
  const n2 = fbm(cw, ch, 4242, 1, 3)
  const c = makeCanvas(cw, ch)
  const g = ctx2d(c)
  const img = g.createImageData(cw, ch)
  const d = img.data
  for (let y = 0; y < ch; y++) {
    const ny = y / ch
    for (let x = 0; x < cw; x++) {
      const nx = x / cw
      const i = y * cw + x
      const lt = Math.exp(-((nx - 0.5) ** 2 * 2.5 + (ny + 0.05) ** 2 * 3))
      const ex = Math.max(Math.abs(nx - 0.5) * 2, Math.abs(ny - 0.5) * 2)
      const edge = ex ** 3
      const v = n[i]
      const big = n2[i]
      let a = 0.5 + 0.34 * (v - 0.5) * 2 + 0.12 * (big - 0.5) * 2 + 0.16 * edge + 0.05 * ny
      a = Math.min(0.9, Math.max(0.32, a))
      const p = i * 4
      d[p] = 222 + 30 * lt
      d[p + 1] = 222 + 22 * lt
      d[p + 2] = 220 + 10 * lt
      d[p + 3] = a * 255
    }
  }
  g.putImageData(img, 0, 0)
  return c
}

/** A single water bead on glass: refractive dark body, bright specular, caustic crescent. */
export function makeDropSprite(size = 64): HTMLCanvasElement {
  const c = makeCanvas(size, size)
  const g = ctx2d(c)
  const r = size / 2
  // shadow / refraction body
  let grd = g.createRadialGradient(r, r * 1.08, r * 0.1, r, r, r)
  grd.addColorStop(0, 'rgba(30,24,20,0.05)')
  grd.addColorStop(0.62, 'rgba(25,20,18,0.16)')
  grd.addColorStop(0.86, 'rgba(15,12,10,0.42)')
  grd.addColorStop(0.97, 'rgba(255,255,255,0.18)')
  grd.addColorStop(1, 'rgba(255,255,255,0)')
  g.fillStyle = grd
  g.beginPath()
  g.arc(r, r, r, 0, Math.PI * 2)
  g.fill()
  // bottom caustic crescent
  grd = g.createRadialGradient(r, r * 1.45, r * 0.05, r, r * 1.35, r * 0.62)
  grd.addColorStop(0, 'rgba(255,246,230,0.55)')
  grd.addColorStop(1, 'rgba(255,246,230,0)')
  g.fillStyle = grd
  g.beginPath()
  g.arc(r, r, r * 0.9, 0, Math.PI * 2)
  g.fill()
  // specular highlight
  grd = g.createRadialGradient(r * 0.68, r * 0.6, 0, r * 0.68, r * 0.6, r * 0.32)
  grd.addColorStop(0, 'rgba(255,255,255,0.98)')
  grd.addColorStop(0.45, 'rgba(255,255,255,0.55)')
  grd.addColorStop(1, 'rgba(255,255,255,0)')
  g.fillStyle = grd
  g.beginPath()
  g.arc(r * 0.68, r * 0.6, r * 0.32, 0, Math.PI * 2)
  g.fill()
  return c
}

/** Repeating tile of micro condensation beads. */
export function makeCondensationTile(size: number, drop: HTMLCanvasElement): HTMLCanvasElement {
  const c = makeCanvas(size, size)
  const g = ctx2d(c)
  const rnd = mulberry32(99)
  const s = size / 384
  const count = 3200 // tile covers 384x384 css px regardless of dpr
  for (let i = 0; i < count; i++) {
    const x = rnd() * size
    const y = rnd() * size
    const r = (0.35 + rnd() ** 2.2 * 1.5) * s
    g.fillStyle = `rgba(20,16,14,${0.05 + rnd() * 0.08})`
    g.beginPath()
    g.arc(x + 0.35 * s, y + 0.5 * s, r, 0, Math.PI * 2)
    g.fill()
    g.fillStyle = `rgba(255,255,255,${0.22 + rnd() * 0.35})`
    g.beginPath()
    g.arc(x, y, r * 0.85, 0, Math.PI * 2)
    g.fill()
  }
  // a few bigger beads, drawn so they wrap seamlessly
  for (let i = 0; i < 70; i++) {
    const r = (1.6 + rnd() ** 2 * 3.4) * s
    const x = rnd() * size
    const y = rnd() * size
    g.globalAlpha = 0.45 + rnd() * 0.35
    for (const ox of [-size, 0, size])
      for (const oy of [-size, 0, size]) g.drawImage(drop, x + ox - r, y + oy - r, r * 2, r * 2)
  }
  g.globalAlpha = 1
  return c
}

export function makeSoftSprite(size: number, color: string, stops: [number, number][]): HTMLCanvasElement {
  const c = makeCanvas(size, size)
  const g = ctx2d(c)
  const r = size / 2
  const grd = g.createRadialGradient(r, r, 0, r, r, r)
  for (const [o, a] of stops) grd.addColorStop(o, `rgba(${color},${a})`)
  g.fillStyle = grd
  g.fillRect(0, 0, size, size)
  return c
}

function roundRect(g: CanvasRenderingContext2D, x: number, y: number, w: number, h: number, r: number) {
  g.beginPath()
  g.roundRect(x, y, w, h, r)
}

/** Warm, softly lit bathroom shown in the mirror when the camera is off. */
export function makeBathroom(w: number, h: number, dpr: number): HTMLCanvasElement {
  const c = makeCanvas(w * dpr, h * dpr)
  const g = ctx2d(c)
  g.scale(dpr, dpr)
  const rnd = mulberry32(7)

  // back wall
  let grd = g.createLinearGradient(0, 0, 0, h)
  grd.addColorStop(0, '#a48c74')
  grd.addColorStop(0.55, '#7d6957')
  grd.addColorStop(1, '#3d3128')
  g.fillStyle = grd
  g.fillRect(0, 0, w, h)

  // tiles (large format, staggered)
  const tw = Math.max(70, Math.min(w, h) * 0.16)
  const th = tw * 0.5
  const tileTop = h * 0.32
  for (let row = 0, y = tileTop; y < h; row++, y += th) {
    const off = row % 2 ? tw / 2 : 0
    for (let x = -tw + off; x < w; x += tw) {
      const shade = 0.9 + rnd() * 0.1
      const tg = g.createLinearGradient(x, y, x + tw, y + th)
      tg.addColorStop(0, `rgba(${235 * shade},${226 * shade},${212 * shade},0.95)`)
      tg.addColorStop(1, `rgba(${200 * shade},${188 * shade},${172 * shade},0.95)`)
      g.fillStyle = tg
      roundRect(g, x + 1.5, y + 1.5, tw - 3, th - 3, 3)
      g.fill()
    }
  }
  // darken tiles with depth
  grd = g.createLinearGradient(0, tileTop, 0, h)
  grd.addColorStop(0, 'rgba(60,40,25,0.15)')
  grd.addColorStop(1, 'rgba(25,15,8,0.7)')
  g.fillStyle = grd
  g.fillRect(0, tileTop, w, h - tileTop)

  // tile trim line
  g.fillStyle = 'rgba(255,240,220,0.35)'
  g.fillRect(0, tileTop - 4, w, 3)

  // shower door frame / glass panel on the left
  const gx = w * 0.06
  g.fillStyle = 'rgba(255,255,255,0.06)'
  g.fillRect(gx, h * 0.05, w * 0.22, h)
  g.fillStyle = 'rgba(40,30,22,0.5)'
  g.fillRect(gx + w * 0.22, h * 0.05, 5, h)
  g.fillStyle = 'rgba(255,230,200,0.35)'
  g.fillRect(gx + w * 0.22 - 2, h * 0.05, 2, h)

  // towel rail and towel on the right
  const tx = w * 0.7
  const ty = h * 0.46
  const towW = Math.min(w * 0.18, 260)
  g.fillStyle = 'rgba(210,190,160,0.9)'
  g.fillRect(tx - 12, ty - 6, towW + 24, 5)
  grd = g.createLinearGradient(tx, 0, tx + towW, 0)
  grd.addColorStop(0, '#6f7d6a')
  grd.addColorStop(0.5, '#93a08b')
  grd.addColorStop(1, '#5d6a58')
  g.fillStyle = grd
  roundRect(g, tx, ty - 2, towW, h * 0.32, 10)
  g.fill()
  g.fillStyle = 'rgba(255,255,255,0.12)'
  for (let i = 0; i < 6; i++) g.fillRect(tx + 6, ty + h * 0.26 + i * 4, towW - 12, 1)

  // shelf with bottles
  const sy = h * 0.62
  g.fillStyle = 'rgba(50,35,25,0.85)'
  g.fillRect(w * 0.36, sy, w * 0.22, 8)
  const bottles = [
    ['#d9c7a8', 0.035, 0.09],
    ['#8a6e57', 0.028, 0.12],
    ['#e9e1d3', 0.04, 0.07],
    ['#b48a64', 0.025, 0.1],
  ] as const
  let bx = w * 0.38
  for (const [col, bw, bh] of bottles) {
    const ww = w * bw
    const hh = h * bh
    g.fillStyle = col
    roundRect(g, bx, sy - hh, ww, hh, 5)
    g.fill()
    g.fillStyle = 'rgba(255,255,255,0.25)'
    g.fillRect(bx + ww * 0.18, sy - hh + 6, 3, hh - 12)
    bx += ww + w * 0.012
  }

  // plant leaves silhouette
  g.save()
  g.translate(w * 0.9, h * 0.75)
  g.fillStyle = 'rgba(40,60,35,0.75)'
  for (let i = 0; i < 9; i++) {
    g.rotate(-0.45 + rnd() * 0.25)
    g.beginPath()
    g.ellipse(0, -h * 0.09, w * 0.012, h * 0.1, 0, 0, Math.PI * 2)
    g.fill()
  }
  g.restore()

  // warm sconce light
  grd = g.createRadialGradient(w * 0.5, -h * 0.05, 0, w * 0.5, -h * 0.05, Math.max(w, h) * 0.75)
  grd.addColorStop(0, 'rgba(255,214,160,0.75)')
  grd.addColorStop(0.35, 'rgba(255,190,130,0.25)')
  grd.addColorStop(1, 'rgba(255,170,110,0)')
  g.fillStyle = grd
  g.fillRect(0, 0, w, h)
  // a mirror reflection reads darker and richer than the bright fog in front of it
  g.globalCompositeOperation = 'multiply'
  g.fillStyle = 'rgb(150,128,110)'
  g.fillRect(0, 0, w, h)
  g.globalCompositeOperation = 'source-over'
  return c
}

/** Warm vanity glow (screen) + vignette (source-over) overlays. */
export function makeLighting(w: number, h: number, dpr: number) {
  const glow = makeCanvas(w * dpr, h * dpr)
  let g = ctx2d(glow)
  g.scale(dpr, dpr)
  let grd = g.createRadialGradient(w * 0.5, -h * 0.12, 0, w * 0.5, -h * 0.12, Math.max(w, h) * 0.85)
  grd.addColorStop(0, 'rgba(255,200,140,0.42)')
  grd.addColorStop(0.4, 'rgba(255,170,100,0.14)')
  grd.addColorStop(1, 'rgba(255,150,80,0)')
  g.fillStyle = grd
  g.fillRect(0, 0, w, h)

  const vig = makeCanvas(w * dpr, h * dpr)
  g = ctx2d(vig)
  g.scale(dpr, dpr)
  const diag = Math.hypot(w, h) / 2
  grd = g.createRadialGradient(w / 2, h * 0.45, diag * 0.45, w / 2, h * 0.45, diag * 1.05)
  grd.addColorStop(0, 'rgba(12,7,3,0)')
  grd.addColorStop(1, 'rgba(12,7,3,0.62)')
  g.fillStyle = grd
  g.fillRect(0, 0, w, h)
  // glass bevel
  const inset = 6
  g.lineWidth = 1.5
  const bevel = g.createLinearGradient(0, 0, w, h)
  bevel.addColorStop(0, 'rgba(255,240,220,0.35)')
  bevel.addColorStop(0.5, 'rgba(255,240,220,0.08)')
  bevel.addColorStop(1, 'rgba(255,240,220,0.25)')
  g.strokeStyle = bevel
  roundRect(g, inset, inset, w - inset * 2, h - inset * 2, 14)
  g.stroke()
  return { glow, vig }
}
