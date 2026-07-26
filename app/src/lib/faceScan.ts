import {
  FaceLandmarker,
  FilesetResolver,
  type FaceLandmarkerResult,
  type NormalizedLandmark,
} from "@mediapipe/tasks-vision";

const WASM_ROOT =
  "https://cdn.jsdelivr.net/npm/@mediapipe/tasks-vision@0.10.35/wasm";
const MODEL_URL =
  "https://storage.googleapis.com/mediapipe-models/face_landmarker/face_landmarker/float16/1/face_landmarker.task";

let landmarkerPromise: Promise<FaceLandmarker> | null = null;

/** Lazily create a single shared FaceLandmarker configured for video input. */
export function getFaceLandmarker(): Promise<FaceLandmarker> {
  if (!landmarkerPromise) {
    landmarkerPromise = (async () => {
      const fileset = await FilesetResolver.forVisionTasks(WASM_ROOT);
      return FaceLandmarker.createFromOptions(fileset, {
        baseOptions: { modelAssetPath: MODEL_URL, delegate: "GPU" },
        runningMode: "VIDEO",
        numFaces: 1,
        outputFaceBlendshapes: false,
        outputFacialTransformationMatrixes: false,
      });
    })().catch((err) => {
      landmarkerPromise = null; // allow retry
      throw err;
    });
  }
  return landmarkerPromise;
}

export type FaceLandmarks = NormalizedLandmark[];

/** Detect the primary face in a video frame; null if none present. */
export function detectFace(
  landmarker: FaceLandmarker,
  video: HTMLVideoElement,
  timestampMs: number
): FaceLandmarks | null {
  const result: FaceLandmarkerResult = landmarker.detectForVideo(
    video,
    timestampMs
  );
  const face = result.faceLandmarks?.[0];
  return face && face.length > 0 ? face : null;
}
