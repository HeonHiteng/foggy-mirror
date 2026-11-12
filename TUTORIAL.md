# Tutorial: Build the Foggy Mirror with AI, step by step

The finished app is a webcam mirror. You breathe on it (open your mouth) to fog it up, write in the fog with your index finger, and kiss it to leave a lip print. Holding the kiss adds a heart.

**Time:** about 1–2 hours. **You need:** a laptop with a webcam, Chrome or Edge, and an AI coding tool (Cursor, Claude Code, Lovable, Replit or Codex).

> **Why build in stages?** Pasting one giant prompt often gives you a pretty demo that doesn't really work. Building in layers (camera, then fog, then writing, then realism, then the kiss) lets you test each piece before stacking the next. The full one-shot prompt is in `PROMPT.md` if you'd rather try that.

---

## Step 0: Set up

1. Install **Node.js 20+** (check with `node -v`).
2. Create an empty folder (for example `foggy-mirror`) and open it in your AI tool.
3. Use **Chrome or Edge**. The camera only works on `localhost` or an `https://` site.

---

## Step 1: The mirror and the webcam

**Prompt:**
```
Create a React + TypeScript + Vite + Tailwind app called "Foggy Mirror".
Full-screen WebGL2 canvas that shows my webcam as a mirror: horizontally mirrored, cover-fit
to the screen, with a slightly darker, cool "mirror glass" colour grade and a soft vignette.
Camera only (no microphone). Add an intro screen with the title "Foggy Mirror" in an italic
serif font (Cormorant Garamond), a "Step up to the mirror" button that requests the camera,
and a "No camera? Use mouse or touch" link that shows a procedural warm bathroom scene instead.
Handle camera permission denial gracefully.
```

**Check:** run `npm install` and `npm run dev`, open http://localhost:5173 and allow the camera. You should see yourself mirrored, like in a real mirror.

---

## Step 2: The fog layer (simulation)

This is the heart of the app. Fog must be a **separate high-resolution density map**, not an image drawn on top.

**Prompt:**
```
Add a fog simulation in WebGL2:
- A full-resolution state texture (RGBA16F if EXT_color_buffer_float exists, RGBA8 fallback),
  ping-ponged each frame. R = fog density (0..1.5), G = "dryness" for wet rims (1 = dry).
- Simulation pass each frame: natural evaporation R -= dt*(0.008 + 0.03R)*noise so thin fog
  disappears first and the fog edges retreat irregularly (fully gone in about 30s).
- A breath function: inject an irregular, grainy blob of fog at a given point. Distort its edge
  with fractal noise, bias it slightly upward, and grow the radius with sqrt(time held).
- Composite pass: sharp mirrored webcam where there's no fog. Where there is fog, show a blurred
  reflection (sample the mipmapped video texture at LOD ~4) mixed with a milky-white /
  blue-grey fog colour. Opacity = 1 - exp(-2.3*density), capped at 0.87.
- For testing, holding Space breathes fog at the mouse cursor.
```

**Check:** hold **Space**. A soft, irregular cloud of fog should grow under the cursor and slowly evaporate after you let go.

---

## Step 3: Breathe with your mouth (Face Landmarker)

**Prompt:**
```
Use MediaPipe Face Landmarker (@mediapipe/tasks-vision, VIDEO mode, GPU delegate with CPU
fallback, WASM files served locally from /public/mediapipe/wasm) to detect when I open my mouth:
- ratio = distance(landmark 13, landmark 14) / distance(landmark 10, landmark 152), in screen pixels
- calibrate a "closed mouth" baseline from the first 12 frames; drift it slowly while closed
- open when ratio - baseline > 0.06 for 2 frames, close when below 0.035 (hysteresis), EMA smoothing
- while open, breathe fog at the mouth position mapped into the mirrored screen view;
  openness (0.35-1) scales the strength. Longer open = bigger and denser fog.
Run face detection on every other video frame.
```

**Check:** open your mouth. Fog should appear **in front of your mouth in the reflection** and keep spreading while your mouth stays open. Talking normally shouldn't trigger it.

---

## Step 4: Write with your index finger (Hand Landmarker)

**Prompt:**
```
Use MediaPipe Hand Landmarker (1 hand) to write in the fog with my index fingertip (landmark 8):
- Decide the pose using the 3D WORLD landmarks, not 2D screen distances: add up each finger's
  joint bend angles. Write only when the index bend is under 55° (under 70° to keep writing),
  the index tip is 1.25x further from the wrist than the middle tip, and the middle/ring are
  bent over 95° and the pinky over 70°.
- Start after 2 agreeing frames; stop on the FIRST frame the pose fails.
- Smooth the position with a light One Euro filter (minCutoff 2.4, beta 0.035).
- Join points with midpoint-quadratic curves subdivided every 3px.
- Render each segment as a capsule quad into the fog state with MIN blending: inside the stroke
  density = 0 (fully clear, crisp ~1px anti-aliased edge); just outside, set G low for a wet rim.
- Narrow, consistent strokes (half-width ~0.85% of the screen's short side, 5-9.5px).
- Show a thin glowing ring at the fingertip, lightly filled while writing.
- Mouse/touch drawing as a fallback (use coalesced pointer events).
Run hand detection on every new video frame.
```

