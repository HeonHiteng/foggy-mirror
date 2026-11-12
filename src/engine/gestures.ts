import { OneEuro2D } from './oneEuro'

type P = { x: number; y: number }

const dist = (a: P, b: P) => Math.hypot(a.x - b.x, a.y - b.y)
const mid = (a: P, b: P) => ({ x: (a.x + b.x) / 2, y: (a.y + b.y) / 2 })

// MediaPipe hand landmark indices
const WRIST = 0
const INDEX = [5, 6, 7, 8] as const // MCP, PIP, DIP, TIP
const MIDDLE = [9, 10, 11, 12] as const
const RING = [13, 14, 15, 16] as const
const PINKY = [17, 18, 19, 20] as const
const INDEX_TIP = 8

type P3 = { x: number; y: number; z: number }
const sub = (a: P3, b: P3) => ({ x: a.x - b.x, y: a.y - b.y, z: a.z - b.z })
const len3 = (v: P3) => Math.hypot(v.x, v.y, v.z)
/** Angle (degrees) between two 3D direction vectors: 0 = perfectly straight. */
function angle(a: P3, b: P3) {
  const d = (a.x * b.x + a.y * b.y + a.z * b.z) / Math.max(1e-9, len3(a) * len3(b))
  return (Math.acos(Math.min(1, Math.max(-1, d))) * 180) / Math.PI
}
/** Total bend of a finger in 3D: knuckle (MCP) + middle joint (PIP) + end joint (DIP). */
function bend(h: P3[], [mcp, pip, dip, tip]: readonly number[]) {
  const palm = sub(h[mcp], h[WRIST])
  const a = sub(h[pip], h[mcp])
  const b = sub(h[dip], h[pip])
  const c = sub(h[tip], h[dip])
  return angle(palm, a) * 0.5 + angle(a, b) + angle(b, c)
}

/**
 * Index-finger writing: active while the index finger is straight and the middle/ring/pinky are curled.
 * Uses 3D world landmarks, so a fist seen face-on can't be mistaken for a pointing finger.
 * Starts after 2 agreeing frames (avoids stray marks), stops on the very first frame it isn't true.
 */
export class FingerWriter {
  // light One Euro smoothing: high base cutoff + speed adaptation = minimal lag
  private filter = new OneEuro2D(2.4, 0.035, 1)
  private writing = false
  private onCount = 0
  private lastSeen = -1
  /** Debug: last measured bends in degrees [index, middle, ring, pinky]. */
  lastBends: number[] = []

  /** hand: landmarks in screen px (for position). world: 3D world landmarks in metres (for pose). */
  process(hand: P[] | null, world: P3[] | null, t: number): { tip: P | null; writing: boolean } {
    if (!hand || !world) {
      if (t - this.lastSeen > 0.2) this.filter.reset()
      this.writing = false
      this.onCount = 0
      return { tip: null, writing: false }
    }
    this.lastSeen = t
    const bi = bend(world, INDEX)
    const bm = bend(world, MIDDLE)
    const br = bend(world, RING)
    const bp = bend(world, PINKY)
    this.lastBends = [bi, bm, br, bp].map(Math.round)
    const reach = (tip: number) => len3(sub(world[tip], world[WRIST]))
    const indexStraight = bi < (this.writing ? 70 : 55) && reach(INDEX_TIP) > reach(MIDDLE[3]) * 1.25
    const othersCurled = bm > 95 && br > 95 && bp > 70
    const pose = indexStraight && othersCurled

    if (pose) {
      this.onCount++
      if (this.onCount >= 2) this.writing = true
    } else {
      this.onCount = 0
      this.writing = false
    }
    const tip = this.filter.filter(hand[INDEX_TIP].x, hand[INDEX_TIP].y, t)
    return { tip, writing: this.writing }
  }
}

// Face mesh indices
const UPPER_LIP = 13, LOWER_LIP = 14, FOREHEAD = 10, CHIN = 152, MOUTH_L = 61, MOUTH_R = 291

/**
 * Mouth-open detector. The inner-lip gap is normalised by face height, compared against a slowly
 * self-calibrating "closed" baseline, smoothed, and gated with hysteresis.
 */
export class MouthDetector {
  private ratio = 0
  private baseline = -1
  private calib: number[] = []
  private open = false
  private onCount = 0
  private offCount = 0
  /** Thresholds above the closed baseline, as a fraction of face height. */
  openAt = 0.06
  closeAt = 0.035

