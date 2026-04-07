/**
 * SCRFD Face Detection via ONNX Runtime
 * Model: det_10g.onnx (InsightFace buffalo_l)
 * Output: bounding boxes + 5 keypoints + confidence
 */

import * as ort from 'onnxruntime-node';
import { readFileSync } from 'fs';
import { execSync } from 'child_process';
import { join, dirname } from 'path';
import { fileURLToPath } from 'url';

const __dirname = dirname(fileURLToPath(import.meta.url));
const MODEL_PATH = join(__dirname, '..', 'models', 'det_10g.onnx');

let session = null;
const INPUT_SIZE = 640;

async function getSession() {
  if (session) return session;

  // Try CUDA first, fall back to CPU
  const providers = [];
  try {
    providers.push({ name: 'cuda', deviceId: 0 });
    console.log('[scrfd] Requesting CUDA GPU');
  } catch {}
  providers.push('cpu');

  session = await ort.InferenceSession.create(MODEL_PATH, {
    executionProviders: providers,
  });
  const usedProvider = session.handler?.['_ep'] || 'unknown';
  console.log(`[scrfd] Model loaded (provider: ${usedProvider}). Inputs: ${session.inputNames}, Outputs: ${session.outputNames}`);

  // Warmup
  const dummy = new Float32Array(1 * 3 * INPUT_SIZE * INPUT_SIZE);
  const tensor = new ort.Tensor('float32', dummy, [1, 3, INPUT_SIZE, INPUT_SIZE]);
  try {
    await session.run({ [session.inputNames[0]]: tensor });
    console.log('[scrfd] Warmup done');
  } catch (e) {
    console.log('[scrfd] Warmup failed (model may need different input):', e.message?.slice(0, 100));
  }

  return session;
}

/**
 * Detect faces in an image file.
 * @param {string} imagePath - Path to JPEG/PNG image
 * @returns {Array<{bbox: number[], confidence: number, keypoints: number[][]}>}
 */
export async function detectFaces(imagePath) {
  const sess = await getSession();

  // Read image and convert to raw RGB using ffmpeg
  const rawPath = imagePath + '.raw';
  execSync(
    `ffmpeg -y -v quiet -i "${imagePath}" -vf "scale=${INPUT_SIZE}:${INPUT_SIZE}:force_original_aspect_ratio=decrease,pad=${INPUT_SIZE}:${INPUT_SIZE}:(ow-iw)/2:(oh-ih)/2" -f rawvideo -pix_fmt rgb24 "${rawPath}"`,
    { timeout: 5000 }
  );

  const raw = readFileSync(rawPath);
  try { execSync(`rm "${rawPath}"`); } catch {}

  // Convert to CHW float32 normalized [0,1]
  const pixels = new Float32Array(3 * INPUT_SIZE * INPUT_SIZE);
  for (let i = 0; i < INPUT_SIZE * INPUT_SIZE; i++) {
    pixels[i] = raw[i * 3] / 255.0;                          // R
    pixels[INPUT_SIZE * INPUT_SIZE + i] = raw[i * 3 + 1] / 255.0;     // G
    pixels[2 * INPUT_SIZE * INPUT_SIZE + i] = raw[i * 3 + 2] / 255.0; // B
  }

  const inputTensor = new ort.Tensor('float32', pixels, [1, 3, INPUT_SIZE, INPUT_SIZE]);
  const results = await sess.run({ [sess.inputNames[0]]: inputTensor });

  // Parse SCRFD outputs (multi-stride: 8, 16, 32)
  const faces = [];
  const strides = [8, 16, 32];
  const outputNames = sess.outputNames;

  // SCRFD outputs: score_8, score_16, score_32, bbox_8, bbox_16, bbox_32, kps_8, kps_16, kps_32
  for (let si = 0; si < strides.length; si++) {
    const stride = strides[si];
    const scoreKey = outputNames[si];
    const bboxKey = outputNames[si + 3];
    const kpsKey = outputNames[si + 6];

    if (!results[scoreKey] || !results[bboxKey]) continue;

    const scores = results[scoreKey].data;
    const bboxes = results[bboxKey].data;
    const kps = results[kpsKey]?.data;

    const featH = Math.floor(INPUT_SIZE / stride);
    const featW = Math.floor(INPUT_SIZE / stride);
    const numAnchors = 2;

    for (let h = 0; h < featH; h++) {
      for (let w = 0; w < featW; w++) {
        for (let a = 0; a < numAnchors; a++) {
          const idx = (h * featW + w) * numAnchors + a;
          const score = scores[idx];

          if (score < 0.5) continue;

          const cx = (w + 0.5) * stride;
          const cy = (h + 0.5) * stride;

          const bIdx = idx * 4;
          const x1 = cx - bboxes[bIdx] * stride;
          const y1 = cy - bboxes[bIdx + 1] * stride;
          const x2 = cx + bboxes[bIdx + 2] * stride;
          const y2 = cy + bboxes[bIdx + 3] * stride;

          const face = {
            bbox: [x1 / INPUT_SIZE, y1 / INPUT_SIZE, x2 / INPUT_SIZE, y2 / INPUT_SIZE], // normalized 0-1
            confidence: score,
            keypoints: [],
          };

          // 5 keypoints
          if (kps) {
            const kIdx = idx * 10;
            for (let k = 0; k < 5; k++) {
              face.keypoints.push([
                (cx + kps[kIdx + k * 2] * stride) / INPUT_SIZE,
                (cy + kps[kIdx + k * 2 + 1] * stride) / INPUT_SIZE,
              ]);
            }
          }

          faces.push(face);
        }
      }
    }
  }

  // NMS
  return nms(faces, 0.4);
}

function nms(faces, iouThreshold) {
  faces.sort((a, b) => b.confidence - a.confidence);
  const keep = [];
  const suppressed = new Set();

  for (let i = 0; i < faces.length; i++) {
    if (suppressed.has(i)) continue;
    keep.push(faces[i]);
    for (let j = i + 1; j < faces.length; j++) {
      if (suppressed.has(j)) continue;
      if (iou(faces[i].bbox, faces[j].bbox) > iouThreshold) {
        suppressed.add(j);
      }
    }
  }
  return keep;
}

function iou(a, b) {
  const x1 = Math.max(a[0], b[0]);
  const y1 = Math.max(a[1], b[1]);
  const x2 = Math.min(a[2], b[2]);
  const y2 = Math.min(a[3], b[3]);
  const inter = Math.max(0, x2 - x1) * Math.max(0, y2 - y1);
  const areaA = (a[2] - a[0]) * (a[3] - a[1]);
  const areaB = (b[2] - b[0]) * (b[3] - b[1]);
  return inter / (areaA + areaB - inter + 1e-6);
}
