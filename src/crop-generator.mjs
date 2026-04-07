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
  // In normalized [0,1] coords, width and height represent different pixel ranges
  // (e.g., for 16:9 source: width=1 means 1920px, height=1 means 1080px).
  // To get a 9:16 crop from 16:9 source, we compute in normalized space:
  //   cropH_norm = cropW_norm * (srcW/srcH) / (outW/outH)
  // For 16:9 src → 9:16 out: cropH = cropW * (16/9) / (9/16) = cropW * 3.16
  // This means height easily exceeds 1.0. So we size based on what fits.
  //
  // Strategy: set cropH to cover most of the vertical frame (e.g., 0.85),
  // then derive cropW from the aspect ratio.
  const sourceAspect = 16 / 9;  // source video W/H
  const targetAspect = 9 / 16;  // desired output W/H

  // Height-first sizing: use most of the frame vertically
  const baseH = mode === 'focus' ? 0.80 : 0.95;
  const cropH = baseH / zoomLevel;
  // Derive width from height to maintain 9:16 output aspect
  // cropW_pixels / cropH_pixels = 9/16
  // (cropW * srcW) / (cropH * srcH) = 9/16
  // cropW = cropH * (srcH / srcW) * (9/16)
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
  const listener = tracks.find(t => t.id !== speaker.id) || tracks[1];

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
