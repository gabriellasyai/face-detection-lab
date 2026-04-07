/**
 * Generate SmartCropTrack[] data from tracked faces + speaker info.
 * Compatible with Remotion SmartCropVideo and TileLayout components.
 */

/**
 * @param {Array<{id, positions}>} tracks
 * @param {{speakerId, speakerWindows}} speakerInfo
 * @param {{mode, zoomLevel, focusPadding, smoothMinCutoff, smoothBeta}} opts
 * @returns {{layout: string, tracks: Array<SmartCropTrack>}}
 */
export function generateCropData(tracks, speakerInfo, opts = {}) {
  const {
    mode = 'auto',
    zoomLevel = 1.0,
    focusPadding = 0.3,
  } = opts;

  if (tracks.length === 0) {
    return { layout: 'single', tracks: [] };
  }

  if (mode === 'split2' && tracks.length >= 2) {
    return generateSplit2(tracks, speakerInfo);
  }

  // Auto or Focus mode: single crop following speaker
  const speakerTrack = tracks.find(t => t.id === speakerInfo.speakerId) || tracks[0];

  // Target output aspect ratio: 9:16 portrait
  const sourceAspect = 16 / 9;  // source video W/H
  const targetAspect = 9 / 16;  // desired output W/H

  // Adaptive baseH depending on scene composition:
  // - 1 dominant track → tighter crop (0.85) for more zoom on speaker
  // - 2+ tracks → wider crop to include context / multiple people
  // - Also factor in average face size: larger faces (closer) → can crop tighter
  let baseH;
  if (mode === 'focus') {
    baseH = 0.80;
  } else {
    // Count tracks with significant presence (>25% of frames)
    const maxFrames = Math.max(...tracks.map(t => t.positions.length));
    const significantTracks = tracks.filter(t => t.positions.length >= maxFrames * 0.25);

    // Average face size of the speaker (larger = closer to camera)
    const speakerBboxes = speakerTrack.positions.filter(p => p.bbox).map(p => {
      const [x1, y1, x2, y2] = p.bbox;
      return (x2 - x1) * (y2 - y1);
    });
    const avgFaceArea = speakerBboxes.length > 0
      ? speakerBboxes.reduce((a, b) => a + b) / speakerBboxes.length
      : 0;

    if (significantTracks.length <= 1) {
      // Solo speaker — tighter crop, especially if face is large (close to camera)
      // avgFaceArea ~0.01 = far, ~0.05 = medium, ~0.10+ = close
      baseH = avgFaceArea > 0.04 ? 0.80 : 0.85;
    } else if (significantTracks.length === 2) {
      // Two people — check if they're close together or spread apart
      const allCxValues = significantTracks.flatMap(t =>
        t.positions.filter(p => p.bbox).map(p => (p.bbox[0] + p.bbox[2]) / 2)
      );
      const minCx = Math.min(...allCxValues);
      const maxCx = Math.max(...allCxValues);
      const spread = maxCx - minCx;
      // spread < 0.3 = close together, > 0.5 = far apart
      baseH = spread > 0.4 ? 0.95 : 0.90;
    } else {
      // 3+ people — use full frame height to get widest crop
      baseH = 0.95;
    }
    console.log(`  [crop] significantTracks=${significantTracks.length}, avgFaceArea=${avgFaceArea.toFixed(4)}, baseH=${baseH.toFixed(2)}`);
  }

  const cropH = baseH / zoomLevel;
  // Derive width from height to maintain 9:16 output aspect
  const cropW = cropH * (1 / sourceAspect) * targetAspect;
  // For baseH=0.88: cropW = 0.88 * 0.5625 * 0.5625 = 0.278
  // That gives about 0.28 width — good for framing one person

  const segments = speakerTrack.positions.map(pos => {
    const [x1, y1, x2, y2] = pos.bbox;
    const faceCx = (x1 + x2) / 2;
    const faceCy = (y1 + y2) / 2;

    // Position the face in the upper third of the crop (rule of thirds)
    // Face center should be at ~1/3 from top of the crop region
    const cropCy = faceCy + cropH * (0.5 - 0.33);

    // Clamp crop region to stay within frame bounds
    const clampedCx = Math.max(cropW / 2, Math.min(1 - cropW / 2, faceCx));
    const clampedCy = Math.max(cropH / 2, Math.min(1 - cropH / 2, cropCy));

    return {
      start: pos.timestamp,
      end: pos.timestamp + 0.5, // Will be overridden by next segment
      crop_x: clampedCx,
      crop_y: clampedCy,
      crop_width: cropW,
      crop_height: cropH,
    };
  });

  // Fix end times: each segment ends when the next starts
  for (let i = 0; i < segments.length - 1; i++) {
    segments[i].end = segments[i + 1].start;
  }

  return {
    layout: 'single',
    tracks: [{
      player_index: 0,
      tile_bounds: { left: 0, top: 0, width: 1080, height: 1920 },
      segments,
    }],
  };
}

function generateSplit2(tracks, speakerInfo) {
  const speaker = tracks.find(t => t.id === speakerInfo.speakerId) || tracks[0];
  // Pick the most prominent non-speaker as listener (by frame count, then face area)
  const nonSpeakers = tracks.filter(t => t.id !== speaker.id);
  const listener = nonSpeakers.length > 0
    ? nonSpeakers.sort((a, b) => {
        // Primary: presence (frame count)
        if (b.positions.length !== a.positions.length) return b.positions.length - a.positions.length;
        // Secondary: face area (closer = more prominent)
        const areaOf = (t) => {
          const bboxes = t.positions.filter(p => p.bbox).map(p => {
            const [x1, y1, x2, y2] = p.bbox;
            return (x2 - x1) * (y2 - y1);
          });
          return bboxes.length > 0 ? bboxes.reduce((a, b) => a + b) / bboxes.length : 0;
        };
        return areaOf(b) - areaOf(a);
      })[0]
    : tracks[1];
  console.log(`  [split2] Speaker: Track ${speaker.id} (player_index=0, top), Listener: Track ${listener.id} (player_index=1, bottom)`);

  const makeSegments = (track) => {
    const sourceAspect = 16 / 9;
    // Split2: each half is 1080x960, so output aspect = 1080/960 = 9/8
    const splitAspect = 9 / 8;
    const cropH = 0.85;
    const cropW = cropH * (1 / sourceAspect) * splitAspect;
    return track.positions.map((pos, i, arr) => {
      const [x1, y1, x2, y2] = pos.bbox;
      const faceCx = (x1 + x2) / 2;
      const faceCy = (y1 + y2) / 2;
      const cropCy = faceCy + cropH * (0.5 - 0.33);
      const clampedCx = Math.max(cropW / 2, Math.min(1 - cropW / 2, faceCx));
      const clampedCy = Math.max(cropH / 2, Math.min(1 - cropH / 2, cropCy));
      return {
        start: pos.timestamp,
        end: i < arr.length - 1 ? arr[i + 1].timestamp : pos.timestamp + 0.5,
        crop_x: clampedCx,
        crop_y: clampedCy,
        crop_width: cropW,
        crop_height: cropH,
      };
    });
  };

  return {
    layout: 'split_2',
    tracks: [
      {
        player_index: 0, // Speaker on top
        tile_bounds: { left: 0, top: 0, width: 1080, height: 960 },
        segments: makeSegments(speaker),
      },
      {
        player_index: 1, // Listener on bottom
        tile_bounds: { left: 0, top: 960, width: 1080, height: 960 },
        segments: makeSegments(listener),
      },
    ],
  };
}
