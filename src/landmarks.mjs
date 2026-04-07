/**
 * 2d106det Landmark Extraction via ONNX Runtime
 * Model: 2d106det.onnx (InsightFace buffalo_l)
 * Output: 106 facial landmarks including mouth points for MAR
 */

import * as ort from 'onnxruntime-node';
import { readFileSync } from 'fs';
import { execSync } from 'child_process';
import { join, dirname } from 'path';
import { fileURLToPath } from 'url';

const __dirname = dirname(fileURLToPath(import.meta.url));
const MODEL_PATH = join(__dirname, '..', 'models', '2d106det.onnx');

let session = null;
const INPUT_SIZE = 192;

async function getSession() {
  if (session) return session;
  session = await ort.InferenceSession.create(MODEL_PATH, {
    executionProviders: [{ name: 'cuda', deviceId: 0 }, 'cpu'],
  });
  console.log(`[landmarks] Model loaded. Inputs: ${session.inputNames}`);
  return session;
}

/**
 * Extract 106 landmarks from a face crop.
 * @param {string} imagePath - Full image path
 * @param {number[]} bbox - Normalized [x1, y1, x2, y2] from face detector
 * @returns {number[][]} Array of 106 [x, y] landmark points (normalized to face bbox)
 */
export async function extractLandmarks(imagePath, bbox) {
  if (!imagePath || !bbox) return null;

  const sess = await getSession();

  // Crop face region with margin and resize to 192x192
  const [x1, y1, x2, y2] = bbox;
  const margin = 0.2;
  const cx1 = Math.max(0, x1 - margin * (x2 - x1));
  const cy1 = Math.max(0, y1 - margin * (y2 - y1));
  const cx2 = Math.min(1, x2 + margin * (x2 - x1));
  const cy2 = Math.min(1, y2 + margin * (y2 - y1));

  const cropFilter = `crop=iw*${cx2 - cx1}:ih*${cy2 - cy1}:iw*${cx1}:ih*${cy1},scale=${INPUT_SIZE}:${INPUT_SIZE}`;
  const rawPath = imagePath + '.lm.raw';

  try {
    execSync(
      `ffmpeg -y -v quiet -i "${imagePath}" -vf "${cropFilter}" -f rawvideo -pix_fmt rgb24 "${rawPath}"`,
      { timeout: 5000 }
    );
  } catch {
    return null;
  }

  const raw = readFileSync(rawPath);
  try { execSync(`rm "${rawPath}"`); } catch {}

  if (raw.length !== 3 * INPUT_SIZE * INPUT_SIZE) return null;

  // Normalize to float32 CHW
  const pixels = new Float32Array(3 * INPUT_SIZE * INPUT_SIZE);
  for (let i = 0; i < INPUT_SIZE * INPUT_SIZE; i++) {
    pixels[i] = raw[i * 3] / 255.0;
    pixels[INPUT_SIZE * INPUT_SIZE + i] = raw[i * 3 + 1] / 255.0;
    pixels[2 * INPUT_SIZE * INPUT_SIZE + i] = raw[i * 3 + 2] / 255.0;
  }

  const tensor = new ort.Tensor('float32', pixels, [1, 3, INPUT_SIZE, INPUT_SIZE]);
  const results = await sess.run({ [sess.inputNames[0]]: tensor });
  const output = results[sess.outputNames[0]].data;

  // Parse 106 landmarks (x, y pairs)
  // 2d106det outputs coords in range ~[-1, 1], decode: pixel = (val + 1) * (INPUT_SIZE / 2)
  const landmarks = [];
  for (let i = 0; i < 106; i++) {
    const rawX = output[i * 2];
    const rawY = output[i * 2 + 1];
    // Decode to pixel coords in the 192x192 crop
    const px = (rawX + 1) * (INPUT_SIZE / 2);
    const py = (rawY + 1) * (INPUT_SIZE / 2);
    // Normalize to [0, 1] within crop
    const lx = px / INPUT_SIZE;
    const ly = py / INPUT_SIZE;
    // Convert to full image normalized coords
    landmarks.push([
      cx1 + lx * (cx2 - cx1),
      cy1 + ly * (cy2 - cy1),
    ]);
  }

  return landmarks;
}

/**
 * Landmark indices for the 2d106det model:
 * 0-32:   face contour
 * 33-37:  right eyebrow
 * 38-42:  left eyebrow
 * 43-47:  nose bridge
 * 48-51:  nose tip
 * 52-57:  right eye
 * 58-63:  left eye
 * 64-71:  outer upper lip
 * 72-79:  outer lower lip
 * 80-83:  inner upper lip
 * 84-87:  inner lower lip
 * 88-95:  right eye detail
 * 96-103: left eye detail
 * 104-105: pupils
 *
 * Mouth landmarks for MAR:
 * Outer upper lip: 64, 65, 66, 67, 68, 69, 70, 71 (left corner → right corner over top)
 * Outer lower lip: 72, 73, 74, 75, 76, 77, 78, 79 (left corner → right corner under bottom)
 * Inner upper: 80, 81, 82, 83
 * Inner lower: 84, 85, 86, 87
 *
 * For MAR we use:
 *   Vertical: outer upper lip center (67) vs outer lower lip center (75)
 *     — single pair like the Python production code (which uses 68-lm indices 62/66)
 *   Horizontal: left mouth corner (64) vs right mouth corner (71)
 *     — full mouth width, NOT partial upper lip span
 *
 * Previous bug: MOUTH_RIGHT was 68 (≈ center of upper lip), making horizontal
 * distance ~half the actual mouth width → MAR inflated ~2× → always hit 0.8 cap.
 */
export const MOUTH_UPPER = [67];  // outer upper lip center
export const MOUTH_LOWER = [75];  // outer lower lip center
export const MOUTH_LEFT = 64;     // left mouth corner
export const MOUTH_RIGHT = 71;    // right mouth corner (was 68 — WRONG)
