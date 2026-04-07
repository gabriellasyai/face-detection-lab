/**
 * ArcFace Face Re-Identification via ONNX Runtime
 * Model: w600k_r50.onnx (InsightFace buffalo_l)
 * Output: 512-d face embedding for identity matching
 */

import * as ort from 'onnxruntime-node';
import { readFileSync } from 'fs';
import { execSync } from 'child_process';
import { join, dirname } from 'path';
import { fileURLToPath } from 'url';

const __dirname = dirname(fileURLToPath(import.meta.url));
const MODEL_PATH = join(__dirname, '..', 'models', 'w600k_r50.onnx');

let session = null;
const INPUT_SIZE = 112;

async function getSession() {
  if (session) return session;
  const opts = new ort.InferenceSession.SessionOptions();
  try {
    opts.appendExecutionProvider('cuda', { device_id: 0 });
  } catch {}
  session = await ort.InferenceSession.create(MODEL_PATH, opts);
  console.log(`[arcface] Model loaded. Inputs: ${session.inputNames}`);
  return session;
}

/**
 * Extract 512-d face embedding from a face crop.
 * @param {string} imagePath - Full image path
 * @param {number[]} bbox - Normalized [x1, y1, x2, y2]
 * @returns {Float32Array} 512-dimensional face embedding
 */
export async function extractEmbeddings(imagePath, bbox) {
  if (!imagePath || !bbox) return null;

  const sess = await getSession();
  const [x1, y1, x2, y2] = bbox;

  const cropFilter = `crop=iw*${x2 - x1}:ih*${y2 - y1}:iw*${x1}:ih*${y1},scale=${INPUT_SIZE}:${INPUT_SIZE}`;
  const rawPath = imagePath + '.arc.raw';

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

  const pixels = new Float32Array(3 * INPUT_SIZE * INPUT_SIZE);
  for (let i = 0; i < INPUT_SIZE * INPUT_SIZE; i++) {
    // ArcFace expects normalized: (pixel - 127.5) / 127.5
    pixels[i] = (raw[i * 3] - 127.5) / 127.5;
    pixels[INPUT_SIZE * INPUT_SIZE + i] = (raw[i * 3 + 1] - 127.5) / 127.5;
    pixels[2 * INPUT_SIZE * INPUT_SIZE + i] = (raw[i * 3 + 2] - 127.5) / 127.5;
  }

  const tensor = new ort.Tensor('float32', pixels, [1, 3, INPUT_SIZE, INPUT_SIZE]);
  const results = await sess.run({ [sess.inputNames[0]]: tensor });
  const embedding = results[sess.outputNames[0]].data;

  // L2 normalize
  let norm = 0;
  for (let i = 0; i < embedding.length; i++) norm += embedding[i] * embedding[i];
  norm = Math.sqrt(norm);
  const normalized = new Float32Array(embedding.length);
  for (let i = 0; i < embedding.length; i++) normalized[i] = embedding[i] / norm;

  return normalized;
}

/**
 * Compute cosine similarity between two embeddings.
 * @param {Float32Array} a
 * @param {Float32Array} b
 * @returns {number} Similarity score [0, 1]
 */
export function cosineSimilarity(a, b) {
  if (!a || !b || a.length !== b.length) return 0;
  let dot = 0;
  for (let i = 0; i < a.length; i++) dot += a[i] * b[i];
  return dot; // Already L2-normalized, so dot = cosine similarity
}
