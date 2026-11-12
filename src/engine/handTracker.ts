import { FaceLandmarker, FilesetResolver, HandLandmarker } from '@mediapipe/tasks-vision'

const HAND_MODEL =
  'https://storage.googleapis.com/mediapipe-models/hand_landmarker/hand_landmarker/float16/1/hand_landmarker.task'
const FACE_MODEL =
  'https://storage.googleapis.com/mediapipe-models/face_landmarker/face_landmarker/float16/1/face_landmarker.task'

async function withFallback<T>(make: (d: 'GPU' | 'CPU') => Promise<T>): Promise<T> {
  try {
    return await make('GPU')
  } catch (e) {
    console.warn('GPU delegate unavailable, falling back to CPU', e)
    return make('CPU')
  }
}

/** Hand + face landmarkers, both running locally in the browser (WASM served from /mediapipe/wasm). */
export async function createTrackers(): Promise<{ hand: HandLandmarker; face: FaceLandmarker }> {
  const base = new URL(import.meta.env.BASE_URL + 'mediapipe/wasm', window.location.href).href
  const fileset = await FilesetResolver.forVisionTasks(base)
  const [hand, face] = await Promise.all([
    withFallback((delegate) =>
      HandLandmarker.createFromOptions(fileset, {
        baseOptions: { modelAssetPath: HAND_MODEL, delegate },
        runningMode: 'VIDEO',
        numHands: 1,
        minHandDetectionConfidence: 0.6,
        minHandPresenceConfidence: 0.55,
        minTrackingConfidence: 0.5,
      }),
    ),
    withFallback((delegate) =>
      FaceLandmarker.createFromOptions(fileset, {
        baseOptions: { modelAssetPath: FACE_MODEL, delegate },
        runningMode: 'VIDEO',
        numFaces: 1,
        outputFaceBlendshapes: true,
        minFaceDetectionConfidence: 0.5,
        minFacePresenceConfidence: 0.5,
        minTrackingConfidence: 0.5,
      }),
    ),
  ])
  return { hand, face }
}
