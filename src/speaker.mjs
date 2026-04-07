/**
 * Speaker Detection via MAR (Mouth Aspect Ratio) + Audio Correlation
 */

import { MOUTH_UPPER, MOUTH_LOWER, MOUTH_LEFT, MOUTH_RIGHT } from './landmarks.mjs';

/**
 * Compute MAR from 106-point landmarks.
 * @param {number[][]} landmarks - 106 [x, y] points
 * @returns {number} MAR value (0 = closed, 0.3-0.7 = open/speaking)
 */
export function computeMAR(landmarks) {
  if (!landmarks || landmarks.length < 106) return 0;

  // Vertical: average distance between upper and lower inner lip points
  let verticalSum = 0;
  const pairs = Math.min(MOUTH_UPPER.length, MOUTH_LOWER.length);
  for (let i = 0; i < pairs; i++) {
    const upper = landmarks[MOUTH_UPPER[i]];
    const lower = landmarks[MOUTH_LOWER[i]];
    if (upper && lower) {
      verticalSum += Math.abs(lower[1] - upper[1]);
    }
  }
  const verticalAvg = verticalSum / pairs;

  // Horizontal: mouth width
  const left = landmarks[MOUTH_LEFT];
  const right = landmarks[MOUTH_RIGHT];
  if (!left || !right) return 0;
  const horizontal = Math.abs(right[0] - left[0]);

  return horizontal > 0.001 ? verticalAvg / horizontal : 0;
}

/**
 * Detect which tracked person is the active speaker.
 * @param {Array<{id, positions}>} tracks - From tracker
 * @param {Array<{timestamp, rms}>} audioRMS - Audio energy over time
 * @param {number} marThreshold - MAR threshold for "mouth open" (default 0.35)
 * @returns {{speakerId: number, speakerWindows: Array<{start, end, speakerId}>}}
 */
export function detectSpeaker(tracks, audioRMS, marThreshold = 0.35) {
  if (tracks.length === 0) return { speakerId: -1, speakerWindows: [] };
  if (tracks.length === 1) {
    // Only one person — they're the speaker
    const t = tracks[0];
    return {
      speakerId: t.id,
      speakerWindows: [{
        start: t.positions[0]?.timestamp || 0,
        end: t.positions[t.positions.length - 1]?.timestamp || 0,
        speakerId: t.id,
      }],
    };
  }

  // Compute MAR variance per track in sliding windows
  const windowSize = 1.0; // 1 second windows
  const speakerScores = new Map(); // trackId → total speaking score

  for (const track of tracks) {
    let score = 0;
    const mars = track.positions
      .filter(p => p.landmarks)
      .map(p => ({ timestamp: p.timestamp, mar: computeMAR(p.landmarks) }));

    // Sliding window MAR variance
    for (let i = 0; i < mars.length; i++) {
      const windowStart = mars[i].timestamp;
      const windowMars = mars.filter(m => m.timestamp >= windowStart && m.timestamp < windowStart + windowSize);
      if (windowMars.length < 2) continue;

      const mean = windowMars.reduce((s, m) => s + m.mar, 0) / windowMars.length;
      const variance = windowMars.reduce((s, m) => s + (m.mar - mean) ** 2, 0) / windowMars.length;

      // High variance = mouth moving = speaking
      if (variance > 0.005) score += 1;
      // Also check if mouth is open (MAR above threshold)
      if (mean > marThreshold) score += 0.5;
    }

    // Audio correlation: correlate MAR peaks with audio RMS peaks
    if (audioRMS.length > 0) {
      for (const mar of mars) {
        const closestRms = audioRMS.reduce((best, r) =>
          Math.abs(r.timestamp - mar.timestamp) < Math.abs(best.timestamp - mar.timestamp) ? r : best
        );
        // If mouth open AND audio energy high → strong speaker signal
        if (mar.mar > marThreshold && closestRms.rms > 0.1) {
          score += 1;
        }
      }
    }

    speakerScores.set(track.id, score);
  }

  // Primary speaker = highest score
  let speakerId = tracks[0].id;
  let maxScore = 0;
  for (const [id, score] of speakerScores) {
    if (score > maxScore) {
      maxScore = score;
      speakerId = id;
    }
  }

  // Generate speaker windows (who is speaking when)
  const speakerWindows = [];
  let currentSpeaker = speakerId;
  let windowStart = tracks[0].positions[0]?.timestamp || 0;

  // For now, simple: primary speaker for the whole duration
  // TODO: per-window speaker switching based on MAR peaks
  const lastTs = Math.max(...tracks.flatMap(t => t.positions.map(p => p.timestamp)));
  speakerWindows.push({ start: windowStart, end: lastTs, speakerId });

  return {
    speakerId,
    scores: Object.fromEntries(speakerScores),
    speakerWindows,
  };
}
