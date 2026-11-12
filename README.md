# Foggy Mirror

Breathe on a mirror and write in the fog with your fingertip. Your webcam is the reflection.

```bash
npm install
npm run dev
```

Open http://localhost:5173 in Chrome or Edge and allow the camera (no microphone is used).

1. **Open your mouth**: MediaPipe Face Landmarker measures the inner-lip gap relative to face height. Fog condenses at your mouth's position and spreads irregularly. The longer you keep it open, the bigger and denser the fog gets.
2. **Close your mouth**: no new fog. Existing fog slowly evaporates from its thin edges.
3. **Raise only your index finger** (other fingers curled): MediaPipe Hand Landmarker tracks landmark 8, and the fog is wiped away exactly under your fingertip. Writing stops the moment the finger isn't extended.
4. **Breathe again**: fresh fog covers your writing.
5. **Kiss the mirror** (pucker your lips, mouth closed): a small patch of breath fog appears at your lips and a lip print is pressed into it. **Hold the kiss** for about a second and a heart is wiped around the print. Detection uses the Face Landmarker `mouthPucker` blendshape; thresholds are on `KissDetector`.

Fallbacks: mouse or touch to write, and hold **Space** to breathe at the cursor, press **K** for a kiss and **H** for a kiss heart. Add `?debug` to the URL to see finger bends and the pucker score. The toolbar (camera, clear, save PNG) fades when you're idle.

## How it works
- `src/engine/MirrorGL.ts`: WebGL2 engine. A full-resolution half-float state texture stores condensation density (R) and wet-rim dryness (G). Each frame it runs: simulate (evaporation + breath) → finger wipes rasterised as capsules with MIN blending (crisp, fully cleared) → composite.
- `src/engine/shaders.ts`: breath growth, evaporation, droplet fields, blurred reflection behind the fog, lighting.
- `src/engine/gestures.ts`: `MouthDetector` (self-calibrating baseline, smoothing, hysteresis) and `FingerWriter` (index-only pose, One Euro smoothing).

Tuning: mouth thresholds are `openAt` / `closeAt` in `MouthDetector`; stroke width is `halfWidth` in `MirrorGL`; fog fade speed is the evaporation line in `SIM_FS`.
