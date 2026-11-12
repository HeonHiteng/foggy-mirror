import { useCallback, useEffect, useRef, useState, type ReactNode } from 'react'
import type { FaceLandmarker, HandLandmarker } from '@mediapipe/tasks-vision'
import { MirrorGL } from './engine/MirrorGL'
import { FingerWriter, KissDetector, MouthDetector, kissPlacement } from './engine/gestures'
import { createTrackers } from './engine/handTracker'

type CamStatus = 'off' | 'starting' | 'loading' | 'on' | 'denied' | 'error'
type Phase = 'breathe' | 'write' | 'again' | 'done'

const PHASE_HINT: Record<Phase, string | null> = {
  breathe: 'Open your mouth and breathe on the glass',
  write: 'Raise your index finger to write in the fog',
  again: 'Breathe again to fog over your words — or blow the mirror a kiss',
  done: null,
}

export default function App() {
  const canvasRef = useRef<HTMLCanvasElement>(null)
  const videoRef = useRef<HTMLVideoElement>(null)
  const engineRef = useRef<MirrorGL | null>(null)
  const trackersRef = useRef<{ hand: HandLandmarker; face: FaceLandmarker } | null>(null)
  const streamRef = useRef<MediaStream | null>(null)
  const writerRef = useRef(new FingerWriter())
  const mouthRef = useRef(new MouthDetector())
  const kissRef = useRef(new KissDetector())
  const phaseRef = useRef<Phase>('done')

  const [intro, setIntro] = useState(true)
  const [cam, setCam] = useState<CamStatus>('off')
  const [hint, setHint] = useState<string | null>(null)
  const [toast, setToast] = useState<string | null>(null)
  const [fatal, setFatal] = useState<string | null>(null)
  const [toolsVisible, setToolsVisible] = useState(true)
  const hintTimer = useRef(0)
  const toolsTimer = useRef(0)
  const debug = typeof location !== 'undefined' && location.search.includes('debug')
  const [debugText, setDebugText] = useState('')
  useEffect(() => {
    if (!debug) return
    const id = window.setInterval(() => {
      const b = writerRef.current.lastBends
      const hand = b.length ? `bend° index ${b[0]} · middle ${b[1]} · ring ${b[2]} · pinky ${b[3]}` : 'no hand'
      setDebugText(`${hand}  |  pucker ${kissRef.current.pucker.toFixed(2)}`)
    }, 150)
    return () => window.clearInterval(id)
  }, [debug])

  const showHint = useCallback((text: string | null, ms = 0) => {
    window.clearTimeout(hintTimer.current)
    setHint(text)
    if (text && ms) hintTimer.current = window.setTimeout(() => setHint(null), ms)
  }, [])

  const setPhase = useCallback(
    (p: Phase, delay = 0) => {
      phaseRef.current = p
      window.setTimeout(() => {
        if (phaseRef.current === p) showHint(PHASE_HINT[p], p === 'again' ? 5000 : 0)
      }, delay)
    },
    [showHint],
  )

  const flashToast = useCallback((text: string) => {
    setToast(text)
    window.setTimeout(() => setToast(null), 2400)
  }, [])

  // engine + per-frame tracking
  useEffect(() => {
    let engine: MirrorGL
    try {
      engine = new MirrorGL(canvasRef.current!)
    } catch (e) {
      setFatal(e instanceof Error ? e.message : String(e))
      return
    }
    engineRef.current = engine
    if (import.meta.env.DEV) (window as unknown as { __mirror: MirrorGL }).__mirror = engine
    let lastVideoTime = -1
    let frameNo = 0
    let lastTs = 0

    engine.onBeforeFrame = () => {
      const v = videoRef.current
      const tr = trackersRef.current
      if (!v || !tr || !streamRef.current || v.readyState < 2) return
      if (v.currentTime === lastVideoTime) return
      lastVideoTime = v.currentTime
      const ts = Math.max(lastTs + 1, performance.now())
      lastTs = ts
      const t = ts / 1000

      // hand every camera frame (writing precision), face every other frame (breath is slow)
      const handRes = tr.hand.detectForVideo(v, ts)
      const hand = handRes.landmarks[0]?.map((p) => engine.mapVideoPoint(p.x, p.y)) ?? null
      const w = writerRef.current.process(hand, handRes.worldLandmarks[0] ?? null, t)
      engine.setHand(w.tip, w.writing)

      if (frameNo++ % 2 === 0) {
        const faceRes = tr.face.detectForVideo(v, ts)
        const face = faceRes.faceLandmarks[0]?.map((p) => engine.mapVideoPoint(p.x, p.y)) ?? null
        const m = mouthRef.current.process(face)
        const k = kissRef.current.process(face ? (faceRes.faceBlendshapes?.[0]?.categories ?? null) : null, t)
        // a kiss keeps the lips closed, so it never counts as an open-mouth breath
        engine.setBreath(m.open && !k.kissing, m.openness, face ? MouthDetector.mouthCenter(face) : null)
        if (face && (k.start || k.heart)) {
          const kp = kissPlacement(face)
          if (k.start) engine.kiss(kp.center, kp.size, kp.angle)
          if (k.heart) engine.kissHeart(kp.center, kp.size, kp.angle)
        }
      }
    }
    engine.onBreathStart = () => {
      if (phaseRef.current === 'breathe') setPhase('write', 1600)
    }
    engine.onStroke = () => {
      if (phaseRef.current === 'write') setPhase('again', 2500)
    }
    return () => {
      engine.destroy()
      engineRef.current = null
    }
  }, [setPhase])

  // auto-hide the toolbar when idle
  useEffect(() => {
    const wake = () => {
      setToolsVisible(true)
      window.clearTimeout(toolsTimer.current)
      toolsTimer.current = window.setTimeout(() => setToolsVisible(false), 3500)
    }
    wake()
    window.addEventListener('pointermove', wake)
    window.addEventListener('pointerdown', wake)
    return () => {
      window.removeEventListener('pointermove', wake)
      window.removeEventListener('pointerdown', wake)
    }
  }, [])

  const stopCamera = useCallback(() => {
    streamRef.current?.getTracks().forEach((t) => t.stop())
    streamRef.current = null
    engineRef.current?.setVideo(null)
    engineRef.current?.setHand(null, false)
    engineRef.current?.setBreath(false, 0, null)
    setCam('off')
    showHint('Draw with your finger or mouse · hold Space to breathe', 6000)
  }, [showHint])

  const startCamera = useCallback(async () => {
    if (!navigator.mediaDevices?.getUserMedia) {
      setCam('error')
      flashToast('Camera is not available in this browser')
      return
    }
    setCam('starting')
    showHint(null)
    try {
      const stream = await navigator.mediaDevices.getUserMedia({
        video: { facingMode: 'user', width: { ideal: 1280 }, height: { ideal: 720 }, frameRate: { ideal: 60 } },
        audio: false,
      })
      streamRef.current = stream
      const v = videoRef.current!
      v.srcObject = stream
      await v.play()
      engineRef.current?.setVideo(v)
      if (!trackersRef.current) {
        setCam('loading')
        trackersRef.current = await createTrackers()
      }
      if (!streamRef.current) return
      mouthRef.current = new MouthDetector() // recalibrate the resting mouth for this session
      setCam('on')
      setPhase('breathe', 600)
    } catch (err) {
      console.error(err)
      const denied = err instanceof DOMException && (err.name === 'NotAllowedError' || err.name === 'SecurityError')
      streamRef.current?.getTracks().forEach((t) => t.stop())
      streamRef.current = null
      engineRef.current?.setVideo(null)
      setCam(denied ? 'denied' : 'error')
      flashToast(denied ? 'Camera permission was blocked' : 'Could not start face and hand tracking')
      engineRef.current?.fogAll(1)
      showHint('Draw with your finger or mouse · hold Space to breathe', 7000)
    }
  }, [flashToast, setPhase, showHint])

  const camOn = cam === 'on' || cam === 'starting' || cam === 'loading'

  const begin = (withCamera: boolean) => {
    setIntro(false)
    if (withCamera) void startCamera()
    else {
      engineRef.current?.fogAll(1)
      showHint('Draw with your finger or mouse · hold Space to breathe', 7000)
    }
  }

  const save = async () => {
    const blob = await engineRef.current?.save()
    if (!blob) return
    const url = URL.createObjectURL(blob)
    const a = document.createElement('a')
    a.href = url
    a.download = `foggy-mirror-${new Date().toISOString().slice(0, 19).replace(/[:T]/g, '-')}.png`
    a.click()
    setTimeout(() => URL.revokeObjectURL(url), 2000)
    flashToast('Mirror saved')
  }

  const status = cam === 'starting' ? 'Waking the camera…' : cam === 'loading' ? 'Preparing face & hand tracking…' : null

  if (fatal)
    return (
      <div className="fixed inset-0 grid place-items-center bg-[#16110c] p-6 text-center font-sans text-white/80">
        <p>This experience needs WebGL2. {fatal}</p>
      </div>
    )

  return (
    <div className="fixed inset-0 select-none overflow-hidden font-sans text-[#f7f9fb]">
      <canvas ref={canvasRef} className="absolute inset-0 block cursor-none" />
      <video ref={videoRef} className="hidden" playsInline muted />
      {debug && (
        <div className="pointer-events-none absolute left-3 top-3 rounded bg-black/50 px-2 py-1 font-mono text-xs text-white/90">
          {debugText}
        </div>
      )}

      {/* status + guidance */}
      <div className="pointer-events-none absolute inset-x-0 top-0 flex flex-col items-center gap-2 px-4 pt-[max(1.5rem,env(safe-area-inset-top))]">
        <Fade show={!!status && !intro}>
          <div className="flex items-center gap-2 text-xs tracking-[0.18em] text-white/70 uppercase">
            <span className="h-1.5 w-1.5 animate-pulse rounded-full bg-white/80" />
            {status}
          </div>
        </Fade>
      </div>
      <div className="pointer-events-none absolute inset-x-0 bottom-[18%] flex justify-center px-6">
        <Fade show={!!hint && !intro} slow>
          <p className="text-center font-serif text-2xl italic text-white/90 [text-shadow:0_1px_18px_rgba(0,0,0,0.45)] sm:text-3xl">
            {hint}
          </p>
        </Fade>
      </div>

      {/* minimal toolbar, fades when idle */}
      {!intro && (
        <div
          className={`absolute inset-x-0 bottom-0 flex justify-center pb-[max(1.25rem,env(safe-area-inset-bottom))] transition-opacity duration-700 ${
            toolsVisible ? 'opacity-100' : 'pointer-events-none opacity-0'
          }`}
        >
          <div className="flex items-center gap-1 rounded-full border border-white/10 bg-black/20 p-1 backdrop-blur-xl">
            <ToolButton label={camOn ? 'Turn camera off' : 'Turn camera on'} active={camOn} onClick={() => (camOn ? stopCamera() : startCamera())}>
              {camOn ? <IconCamera /> : <IconCameraOff />}
            </ToolButton>
            <ToolButton label="Clear mirror" onClick={() => engineRef.current?.clear()}>
              <IconWipe />
            </ToolButton>
            <ToolButton label="Save mirror" onClick={save}>
              <IconSave />
            </ToolButton>
          </div>
        </div>
      )}

      <div className="pointer-events-none absolute bottom-24 left-1/2 -translate-x-1/2">
        <Fade show={!!toast}>
          <div className="rounded-full bg-black/35 px-4 py-2 text-sm backdrop-blur-md">{toast}</div>
        </Fade>
      </div>

      {intro && (
        <div className="absolute inset-0 flex items-center justify-center bg-[radial-gradient(ellipse_at_center,rgba(10,14,18,0.55),rgba(10,14,18,0.15)_70%)] px-6">
          <div className="w-full max-w-md animate-[fadeIn_1.6s_ease] text-center">
            <h1 className="font-serif text-5xl font-normal italic tracking-wide text-white/95 sm:text-6xl">Foggy Mirror</h1>
            <p className="mx-auto mt-4 max-w-xs font-serif text-xl leading-snug text-white/80">
              Breathe on the glass. Write in the fog with your fingertip.
            </p>
            <button
              onClick={() => begin(true)}
              className="mt-9 rounded-full bg-white/90 px-7 py-3 text-sm font-medium tracking-wide text-[#1d242b] shadow-[0_8px_30px_rgba(0,0,0,0.3)] transition hover:bg-white active:scale-95"
            >
              Step up to the mirror
            </button>
            <div>
              <button
                onClick={() => begin(false)}
                className="mt-3 rounded-full px-5 py-2 text-sm text-white/65 underline-offset-4 transition hover:text-white hover:underline"
              >
                No camera? Use mouse or touch
              </button>
            </div>
            <p className="mx-auto mt-7 max-w-xs text-xs leading-relaxed text-white/50">
              Uses your camera only — no microphone. Face and hand tracking run locally in your browser; nothing is
              uploaded.
            </p>
          </div>
        </div>
      )}
    </div>
  )
}