**Check:** breathe some fog, then point your index finger with the other fingers curled and write a word. Then make a **fist**: it must **not** write.

> **Common bug:** if a fist still writes, the AI is using 2D distances. Insist on the "3D world landmarks + joint angles" rule above.

---

## Step 5: Make it photorealistic

**Prompt:**
```
Make the condensation photorealistic in the composite shader:
- Droplet fields with one bead per grid cell (kept inside its cell so only one cell is
  evaluated per pixel):
  (a) thousands of tiny beads (~3.4px cells) wherever there is fog,
  (b) sparser larger beads where fog is dense,
  (c) rim beads beside wiped strokes, only where there is fog around the stroke
      (sample neighbouring density).
- Shade each bead like a lens: a refracted, inverted reflection inside, a darker edge,
  a specular highlight and a soft caustic.
- Fog: milky white in the light, blue-grey in shadow, low-frequency density noise plus fine grain.
- Soft diffused window light from the upper left, a faint diagonal glass sheen, a vignette.
Keep it at 60 FPS on integrated graphics: cap the device pixel ratio at 1.5 and ~2.4MP total.
```

**Check:** look closely at the fog. It should sparkle with tiny droplets, and your writing should have wet, beaded edges.

---

## Step 6: Kiss → lip print and heart

**Prompt:**
```
Add a kiss gesture using Face Landmarker blendshapes (outputFaceBlendshapes: true):
- kiss starts when mouthPucker (EMA) > 0.5 and jawOpen < 0.3 for 2 frames; ends below 0.3;
  0.6s cooldown. A kiss must never count as an open-mouth breath.
- On kiss: a short dense fog "puff" (~0.55s) at my lips, then about 0.5s later press a LIP PRINT
  into the fog: a full-screen pass with MIN blending, discarding outside an analytic lip shape
  (upper lip with a cupid's bow, mouth line, fuller lower lip, thin fogged gap between them).
  Imperfect contact: keep some fog along vertical lip creases (sine lines warped by noise) and
  in patchy low-pressure areas, plus a wet rim. Size = 0.2 x face width (landmarks 234 to 454),
  rotated by head roll (eye corners 33 and 263).
- If I hold the kiss for 1.1s: a bigger puff, then wipe a parametric heart (16sin³t, 13cos t - ...)
  around the lips over 0.9s with ease-in-out. Re-press the same lip print after the heart's puff
  so the fog doesn't cover it.
- Keyboard test keys: K = kiss, H = kiss + heart at the cursor.
```

**Check:** press **K** and **H** first. Then pucker toward the camera: a lip print should appear, and if you hold it, a heart around it.

---

## Step 7: Minimal premium UI

**Prompt:**
```
Polish the UI to feel cinematic and minimal:
- Guided hints in large italic serif that fade in and out: "Open your mouth and breathe on the glass"
  -> after the first breath, "Raise your index finger to write in the fog" -> after the first
  stroke, "Breathe again to fog over your words — or blow the mirror a kiss" (fades after 5s).
- A small loading status: "Waking the camera…", "Preparing face & hand tracking…".
- A tiny glass toolbar that auto-hides after 3.5s idle: camera on/off, Clear mirror (all fog
  evaporates over ~0.7s, timed by real elapsed time), Save mirror (PNG without the cursor).
- Privacy note on the intro: camera only, no microphone, processed locally.
- A ?debug URL flag that shows the 4 finger-bend angles and the pucker score live.
```

---

## Step 8: Test and tune

Open `http://localhost:5173/?debug` and try each gesture:

| Problem | What to change |
|---|---|
| Fog triggers while talking | Raise the mouth `openAt` threshold (for example 0.06 → 0.08) |
| Mouth opening doesn't fog | Lower `openAt` and `closeAt` |
| Fist or open palm writes | Use the debug readout: raise the "other fingers curled" angles |
| Pointing doesn't write | Raise the index limit (55° → 65°) |
| Kiss doesn't register | Watch the pucker score while kissing; lower `onAt` (0.5 → 0.4) |
| Choppy on a laptop | Lower the pixel cap (2.4MP → 1.6MP) or the droplet layers |
| Strokes too thick or thin | Change the stroke half-width |

---

## Step 9: Share it

1. Run `npm run build` to produce the `dist/` folder.
2. Deploy it to any **HTTPS** host (Vercel, Netlify, Cloudflare Pages or GitHub Pages). The camera won't work over plain `http://`.
3. Make sure the `public/mediapipe/wasm` files are included in the deploy.

**Demo script for a video:** look at the mirror → breathe a big cloud → write "hi" with your finger → breathe again to cover it → kiss the mirror and hold for a heart.