  /** face: landmarks in a uniform pixel space (x scaled by aspect), mouthScreen: mouth centre on screen. */
  process(face: P[] | null): { open: boolean; openness: number; ratio: number } {
    if (!face) {
      this.open = false
      this.onCount = this.offCount = 0
      return { open: false, openness: 0, ratio: 0 }
    }
    const faceH = Math.max(1e-6, dist(face[FOREHEAD], face[CHIN]))
    const raw = dist(face[UPPER_LIP], face[LOWER_LIP]) / faceH
    this.ratio = this.ratio === 0 ? raw : this.ratio * 0.5 + raw * 0.5

    // calibrate the resting (closed) mouth from the first frames, then track it slowly while closed
    if (this.baseline < 0) {
      this.calib.push(raw)
      if (this.calib.length >= 12) {
        const s = [...this.calib].sort((a, b) => a - b)
        this.baseline = Math.min(0.04, s[Math.floor(s.length * 0.25)])
      }
      return { open: false, openness: 0, ratio: raw }
    }
    const rel = this.ratio - this.baseline
    if (!this.open && rel < this.closeAt * 0.6) this.baseline = Math.min(0.04, this.baseline * 0.985 + this.ratio * 0.015)

    if (!this.open) {
      this.onCount = rel > this.openAt ? this.onCount + 1 : 0
      if (this.onCount >= 2) {
        this.open = true
        this.offCount = 0
      }
    } else {
      this.offCount = rel < this.closeAt ? this.offCount + 1 : 0
      if (this.offCount >= 2) {
        this.open = false
        this.onCount = 0
      }
    }
    const openness = this.open ? Math.min(1, Math.max(0.35, (rel - this.closeAt) / 0.12)) : 0
    return { open: this.open, openness, ratio: rel }
  }

  /** Centre of the mouth opening (pass landmarks already mapped to screen px). */
  static mouthCenter(face: P[]): P {
    const c = mid(face[UPPER_LIP], face[LOWER_LIP])
    const corners = mid(face[MOUTH_L], face[MOUTH_R])
    return { x: (c.x + corners.x) / 2, y: (c.y + corners.y) / 2 }
  }
}

type Blend = { categoryName: string; score: number }

/**
 * Kiss detector from Face Landmarker blendshapes: puckered lips (mouthPucker high) with the jaw closed.
 * Fires `start` once per kiss, and `heart` once if the kiss is held.
 */
export class KissDetector {
  pucker = 0
  private on = false
  private onCount = 0
  private since = 0
  private heartDone = false
  private cooldown = 0
  onAt = 0.5
  offAt = 0.3
  holdForHeart = 1.1

  process(shapes: Blend[] | null, t: number): { kissing: boolean; start: boolean; heart: boolean } {
    if (!shapes) {
      this.on = false
      this.onCount = 0
      return { kissing: false, start: false, heart: false }
    }
    const get = (n: string) => shapes.find((s) => s.categoryName === n)?.score ?? 0
    const raw = get('mouthPucker')
    const jaw = get('jawOpen')
    this.pucker = this.pucker * 0.5 + raw * 0.5
    let start = false
    let heart = false
    if (!this.on) {
      this.onCount = this.pucker > this.onAt && jaw < 0.3 && t > this.cooldown ? this.onCount + 1 : 0
      if (this.onCount >= 2) {
        this.on = true
        this.since = t
        this.heartDone = false
        start = true
      }
    } else if (this.pucker < this.offAt || jaw > 0.45) {
      this.on = false
      this.onCount = 0
      this.cooldown = t + 0.6
    } else if (!this.heartDone && t - this.since > this.holdForHeart) {
      this.heartDone = true
      heart = true
    }
    return { kissing: this.on, start, heart }
  }
}

// face mesh points for kiss placement
const CHEEK_L = 234, CHEEK_R = 454, EYE_OUTER_A = 33, EYE_OUTER_B = 263

/** Lip-print placement on screen: centre, half-width (px) and head roll, from landmarks in screen px. */
export function kissPlacement(face: P[]) {
  const center = MouthDetector.mouthCenter(face)
  const size = dist(face[CHEEK_L], face[CHEEK_R]) * 0.2
  let a = face[EYE_OUTER_A]
  let b = face[EYE_OUTER_B]
  if (b.x < a.x) [a, b] = [b, a]
  return { center, size, angle: Math.atan2(b.y - a.y, b.x - a.x) }
}
