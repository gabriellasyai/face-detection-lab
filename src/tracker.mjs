/**
 * ByteTrack-style face tracker
 * Assigns consistent IDs to faces across frames using IoU + optional embeddings
 */

import munkres from 'munkres-js';
import { cosineSimilarity } from './arcface.mjs';

let nextTrackId = 0;

/**
 * Track faces across frames.
 * @param {Array<{timestamp: number, faces: Array}>} detections
 * @returns {Array<{id: number, positions: Array<{timestamp, bbox, confidence, landmarks, mar}>}>}
 */
export function trackFaces(detections) {
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
    const costMatrix = [];
    for (const track of tracks) {
      const row = [];
      for (const det of dets) {
        const iouScore = iou(track.lastBbox, det.bbox);
        let embScore = 0;
        if (track.lastEmbedding && det.embedding) {
          embScore = cosineSimilarity(track.lastEmbedding, det.embedding);
        }
        // Combined cost (lower is better): 1 - weighted_score
        const score = 0.6 * iouScore + 0.4 * embScore;
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
      if (cost > 0.7) continue; // Too different, don't match

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
        if (tracks[i].lost > 5) {
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

  // Sort by number of positions (most prominent first)
  finished.sort((a, b) => b.positions.length - a.positions.length);
  return finished;
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
