/**
 * ByteTrack-style face tracker
 * Assigns consistent IDs to faces across frames using IoU + center distance + optional embeddings
 */

import munkres from 'munkres-js';
import { cosineSimilarity } from './arcface.mjs';

/**
 * Track faces across frames.
 * @param {Array<{timestamp: number, faces: Array}>} detections
 * @param {object} opts - { costThreshold, minTrackLength, maxLost }
 * @returns {Array<{id: number, positions: Array<{timestamp, bbox, confidence, landmarks, mar}>}>}
 */
export function trackFaces(detections, opts = {}) {
  const {
    costThreshold = 0.55,  // Lowered from 0.7 — allows more matches at low fps
    minTrackLength = 5,    // Tracks with fewer detections are discarded as noise
    maxLost = 8,           // Frames a track can be "lost" before being finished (generous for 2fps)
  } = opts;

  let nextTrackId = 0; // Reset per call
  const tracks = []; // Active tracks: {id, positions, lastBbox, lastEmbedding, lost}
  const finished = [];

  for (const frame of detections) {
    const dets = frame.faces;
    const ts = frame.timestamp;

    if (tracks.length === 0) {
      // First frame: create new tracks
      for (const det of dets) {
        tracks.push({
          id: nextTrackId++,
          positions: [{ timestamp: ts, ...det }],
          lastBbox: det.bbox,
          lastEmbedding: det.embedding || null,
          lost: 0,
        });
      }
      continue;
    }

    // Build cost matrix: tracks × detections
    // Use combination of IoU and center distance for robustness at low fps
    const costMatrix = [];
    for (const track of tracks) {
      const row = [];
      for (const det of dets) {
        const iouScore = iou(track.lastBbox, det.bbox);
        const distScore = 1 - centerDistance(track.lastBbox, det.bbox);  // 1 = same position, 0 = far apart
        let embScore = 0;
        if (track.lastEmbedding && det.embedding) {
          embScore = cosineSimilarity(track.lastEmbedding, det.embedding);
        }
        // Blend: use whichever geometric metric is higher (IoU or distance),
        // since at low fps IoU can be 0 even for the same person
        const geoScore = Math.max(iouScore, distScore);
        const hasEmb = track.lastEmbedding && det.embedding;
        const score = hasEmb ? 0.5 * geoScore + 0.5 * embScore : geoScore;
        row.push(1 - score);
      }
      costMatrix.push(row);
    }

    // Hungarian assignment
    let assignments = [];
    if (costMatrix.length > 0 && costMatrix[0].length > 0) {
      try {
        assignments = munkres(costMatrix);
      } catch {
        assignments = [];
      }
    }

    const matchedTracks = new Set();
    const matchedDets = new Set();

    for (const [tIdx, dIdx] of assignments) {
      if (tIdx >= tracks.length || dIdx >= dets.length) continue;
      const cost = costMatrix[tIdx][dIdx];
      if (cost > costThreshold) continue; // Too different, don't match

      tracks[tIdx].positions.push({ timestamp: ts, ...dets[dIdx] });
      tracks[tIdx].lastBbox = dets[dIdx].bbox;
      if (dets[dIdx].embedding) tracks[tIdx].lastEmbedding = dets[dIdx].embedding;
      tracks[tIdx].lost = 0;
      matchedTracks.add(tIdx);
      matchedDets.add(dIdx);
    }

    // Increment lost count for unmatched tracks
    for (let i = 0; i < tracks.length; i++) {
      if (!matchedTracks.has(i)) {
        tracks[i].lost++;
        if (tracks[i].lost > maxLost) {
          // Track lost too long — finish it
          finished.push({ id: tracks[i].id, positions: tracks[i].positions });
          tracks.splice(i, 1);
          i--;
        }
      }
    }

    // Create new tracks for unmatched detections
    for (let j = 0; j < dets.length; j++) {
      if (!matchedDets.has(j)) {
        tracks.push({
          id: nextTrackId++,
          positions: [{ timestamp: ts, ...dets[j] }],
          lastBbox: dets[j].bbox,
          lastEmbedding: dets[j].embedding || null,
          lost: 0,
        });
      }
    }
  }

  // Finalize remaining tracks
  for (const track of tracks) {
    finished.push({ id: track.id, positions: track.positions });
  }

  // Filter out short tracks (noise / false detections)
  const filtered = finished.filter(t => t.positions.length >= minTrackLength);

  // Sort by number of positions (most prominent first)
  filtered.sort((a, b) => b.positions.length - a.positions.length);
  return filtered;
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

/**
 * Normalized center distance between two bboxes.
 * Returns a value in [0, 1] where 0 = same center, 1 = max distance apart (diagonal of unit square).
 * Useful when IoU is 0 but faces are nearby (low fps with face movement).
 */
function centerDistance(a, b) {
  const cxA = (a[0] + a[2]) / 2;
  const cyA = (a[1] + a[3]) / 2;
  const cxB = (b[0] + b[2]) / 2;
  const cyB = (b[1] + b[3]) / 2;
  const dx = cxA - cxB;
  const dy = cyA - cyB;
  const dist = Math.sqrt(dx * dx + dy * dy);
  // Normalize: max possible distance in normalized coords is sqrt(2) ≈ 1.414
  // But faces are typically within 0.3 of each other, so use 0.3 as "max reasonable distance"
  // Beyond 0.3, score = 0
  const maxDist = 0.3;
  return Math.min(dist, maxDist) / maxDist;
}
