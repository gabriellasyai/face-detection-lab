/**
 * FFmpeg-based frame extraction and audio RMS analysis.
 */

import { execSync } from 'child_process';
import { readdirSync } from 'fs';
import { join } from 'path';

/**
 * Extract frames from a video at a given sample rate.
 * @param {string} videoPath
 * @param {string} outputDir
 * @param {number} startTime - seconds
 * @param {number} endTime - seconds
 * @param {number} sampleFps - frames per second to extract
 * @returns {Array<{path: string, timestamp: number}>}
 */
export async function extractFrames(videoPath, outputDir, startTime, endTime, sampleFps = 2) {
  const duration = (endTime || 60) - startTime;

  execSync(
    `ffmpeg -y -v quiet -ss ${startTime} -i "${videoPath}" -t ${duration} -vf "fps=${sampleFps}" -q:v 2 "${join(outputDir, 'frame_%04d.jpg')}"`,
    { timeout: 60000 }
  );

  const files = readdirSync(outputDir)
    .filter(f => f.startsWith('frame_') && f.endsWith('.jpg'))
    .sort();

  return files.map((f, i) => ({
    path: join(outputDir, f),
    timestamp: startTime + i / sampleFps,
  }));
}

/**
 * Extract audio RMS energy over time.
 * @param {string} videoPath
 * @param {number} startTime
 * @param {number} endTime
 * @returns {Array<{timestamp: number, rms: number}>}
 */
export async function extractAudioRMS(videoPath, startTime, endTime) {
  const duration = (endTime || 60) - startTime;

  try {
    // Use ffmpeg astats to get RMS per 0.5s chunks
    const output = execSync(
      `ffmpeg -v quiet -ss ${startTime} -i "${videoPath}" -t ${duration} -af "asegment=timestamps=${generateTimestamps(duration, 0.5)}",astats=metadata=1:reset=1 -f null - 2>&1 | grep "lavfi.astats.Overall.RMS_level" || true`,
      { timeout: 30000, encoding: 'utf-8' }
    );

    // Simplified: just sample audio at regular intervals
    // Parse output or fall back to uniform energy
    const rmsValues = [];
    const step = 0.5;
    for (let t = 0; t < duration; t += step) {
      rmsValues.push({
        timestamp: startTime + t,
        rms: 0.5, // Placeholder — will be refined with actual audio analysis
      });
    }

    return rmsValues;
  } catch {
    return [];
  }
}

function generateTimestamps(duration, step) {
  const ts = [];
  for (let t = step; t < duration; t += step) {
    ts.push(t.toFixed(2));
  }
  return ts.join('|');
}
