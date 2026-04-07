/**
 * Speaker Detection via MAR + Whisper Audio Correlation
 * Same approach as InstaCut production pipeline (face_detection.py identify_speaker)
 *
 * Logic: correlate mouth movement (MAR) with speech timestamps from Whisper.
 * The person whose mouth moves MORE during speech and LESS during silence is the speaker.
 */

import { MOUTH_UPPER, MOUTH_LOWER, MOUTH_LEFT, MOUTH_RIGHT } from './landmarks.mjs';

const MAR_SANITY_MAX = 0.8; // Above this = detection artifact

/**
 * Compute MAR from 106-point landmarks.
 */
export function computeMAR(landmarks) {
  if (!landmarks || landmarks.length < 106) return 0;
  let verticalSum = 0;
  const pairs = Math.min(MOUTH_UPPER.length, MOUTH_LOWER.length);
  for (let i = 0; i < pairs; i++) {
    const upper = landmarks[MOUTH_UPPER[i]];
    const lower = landmarks[MOUTH_LOWER[i]];
    if (upper && lower) verticalSum += Math.abs(lower[1] - upper[1]);
  }
  const verticalAvg = verticalSum / pairs;
  const left = landmarks[MOUTH_LEFT];
  const right = landmarks[MOUTH_RIGHT];
  if (!left || !right) return 0;
  const horizontal = Math.abs(right[0] - left[0]);
  return horizontal > 0.001 ? Math.min(verticalAvg / horizontal, MAR_SANITY_MAX) : 0;
}

/**
 * Detect speaker by correlating MAR with Whisper speech windows.
 * Same algorithm as InstaCut face_detection.py identify_speaker().
 *
 * @param {Array<{id, positions}>} tracks
 * @param {Array<{start, end, text}>} speechSegments - From Whisper transcription
 * @param {number} marThreshold - Not used directly, kept for API compat
 * @returns {{speakerId, scores, speakerWindows, transcription}}
 */
export function detectSpeaker(tracks, speechSegments = [], marThreshold = 0.35) {
  if (tracks.length === 0) return { speakerId: -1, scores: {}, speakerWindows: [], transcription: [] };

  // If only 1 track, they're the speaker
  if (tracks.length === 1) {
    const t = tracks[0];
    return {
      speakerId: t.id,
      scores: { [t.id]: 1 },
      speakerWindows: [{
        start: t.positions[0]?.timestamp || 0,
        end: t.positions[t.positions.length - 1]?.timestamp || 0,
        speakerId: t.id,
      }],
      transcription: speechSegments,
    };
  }

  // Build speech windows from Whisper segments
  const speechWindows = speechSegments
    .filter(seg => seg.start != null && seg.end != null)
    .map(seg => [seg.start, seg.end]);

  const isDuringSpeech = (ts) => {
    for (const [start, end] of speechWindows) {
      if (start - 0.2 <= ts && ts <= end + 0.2) return true;
    }
    return false;
  };

  // For each person: compute MAR during speech vs silence (same as InstaCut)
  let bestPerson = null;
  let bestDiff = -1;
  const scores = {};

  for (const track of tracks) {
    const marsSpeech = [];
    const marsSilence = [];

    for (const pos of track.positions) {
      const mar = pos.landmarks ? computeMAR(pos.landmarks) : 0;
      const clampedMar = Math.min(mar, MAR_SANITY_MAX);

      if (speechWindows.length === 0) {
        // No transcription: fall back to MAR variance
        marsSpeech.push(clampedMar);
      } else if (isDuringSpeech(pos.timestamp)) {
        marsSpeech.push(clampedMar);
      } else {
        marsSilence.push(clampedMar);
      }
    }

    const avgSpeech = marsSpeech.length > 0 ? marsSpeech.reduce((a, b) => a + b) / marsSpeech.length : 0;
    const avgSilence = marsSilence.length > 0 ? marsSilence.reduce((a, b) => a + b) / marsSilence.length : 0;
    const differential = avgSpeech - avgSilence;

    // Weight by face area: larger faces = more reliable landmarks
    const bboxes = track.positions.filter(p => p.bbox).map(p => {
      const [x1, y1, x2, y2] = p.bbox;
      return (x2 - x1) * (y2 - y1);
    });
    const avgArea = bboxes.length > 0 ? bboxes.reduce((a, b) => a + b) / bboxes.length : 0;
    const areaWeight = Math.min(1.0, avgArea / 0.02);

    const weightedDiff = Math.max(0, differential * areaWeight);
    scores[track.id] = weightedDiff;

    console.log(`  [speaker] Track ${track.id}: MAR speech=${avgSpeech.toFixed(4)}, silence=${avgSilence.toFixed(4)}, diff=${differential.toFixed(4)}, area_w=${areaWeight.toFixed(2)}, score=${weightedDiff.toFixed(4)}`);

    if (weightedDiff > bestDiff) {
      bestDiff = weightedDiff;
      bestPerson = track;
    }
  }

  const speakerId = bestPerson?.id ?? tracks[0].id;
  console.log(`  [speaker] Active speaker: Track ${speakerId} (score=${bestDiff.toFixed(4)})${speechWindows.length > 0 ? ' (Whisper-correlated)' : ' (MAR-only fallback)'}`);

  // Generate speaker windows
  const lastTs = Math.max(...tracks.flatMap(t => t.positions.map(p => p.timestamp)));
  const firstTs = Math.min(...tracks.flatMap(t => t.positions.map(p => p.timestamp)));

  return {
    speakerId,
    scores,
    speakerWindows: [{ start: firstTs, end: lastTs, speakerId }],
    transcription: speechSegments,
    method: speechWindows.length > 0 ? 'whisper-correlated' : 'mar-only',
  };
}
