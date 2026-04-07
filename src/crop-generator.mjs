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
  const padding = mode === 'focus' ? focusPadding * 0.5 : focusPadding; // Focus = tighter crop

  const segments = speakerTrack.positions.map(pos => {
    const [x1, y1, x2, y2] = pos.bbox;
    const faceW = x2 - x1;
    const faceH = y2 - y1;
    const faceCx = (x1 + x2) / 2;
    const faceCy = (y1 + y2) / 2;

    // Crop region: face center with padding
    const cropW = faceW * (1 + padding * 2) / zoomLevel;
    const cropH = faceH * (1 + padding * 2) / zoomLevel;

    return {
      start: pos.timestamp,
      end: pos.timestamp + 0.5, // Will be overridden by next segment
      crop_x: faceCx,
      crop_y: faceCy,
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
    return track.positions.map((pos, i, arr) => {
      const [x1, y1, x2, y2] = pos.bbox;
      return {
        start: pos.timestamp,
        end: i < arr.length - 1 ? arr[i + 1].timestamp : pos.timestamp + 0.5,
        crop_x: (x1 + x2) / 2,
        crop_y: (y1 + y2) / 2,
        crop_width: (x2 - x1) * 2,
        crop_height: (y2 - y1) * 2,
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
