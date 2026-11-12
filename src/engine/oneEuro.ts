// One Euro filter: smooths jitter at rest while staying responsive during fast motion.
const alpha = (cutoff: number, dt: number) => 1 / (1 + 1 / (2 * Math.PI * cutoff * dt))

class OneEuro {
  private x: number | null = null
  private dx = 0
  private t = -1
  private minCutoff: number
  private beta: number
  private dCutoff: number
  constructor(minCutoff: number, beta: number, dCutoff: number) {
    this.minCutoff = minCutoff
    this.beta = beta
    this.dCutoff = dCutoff
  }
  reset() {
    this.x = null
    this.dx = 0
    this.t = -1
  }
  filter(v: number, t: number) {
    if (this.x === null || this.t < 0) {
      this.x = v
      this.t = t
      return v
    }
    const dt = Math.max(1e-3, t - this.t)
    this.t = t
    const d = (v - this.x) / dt
    this.dx += alpha(this.dCutoff, dt) * (d - this.dx)
    const cutoff = this.minCutoff + this.beta * Math.abs(this.dx)
    this.x += alpha(cutoff, dt) * (v - this.x)
    return this.x
  }
}

export class OneEuro2D {
  private fx: OneEuro
  private fy: OneEuro
  constructor(minCutoff = 1.2, beta = 0.012, dCutoff = 1) {
    this.fx = new OneEuro(minCutoff, beta, dCutoff)
    this.fy = new OneEuro(minCutoff, beta, dCutoff)
  }
  reset() {
    this.fx.reset()
    this.fy.reset()
  }
  filter(x: number, y: number, t: number) {
    return { x: this.fx.filter(x, t), y: this.fy.filter(y, t) }
  }
}
