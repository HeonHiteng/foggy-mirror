import { COMPOSITE_FS, COPY_FS, FULLSCREEN_VS, LIP_FS, SIM_FS, WIPE_FS, WIPE_VS } from './shaders'
import { makeBathroom } from './textures'

type Pt = { x: number; y: number }
type Uniforms = Record<string, WebGLUniformLocation | null>

const nowS = () => performance.now() / 1000
const MAX_DPR = 1.5
const MAX_PIXELS = 2.4e6

function compile(gl: WebGL2RenderingContext, type: number, src: string) {
  const s = gl.createShader(type)!
  gl.shaderSource(s, src)
  gl.compileShader(s)
  if (!gl.getShaderParameter(s, gl.COMPILE_STATUS)) throw new Error(gl.getShaderInfoLog(s) ?? 'shader error')
  return s
}

function program(gl: WebGL2RenderingContext, vs: string, fs: string, names: string[]) {
  const p = gl.createProgram()!
  gl.attachShader(p, compile(gl, gl.VERTEX_SHADER, vs))
  gl.attachShader(p, compile(gl, gl.FRAGMENT_SHADER, fs))
  gl.bindAttribLocation(p, 0, 'aPos')
  gl.bindAttribLocation(p, 1, 'aSeg')
  gl.linkProgram(p)
  if (!gl.getProgramParameter(p, gl.LINK_STATUS)) throw new Error(gl.getProgramInfoLog(p) ?? 'link error')
  const u: Uniforms = {}
  for (const n of names) u[n] = gl.getUniformLocation(p, n)
  return { p, u }
}

/**
 * WebGL2 foggy mirror.
 * A full-resolution half-float "state" texture holds condensation density (R) and wet-rim dryness (G).
 * Each frame: simulate (evaporate + breath) -> rasterise finger wipes with MIN blending -> composite with the webcam.
 */
export class MirrorGL {
  readonly canvas: HTMLCanvasElement
  private gl: WebGL2RenderingContext
  private sim
  private wipe
  private comp
  private copy
  private lip
  private triVao: WebGLVertexArrayObject
  private wipeVao: WebGLVertexArrayObject
  private wipeBuf: WebGLBuffer
  private wipeData = new Float32Array(6 * 6 * 512)
  private state: { tex: WebGLTexture; fbo: WebGLFramebuffer }[] = []
  private cur = 0
  private floatState = false
  private videoTex: WebGLTexture
  private fallbackTex: WebGLTexture | null = null

  private w = 1
  private h = 1
  private dpr = 1
  private bw = 1 // device pixel size
  private bh = 1

  private video: HTMLVideoElement | null = null
  private lastVideoTime = -1
  private vrect = { dx: 0, dy: 0, dw: 1, dh: 1 }

  // strokes
  private segs: number[] = []
  private pts: Pt[] = []
  private lastEmit: Pt | null = null
  writing = false
  private writingSource: 'hand' | 'pointer' | null = null
  private pointerId: number | null = null

  // breath
  private breathOpen = false
  private breathT = 0
  private breathAmt = 0
  private breathSeed = 0
  private mouth: Pt | null = null
  private keyBreath = false
  private keyWasDown = false

  // kisses: a short warm puff of fog, then a lip print pressed into it, optionally a heart around it
  private puffs: { x: number; y: number; r: number; start: number; end: number; seed: number }[] = []
  private lips: { x: number; y: number; size: number; angle: number; at: number; seed: number }[] = []
  private lastLip: { x: number; y: number; size: number; angle: number; at: number; seed: number } | null = null
  private hearts: { pts: Pt[]; start: number; dur: number; emitted: number }[] = []

  // effects
  private fill = 0
  private clearLeft = 0
  private decayAcc = 0
  private startT = nowS()
  private lastT = nowS()
  private rawDt = 0

  private cursor = { x: 0, y: 0, rx: 0, ry: 0, a: 0, visible: false, drawing: false, source: 'pointer' as 'hand' | 'pointer' }
  private hideCursor = false
  private raf = 0

