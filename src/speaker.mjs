/**
 * Speaker Detection via MAR + Whisper Audio Correlation
 * Same approach as InstaCut production pipeline (face_detection.py identify_speaker)
 *
 * Logic: correlate mouth movement (MAR) with speech timestamps from Whisper.
 * The person whose mouth moves MORE during speech and LESS during silence is the speaker.
 */

// Mouth landmark indices are now hardcoded in computeMAR (uses full range 64-87)
// import { MOUTH_UPPER, MOUTH_LOWER, MOUTH_LEFT, MOUTH_RIGHT } from './landmarks.mjs';

const MAR_SANITY_MAX = 5.0; // Raised: bbox-based MAR for 24 mouth points has baseline ~1.0

/**
 * Compute MAR from 106-point landmarks using bounding-box approach.
 *
 * The 2d106det model's mouth landmark indices don't map cleanly to
 * "upper center / lower center / left corner / right corner" as the
 * 68-landmark dlib model does.  Instead, we use ALL mouth-region landmarks
 * (indices 64-87 = 24 points) and measure the vertical extent (max_y - min_y)
 * vs horizontal extent (max_x - min_x) of that point cloud.
 *
 * When the mouth is closed:  vertical ≈ small, horizontal ≈ mouth width  → MAR low
 * When the mouth is open:    vertical grows (lips separate)              → MAR high
 *
 * This is source-aspect-ratio independent because we correct for 16:9 pixel aspect.
 */
export function computeMAR(landmarks) {
  if (!landmarks || landmarks.length < 88) return 0;

  // Collect all mouth landmarks (outer upper 64-71, outer lower 72-79, inner upper 80-83, inner lower 84-87)
  const mouthIndices = [];
  for (let i = 64; i <= 87; i++) mouthIndices.push(i);

  let minX = Infinity, maxX = -Infinity;
  let minY = Infinity, maxY = -Infinity;
  let count = 0;

  for (const idx of mouthIndices) {
    const pt = landmarks[idx];
    if (!pt) continue;
    const [x, y] = pt;
    if (x < minX) minX = x;
    if (x > maxX) maxX = x;
    if (y < minY) minY = y;
    if (y > maxY) maxY = y;
    count++;
  }

  if (count < 8) return 0;

  // Horizontal and vertical extents in normalized coords
  let horizExtent = maxX - minX;
  let vertExtent = maxY - minY;

  // Correct for source pixel aspect ratio (16:9 → width pixels > height pixels).
  // normalized x=0.01 corresponds to 0.01*1280 = 12.8 px
  // normalized y=0.01 corresponds to 0.01*720  = 7.2 px
  // To compare in real-world proportions: multiply x by srcW and y by srcH
  const srcW = 1280, srcH = 720; // 16:9 assumption
  horizExtent *= srcW;
  vertExtent *= srcH;

  if (horizExtent < 0.5) return 0; // < 0.5 pixel → no valid mouth detected

  return Math.min(vertExtent / horizExtent, MAR_SANITY_MAX);
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
      if (start - 0.5 <= ts && ts <= end + 0.5) return true;
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

    // Compute MAR variance during speech — speakers have higher variance
    // (mouth opens and closes rhythmically while talking)
    let varianceSpeech = 0;
    if (marsSpeech.length > 1) {
      const mean = avgSpeech;
      varianceSpeech = marsSpeech.reduce((sum, v) => sum + (v - mean) ** 2, 0) / marsSpeech.length;
    }

    // Weight by face area: larger faces = more reliable landmarks
    const bboxes = track.positions.filter(p => p.bbox).map(p => {
      const [x1, y1, x2, y2] = p.bbox;
      return (x2 - x1) * (y2 - y1);
    });
    const avgArea = bboxes.length > 0 ? bboxes.reduce((a, b) => a + b) / bboxes.length : 0;
    // Area threshold: 0.02 is too aggressive for multi-person wide shots
    // where faces are small (~0.002-0.005). Use 0.005 so small faces still get reasonable weight.
    const areaWeight = Math.min(1.0, avgArea / 0.005);

    // Combined score: differential + variance bonus (speakers move mouth more)
    // Variance is typically 0.001-0.01 for non-speakers, 0.01-0.05 for speakers
    const combinedDiff = Math.max(0, differential) + varianceSpeech * 2;
    const weightedDiff = combinedDiff * areaWeight;
    scores[track.id] = weightedDiff;

    console.log(`  [speaker] Track ${track.id}: MAR speech=${avgSpeech.toFixed(4)}, silence=${avgSilence.toFixed(4)}, diff=${differential.toFixed(4)}, var=${varianceSpeech.toFixed(6)}, area_w=${areaWeight.toFixed(2)}, score=${weightedDiff.toFixed(4)}`);

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