function Fade({ show, slow, children }: { show: boolean; slow?: boolean; children: ReactNode }) {
  return (
    <div
      className={`transition-all ease-out ${slow ? 'duration-[1400ms]' : 'duration-500'} ${
        show ? 'visible translate-y-0 opacity-100 blur-0' : 'invisible translate-y-1 opacity-0 blur-[2px]'
      }`}
    >
      {children}
    </div>
  )
}

function ToolButton(props: { label: string; onClick: () => void; children: ReactNode; active?: boolean }) {
  return (
    <button
      onClick={props.onClick}
      title={props.label}
      aria-label={props.label}
      className={`grid h-10 w-10 place-items-center rounded-full transition active:scale-90 ${
        props.active ? 'bg-white/15 text-white' : 'text-white/75 hover:bg-white/10 hover:text-white'
      }`}
    >
      {props.children}
    </button>
  )
}

const svg = (d: ReactNode) => (
  <svg width="19" height="19" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" strokeLinejoin="round">
    {d}
  </svg>
)
const IconCamera = () =>
  svg(
    <>
      <path d="M15 10l4.55-2.28A1 1 0 0 1 21 8.62v6.76a1 1 0 0 1-1.45.9L15 14" />
      <rect x="3" y="6" width="12" height="12" rx="2" />
    </>,
  )
const IconCameraOff = () =>
  svg(
    <>
      <path d="M15 10l4.55-2.28A1 1 0 0 1 21 8.62v6.76a1 1 0 0 1-1.45.9L15 14" />
      <rect x="3" y="6" width="12" height="12" rx="2" />
      <path d="M2 2l20 20" />
    </>,
  )
const IconWipe = () =>
  svg(
    <>
      <path d="M4 15c3-1 5-4 8-4s5 3 8 2" />
      <path d="M4 10c3-1 5-4 8-4s5 3 8 2" opacity="0.5" />
      <path d="M4 20c3-1 5-4 8-4s5 3 8 2" opacity="0.5" />
    </>,
  )
const IconSave = () =>
  svg(
    <>
      <path d="M12 4v11" />
      <path d="M7 10l5 5 5-5" />
      <path d="M5 20h14" />
    </>,
  )