  onBeforeFrame: ((tMs: number) => void) | null = null
  onBreathStart: (() => void) | null = null
  onStroke: (() => void) | null = null
  onKiss: (() => void) | null = null

  constructor(canvas: HTMLCanvasElement) {
    this.canvas = canvas
    const gl = canvas.getContext('webgl2', { antialias: false, alpha: false, premultipliedAlpha: false, preserveDrawingBuffer: false })
    if (!gl) throw new Error('WebGL2 is not supported in this browser')
    this.gl = gl
    this.floatState = !!(gl.getExtension('EXT_color_buffer_float') || gl.getExtension('EXT_color_buffer_half_float'))

    this.sim = program(gl, FULLSCREEN_VS, SIM_FS, ['uState', 'uRes', 'uDt', 'uDecayDt', 'uTime', 'uMouth', 'uBreath', 'uSeed', 'uFill', 'uClear'])
    this.wipe = program(gl, WIPE_VS, WIPE_FS, ['uRes', 'uHalfW', 'uDpr', 'uCanvasH'])
    this.comp = program(gl, FULLSCREEN_VS, COMPOSITE_FS, [
      'uState', 'uVideo', 'uRes', 'uStateTexel', 'uTime', 'uVRect', 'uMirror', 'uHalfW', 'uCursor', 'uCursorDraw', 'uReveal',
    ])
    this.copy = program(gl, FULLSCREEN_VS, COPY_FS, ['uTex'])
    this.lip = program(gl, FULLSCREEN_VS, LIP_FS, ['uCenter', 'uSize', 'uAngle', 'uSeed', 'uDpr', 'uCanvasH'])

    this.triVao = gl.createVertexArray()!
    gl.bindVertexArray(this.triVao)
    const tri = gl.createBuffer()
    gl.bindBuffer(gl.ARRAY_BUFFER, tri)
    gl.bufferData(gl.ARRAY_BUFFER, new Float32Array([-1, -1, 3, -1, -1, 3]), gl.STATIC_DRAW)
    gl.enableVertexAttribArray(0)
    gl.vertexAttribPointer(0, 2, gl.FLOAT, false, 0, 0)

    this.wipeVao = gl.createVertexArray()!
    gl.bindVertexArray(this.wipeVao)
    this.wipeBuf = gl.createBuffer()!
    gl.bindBuffer(gl.ARRAY_BUFFER, this.wipeBuf)
    gl.bufferData(gl.ARRAY_BUFFER, this.wipeData.byteLength, gl.DYNAMIC_DRAW)
    gl.enableVertexAttribArray(0)
    gl.vertexAttribPointer(0, 2, gl.FLOAT, false, 24, 0)
    gl.enableVertexAttribArray(1)
    gl.vertexAttribPointer(1, 4, gl.FLOAT, false, 24, 8)
    gl.bindVertexArray(null)

    this.videoTex = this.makeVideoTex()
    this.resize()

    window.addEventListener('resize', this.resize)
    window.addEventListener('keydown', this.onKey)
    window.addEventListener('keyup', this.onKey)
    canvas.addEventListener('pointerdown', this.onPointerDown)
    canvas.addEventListener('pointermove', this.onPointerMove)
    canvas.addEventListener('pointerup', this.onPointerUp)
    canvas.addEventListener('pointercancel', this.onPointerUp)
    canvas.addEventListener('pointerleave', this.onPointerLeave)
    this.raf = requestAnimationFrame(this.frame)
  }

  destroy() {
    cancelAnimationFrame(this.raf)
    window.removeEventListener('resize', this.resize)
    window.removeEventListener('keydown', this.onKey)
    window.removeEventListener('keyup', this.onKey)
    const c = this.canvas
    c.removeEventListener('pointerdown', this.onPointerDown)
    c.removeEventListener('pointermove', this.onPointerMove)
    c.removeEventListener('pointerup', this.onPointerUp)
    c.removeEventListener('pointercancel', this.onPointerUp)
    c.removeEventListener('pointerleave', this.onPointerLeave)
    this.gl.getExtension('WEBGL_lose_context')?.loseContext()
  }

  // ---------------- resources ----------------

  private makeVideoTex() {
    const gl = this.gl
    const t = gl.createTexture()!
    gl.bindTexture(gl.TEXTURE_2D, t)
    gl.texImage2D(gl.TEXTURE_2D, 0, gl.RGBA, 1, 1, 0, gl.RGBA, gl.UNSIGNED_BYTE, new Uint8Array([40, 34, 30, 255]))
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MIN_FILTER, gl.LINEAR_MIPMAP_LINEAR)
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MAG_FILTER, gl.LINEAR)
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_S, gl.CLAMP_TO_EDGE)
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_T, gl.CLAMP_TO_EDGE)
    gl.generateMipmap(gl.TEXTURE_2D)
    return t
  }

  private makeState(bw: number, bh: number): { tex: WebGLTexture; fbo: WebGLFramebuffer } {
    const gl = this.gl
    const tex = gl.createTexture()!
    gl.bindTexture(gl.TEXTURE_2D, tex)
    if (this.floatState) gl.texImage2D(gl.TEXTURE_2D, 0, gl.RGBA16F, bw, bh, 0, gl.RGBA, gl.HALF_FLOAT, null)
    else gl.texImage2D(gl.TEXTURE_2D, 0, gl.RGBA8, bw, bh, 0, gl.RGBA, gl.UNSIGNED_BYTE, null)
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MIN_FILTER, gl.LINEAR)
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MAG_FILTER, gl.LINEAR)
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_S, gl.CLAMP_TO_EDGE)
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_T, gl.CLAMP_TO_EDGE)
    const fbo = gl.createFramebuffer()!
    gl.bindFramebuffer(gl.FRAMEBUFFER, fbo)
    gl.framebufferTexture2D(gl.FRAMEBUFFER, gl.COLOR_ATTACHMENT0, gl.TEXTURE_2D, tex, 0)
    if (this.floatState && gl.checkFramebufferStatus(gl.FRAMEBUFFER) !== gl.FRAMEBUFFER_COMPLETE) {
      this.floatState = false
      gl.deleteFramebuffer(fbo)
      gl.deleteTexture(tex)
      return this.makeState(bw, bh)
    }
    gl.clearColor(0, 1, 0, 1) // no fog, fully dry
    gl.clear(gl.COLOR_BUFFER_BIT)
    return { tex, fbo }
  }

  private resize = () => {
    const gl = this.gl
    const w = window.innerWidth
    const h = window.innerHeight
    let dpr = Math.min(window.devicePixelRatio || 1, MAX_DPR)
    if (w * h * dpr * dpr > MAX_PIXELS) dpr = Math.sqrt(MAX_PIXELS / (w * h))
    const bw = Math.max(1, Math.round(w * dpr))
    const bh = Math.max(1, Math.round(h * dpr))
    this.w = w
    this.h = h
    this.dpr = dpr
    this.canvas.width = bw
    this.canvas.height = bh
    this.canvas.style.width = w + 'px'
    this.canvas.style.height = h + 'px'

    // carry existing fog across the resize
    const old = this.state[this.cur]
    const next = [this.makeState(bw, bh), this.makeState(bw, bh)]
    if (old) {
      gl.bindFramebuffer(gl.FRAMEBUFFER, next[0].fbo)
      gl.viewport(0, 0, bw, bh)
      gl.useProgram(this.copy.p)
      gl.activeTexture(gl.TEXTURE0)
      gl.bindTexture(gl.TEXTURE_2D, old.tex)
      gl.uniform1i(this.copy.u.uTex, 0)
      gl.bindVertexArray(this.triVao)
      gl.drawArrays(gl.TRIANGLES, 0, 3)
      for (const s of this.state) {
        gl.deleteTexture(s.tex)
        gl.deleteFramebuffer(s.fbo)
      }
    }
    this.state = next
    this.cur = 0
    this.bw = bw
    this.bh = bh
    if (!this.video) this.useFallback()
  }

  private useFallback() {
    const gl = this.gl
    const c = makeBathroom(this.w, this.h, 1)
    if (!this.fallbackTex) this.fallbackTex = this.makeVideoTex()
    gl.bindTexture(gl.TEXTURE_2D, this.fallbackTex)
    gl.texImage2D(gl.TEXTURE_2D, 0, gl.RGBA, gl.RGBA, gl.UNSIGNED_BYTE, c)
    gl.generateMipmap(gl.TEXTURE_2D)
    this.vrect = { dx: 0, dy: 0, dw: this.w, dh: this.h }
  }

  get halfWidth() {
    return Math.max(5, Math.min(9.5, Math.min(this.w, this.h) * 0.0085))
  }

  // ---------------- public API ----------------

  setVideo(v: HTMLVideoElement | null) {
    this.video = v
    this.lastVideoTime = -1
    if (!v) this.useFallback()
  }

  /** Normalized camera coords (un-mirrored) -> screen css px, matching the drawn reflection exactly. */
  mapVideoPoint(nx: number, ny: number): Pt {
    const { dx, dy, dw, dh } = this.vrect
    return { x: dx + (1 - nx) * dw, y: dy + ny * dh }
  }

  /** Add uniform fog over the whole mirror (used when there is no camera to breathe with). */
  fogAll(amount = 1) {
    this.fill += amount
  }

  /** Wipe the whole mirror clear over ~1s. */
  clear() {
    this.clearLeft = 1.6 // density units to evaporate, spread over ~0.7s
  }

  setBreath(open: boolean, openness: number, mouth: Pt | null) {
    if (open && mouth) {
      if (!this.breathOpen) {
        this.breathT = 0
        this.breathSeed = Math.random() * 100
        this.onBreathStart?.()
      }
      this.mouth = this.mouth ? { x: this.mouth.x + (mouth.x - this.mouth.x) * 0.3, y: this.mouth.y + (mouth.y - this.mouth.y) * 0.3 } : mouth
      this.breathAmt = openness
    } else {
      this.breathAmt = 0
      if (!mouth) this.mouth = null
    }
    this.breathOpen = open && !!mouth
  }

  /**
   * A kiss on the glass: warm breath fogs a small patch, then the lips press a print into it.
   * size = half the mouth width in css px, angle = head roll.
   */
  kiss(at: Pt, size: number, angle = 0) {
    const t = nowS()
    this.puffs.push({ x: at.x, y: at.y, r: size * 3.2, start: t, end: t + 0.55, seed: Math.random() * 100 })
    const lip = { x: at.x, y: at.y, size, angle, at: t + 0.5, seed: Math.random() * 50 }
    this.lips.push(lip)
    this.lastLip = lip
    this.onKiss?.()
  }

  /** A heart wiped through the fog around a kiss (fogs the area first so it always shows). */
  kissHeart(at: Pt, size: number, angle = 0) {
    const t = nowS()
    const w = size * 4.2 // heart width
    const cy = at.y - size * 0.15
    this.puffs.push({ x: at.x, y: cy, r: w * 1.05, start: t, end: t + 0.6, seed: Math.random() * 100 })
    const pts: Pt[] = []
    const sc = w / 32
    const ca = Math.cos(angle)
    const sa = Math.sin(angle)
    for (let i = 0; i <= 120; i++) {
      const a = (i / 120) * Math.PI * 2
      const hx = 16 * Math.sin(a) ** 3 * sc
      const hy = -(13 * Math.cos(a) - 5 * Math.cos(2 * a) - 2 * Math.cos(3 * a) - Math.cos(4 * a) - 2.5) * sc
      pts.push({ x: at.x + hx * ca - hy * sa, y: cy + hx * sa + hy * ca })
    }
    this.hearts.push({ pts, start: t + 0.6, dur: 0.9, emitted: 0 })
    // the heart's fog puff would cover a fresh lip print: press the same print again once it settles
    const l = this.lastLip
    if (l && t - l.at < 4 && Math.hypot(l.x - at.x, l.y - at.y) < size * 2) this.lips.push({ ...l, at: t + 0.65 })
  }

  /** One processed hand frame: fingertip (screen px) and whether writing is active. */
  setHand(tip: Pt | null, writing: boolean) {
    if (this.pointerId !== null) return
    if (!tip) {
      if (this.writingSource === 'hand') this.endStroke()
      if (this.cursor.source === 'hand') this.cursor.visible = false
      return
    }
    this.setCursor(tip.x, tip.y, 'hand', writing)
    if (writing) {
      if (this.writingSource !== 'hand') this.beginStroke(tip, 'hand')
      else this.addPoint(tip)
    } else if (this.writingSource === 'hand') this.endStroke()
  }

  save(): Promise<Blob | null> {
    this.hideCursor = true
    this.render(nowS(), 0)
    return new Promise((res) => {
      this.canvas.toBlob((b) => res(b), 'image/png')
      this.hideCursor = false
    })
  }

  // ---------------- strokes ----------------

  private beginStroke(p: Pt, source: 'hand' | 'pointer') {
    this.endStroke()
    this.writing = true
    this.writingSource = source
    this.pts = [p]
    this.lastEmit = p
    this.pushSeg(p, p)
    this.onStroke?.()
  }

  /** Midpoint-quadratic smoothing: curves through the incoming points with only half a sample of lag. */
  private addPoint(p: Pt) {
    const pts = this.pts
    const last = pts[pts.length - 1]
    if (Math.hypot(p.x - last.x, p.y - last.y) < 0.6) return
    pts.push(p)
    if (pts.length > 4) pts.shift()
    const n = pts.length
    const ctrl = pts[n - 2]
    const end = { x: (ctrl.x + p.x) / 2, y: (ctrl.y + p.y) / 2 }
    const start = this.lastEmit!
    const len = Math.hypot(ctrl.x - start.x, ctrl.y - start.y) + Math.hypot(end.x - ctrl.x, end.y - ctrl.y)
    const k = Math.max(1, Math.ceil(len / 3))
    let prev = start
    for (let i = 1; i <= k; i++) {
      const t = i / k
      const a = (1 - t) * (1 - t)
      const b = 2 * (1 - t) * t
      const c = t * t
      const q = { x: a * start.x + b * ctrl.x + c * end.x, y: a * start.y + b * ctrl.y + c * end.y }
      this.pushSeg(prev, q)
      prev = q
    }
    this.lastEmit = end
  }

  private endStroke() {
    if (!this.writing) return
    const last = this.pts[this.pts.length - 1]
    if (this.lastEmit && last) this.pushSeg(this.lastEmit, last)
    this.writing = false
    this.writingSource = null
    this.pts = []
    this.lastEmit = null
  }

  private pushSeg(a: Pt, b: Pt) {
    this.segs.push(a.x, a.y, b.x, b.y)
  }

  // ---------------- input ----------------

  private onKey = (e: KeyboardEvent) => {
    if (e.type === 'keydown' && !e.repeat && (e.code === 'KeyK' || e.code === 'KeyH')) {
      const at = this.cursor.visible ? { x: this.cursor.x, y: this.cursor.y } : { x: this.w / 2, y: this.h * 0.55 }
      const size = Math.min(this.w, this.h) * 0.07
      if (e.code === 'KeyK') this.kiss(at, size)
      else this.kissHeart(at, size)
    }
    if (e.code === 'Space') {
      e.preventDefault()
      this.keyBreath = e.type === 'keydown'
    }
  }

  private onPointerDown = (e: PointerEvent) => {
    if (this.pointerId !== null) return
    this.pointerId = e.pointerId
    this.canvas.setPointerCapture(e.pointerId)
    this.setCursor(e.clientX, e.clientY, 'pointer', true)
    this.beginStroke({ x: e.clientX, y: e.clientY }, 'pointer')
  }

  private onPointerMove = (e: PointerEvent) => {
    if (e.pointerId === this.pointerId) {
      this.setCursor(e.clientX, e.clientY, 'pointer', true)
      const evs = e.getCoalescedEvents?.() ?? [e]
      for (const ce of evs) this.addPoint({ x: ce.clientX, y: ce.clientY })
    } else if (e.pointerType === 'mouse' && !(this.cursor.source === 'hand' && this.cursor.visible)) {
      this.setCursor(e.clientX, e.clientY, 'pointer', false)
    }
  }

  private onPointerUp = (e: PointerEvent) => {
    if (e.pointerId !== this.pointerId) return
    this.pointerId = null
    if (this.writingSource === 'pointer') this.endStroke()
    this.cursor.drawing = false
    if (e.pointerType !== 'mouse') this.cursor.visible = false
  }

  private onPointerLeave = (e: PointerEvent) => {
    if (e.pointerType === 'mouse' && this.cursor.source === 'pointer' && this.pointerId === null) this.cursor.visible = false
  }

  private setCursor(x: number, y: number, source: 'hand' | 'pointer', drawing: boolean) {
    const c = this.cursor
    if (!c.visible || c.source !== source) {
      c.rx = x
      c.ry = y
    }
    c.x = x
    c.y = y
    c.source = source
    c.visible = true
    c.drawing = drawing
  }

  // ---------------- frame ----------------

  private frame = (tMs: number) => {
    this.raf = requestAnimationFrame(this.frame)
    const t = nowS()
    const rawDt = t - this.lastT
    const dt = Math.min(0.1, rawDt)
    this.lastT = t
    this.rawDt = rawDt
    try {
      this.onBeforeFrame?.(tMs)
    } catch (err) {
      console.error(err)
    }
    this.uploadVideo()
    this.simulate(t, dt)
    this.emitHearts(t)
    this.applyWipes()
    this.applyLips(t)
    this.render(t, dt)
  }

  private uploadVideo() {
    const v = this.video
    if (!v || v.readyState < 2 || !v.videoWidth) return
    const gl = this.gl
    const s = Math.max(this.w / v.videoWidth, this.h / v.videoHeight)
    const dw = v.videoWidth * s
    const dh = v.videoHeight * s
    this.vrect = { dx: (this.w - dw) / 2, dy: (this.h - dh) / 2, dw, dh }
    if (v.currentTime === this.lastVideoTime) return
    this.lastVideoTime = v.currentTime
    gl.bindTexture(gl.TEXTURE_2D, this.videoTex)
    gl.texImage2D(gl.TEXTURE_2D, 0, gl.RGBA, gl.RGBA, gl.UNSIGNED_BYTE, v)
    gl.generateMipmap(gl.TEXTURE_2D)
  }

  private simulate(t: number, dt: number) {
    const gl = this.gl
    // breath: radius grows with how long the mouth has been open
    let breath = 0
    let mouth = this.mouth
    let open = this.breathOpen
    let amt = this.breathAmt
    if (this.keyBreath) {
      // keyboard fallback: hold Space to breathe at the cursor (or the centre)
      mouth = this.cursor.visible ? { x: this.cursor.x, y: this.cursor.y } : { x: this.w / 2, y: this.h * 0.55 }
      if (!this.keyWasDown) {
        this.breathT = 0
        this.breathSeed = Math.random() * 100
        this.onBreathStart?.()
      }
      open = true
      amt = 1
    }
    this.keyWasDown = this.keyBreath
    if (open && mouth) {
      this.breathT += dt
      breath = amt * Math.min(1, this.breathT / 0.25) // soft onset
    }
    const minDim = Math.min(this.w, this.h)
    const maxDim = Math.max(this.w, this.h)
    const r0 = minDim * 0.09
    let radius = Math.min(maxDim * 0.85, r0 + ((maxDim * 0.55 - r0) / Math.sqrt(7)) * Math.sqrt(this.breathT))
    let seed = this.breathSeed + this.breathT * 0.04

    // a kiss puff takes over the breath channel briefly: dense, compact fog where the lips meet the glass
    this.puffs = this.puffs.filter((pf) => t < pf.end)
    const puff = this.puffs[this.puffs.length - 1]
    if (puff && t >= puff.start) {
      mouth = { x: puff.x, y: puff.y }
      radius = puff.r
      breath = 2.6
      seed = puff.seed
    }

    // evaporation step; on 8-bit state, batch until the step is representable
    let decayDt = dt
    if (!this.floatState) {
      this.decayAcc += dt
      if (this.decayAcc >= 0.5) {
        decayDt = this.decayAcc
        this.decayAcc = 0
      } else decayDt = 0
    }

    const src = this.state[this.cur]
    const dst = this.state[1 - this.cur]
    gl.bindFramebuffer(gl.FRAMEBUFFER, dst.fbo)
    gl.viewport(0, 0, this.bw, this.bh)
    gl.disable(gl.BLEND)
    gl.useProgram(this.sim.p)
    const u = this.sim.u
    gl.activeTexture(gl.TEXTURE0)
    gl.bindTexture(gl.TEXTURE_2D, src.tex)
    gl.uniform1i(u.uState, 0)
    gl.uniform2f(u.uRes, this.w, this.h)
    gl.uniform1f(u.uDt, dt)
    gl.uniform1f(u.uDecayDt, decayDt)
    gl.uniform1f(u.uTime, t - this.startT)
    gl.uniform3f(u.uMouth, mouth?.x ?? 0, mouth?.y ?? 0, radius)
    gl.uniform1f(u.uBreath, breath * 1.15)
    gl.uniform1f(u.uSeed, seed)
    gl.uniform1f(u.uFill, this.fill)
    // clear is consumed by real elapsed time, so it completes even if frames are slow
    const clearStep = Math.min(this.clearLeft, Math.max(this.rawDt, 0.001) * 2.4)
    this.clearLeft -= clearStep
    gl.uniform1f(u.uClear, dt > 0 ? clearStep / dt : 0)
    this.fill = 0
    gl.bindVertexArray(this.triVao)
    gl.drawArrays(gl.TRIANGLES, 0, 3)
    this.cur = 1 - this.cur
  }

  private emitHearts(t: number) {
    for (const h of this.hearts) {
      const k = Math.min(1, Math.max(0, (t - h.start) / h.dur))
      const want = Math.ceil((k < 0.5 ? 2 * k * k : 1 - (-2 * k + 2) ** 2 / 2) * (h.pts.length - 1))
      for (let i = h.emitted; i < want; i++) this.pushSeg(h.pts[i], h.pts[i + 1])
      h.emitted = Math.max(h.emitted, want)
    }
    this.hearts = this.hearts.filter((h) => h.emitted < h.pts.length - 1)
  }

  private applyLips(t: number) {
    const due = this.lips.filter((l) => t >= l.at)
    if (!due.length) return
    this.lips = this.lips.filter((l) => t < l.at)
    const gl = this.gl
    gl.bindFramebuffer(gl.FRAMEBUFFER, this.state[this.cur].fbo)
    gl.viewport(0, 0, this.bw, this.bh)
    gl.enable(gl.BLEND)
    gl.blendEquation(gl.MIN)
    gl.useProgram(this.lip.p)
    const u = this.lip.u
    gl.uniform1f(u.uDpr, this.dpr)
    gl.uniform1f(u.uCanvasH, this.bh)
    gl.bindVertexArray(this.triVao)
    for (const l of due) {
      gl.uniform2f(u.uCenter, l.x, l.y)
      gl.uniform1f(u.uSize, l.size)
      gl.uniform1f(u.uAngle, l.angle)
      gl.uniform1f(u.uSeed, l.seed)
      gl.drawArrays(gl.TRIANGLES, 0, 3)
    }
    gl.disable(gl.BLEND)
    gl.blendEquation(gl.FUNC_ADD)
  }

  private applyWipes() {
    if (!this.segs.length) return
    const gl = this.gl
    const st = this.state[this.cur]
    gl.bindFramebuffer(gl.FRAMEBUFFER, st.fbo)
    gl.viewport(0, 0, this.bw, this.bh)
    gl.enable(gl.BLEND)
    gl.blendEquation(gl.MIN)
    gl.useProgram(this.wipe.p)
    gl.uniform2f(this.wipe.u.uRes, this.w, this.h)
    gl.uniform1f(this.wipe.u.uHalfW, this.halfWidth)
    gl.uniform1f(this.wipe.u.uDpr, this.dpr)
    gl.uniform1f(this.wipe.u.uCanvasH, this.bh)
    gl.bindVertexArray(this.wipeVao)
    gl.bindBuffer(gl.ARRAY_BUFFER, this.wipeBuf)

    const ext = this.halfWidth + 8
    const segs = this.segs
    const maxSegs = this.wipeData.length / 36
    for (let base = 0; base < segs.length; base += maxSegs * 4) {
      const d = this.wipeData
      let o = 0
      const end = Math.min(segs.length, base + maxSegs * 4)
      for (let i = base; i < end; i += 4) {
        const ax = segs[i], ay = segs[i + 1], bx = segs[i + 2], by = segs[i + 3]
        let ux = bx - ax
        let uy = by - ay
        const l = Math.hypot(ux, uy)
        if (l < 1e-3) {
          ux = 1
          uy = 0
        } else {
          ux /= l
          uy /= l
        }
        const nx = -uy * ext
        const ny = ux * ext
        const ex = ux * ext
        const ey = uy * ext
        const c = [
          [ax - ex + nx, ay - ey + ny],
          [ax - ex - nx, ay - ey - ny],
          [bx + ex + nx, by + ey + ny],
          [bx + ex - nx, by + ey - ny],
        ]
        for (const k of [0, 1, 2, 2, 1, 3]) {
          d[o++] = c[k][0]
          d[o++] = c[k][1]
          d[o++] = ax
          d[o++] = ay
          d[o++] = bx
          d[o++] = by
        }
      }
      gl.bufferSubData(gl.ARRAY_BUFFER, 0, d, 0, o)
      gl.drawArrays(gl.TRIANGLES, 0, o / 6)
    }
    gl.disable(gl.BLEND)
    gl.blendEquation(gl.FUNC_ADD)
    this.segs.length = 0
  }

  private render(t: number, dt: number) {
    const gl = this.gl
    gl.bindFramebuffer(gl.FRAMEBUFFER, null)
    gl.viewport(0, 0, this.bw, this.bh)
    gl.useProgram(this.comp.p)
    const u = this.comp.u
    gl.activeTexture(gl.TEXTURE0)
    gl.bindTexture(gl.TEXTURE_2D, this.state[this.cur].tex)
    gl.uniform1i(u.uState, 0)
    gl.activeTexture(gl.TEXTURE1)
    gl.bindTexture(gl.TEXTURE_2D, this.video ? this.videoTex : this.fallbackTex)
    gl.uniform1i(u.uVideo, 1)
    gl.uniform2f(u.uRes, this.w, this.h)
    gl.uniform2f(u.uStateTexel, 1 / this.w, 1 / this.h) // offsets are given in css px
    gl.uniform1f(u.uTime, t - this.startT)
    const v = this.vrect
    gl.uniform4f(u.uVRect, v.dx, v.dy, v.dw, v.dh)
    gl.uniform1f(u.uMirror, this.video ? 1 : 0)
    gl.uniform1f(u.uHalfW, this.halfWidth)

    const c = this.cursor
    const k = c.source === 'hand' ? 1 - Math.pow(0.001, dt) : 1
    c.rx += (c.x - c.rx) * k
    c.ry += (c.y - c.ry) * k
    const targetA = c.visible && !this.hideCursor ? 1 : 0
    c.a += (targetA - c.a) * (this.hideCursor ? 1 : 0.2)
    gl.uniform4f(u.uCursor, c.rx, c.ry, this.halfWidth + 3, c.a)
    gl.uniform1f(u.uCursorDraw, c.drawing ? 1 : 0)
    const rv = Math.min(1, (t - this.startT) / 1.2)
    gl.uniform1f(u.uReveal, rv * rv * (3 - 2 * rv))
    gl.bindVertexArray(this.triVao)
    gl.drawArrays(gl.TRIANGLES, 0, 3)
  }
}
