/**
 * Silence Detection & Cut
 *
 * Analyzes Whisper transcript segments to find silence gaps > threshold.
 * Generates a cut map that removes dead air and recalculates all timestamps.
 *
 * Reference: "Any pause > 0.8s is marked for cut. Silence in content video is death."
 * After cutting, ALL subsequent timestamps must be recalculated (code, not AI).
 */

/**
 * Detect silence gaps in speech segments.
 * @param {Array<{start: number, end: number, text: string}>} segments - Whisper segments
 * @param {number} threshold - Minimum silence duration to cut (default 0.8s)
 * @param {number} keepPadding - Padding to keep at each side of a cut (default 0.1s)
 * @returns {{
 *   silenceGaps: Array<{start, end, duration}>,
 *   totalSilence: number,
 *   totalSpeech: number,
 *   silenceRatio: number,
 *   cutMap: Array<{originalStart, originalEnd, newStart, newEnd, isCut: boolean}>,
 *   timeMapping: (originalTime: number) => number
 * }}
 */
export function detectSilence(segments, threshold = 0.8, keepPadding = 0.1) {
  if (!segments || segments.length === 0) {
    return {
      silenceGaps: [],
      totalSilence: 0,
      totalSpeech: 0,
      silenceRatio: 0,
      cutMap: [],
      timeMapping: (t) => t,
    };
  }

  // Sort segments by start time
  const sorted = [...segments].sort((a, b) => a.start - b.start);

  // Find gaps between consecutive segments
  const silenceGaps = [];
  for (let i = 0; i < sorted.length - 1; i++) {
    const gapStart = sorted[i].end;
    const gapEnd = sorted[i + 1].start;
    const duration = gapEnd - gapStart;

    if (duration > threshold) {
      // Keep small padding at each edge for natural transitions
      const cutStart = gapStart + keepPadding;
      const cutEnd = gapEnd - keepPadding;
      const cutDuration = cutEnd - cutStart;

      if (cutDuration > 0) {
        silenceGaps.push({
          start: cutStart,
          end: cutEnd,
          duration: cutDuration,
          originalGap: { start: gapStart, end: gapEnd, duration },
        });
      }
    }
  }

  // Calculate totals
  const totalDuration = sorted[sorted.length - 1].end - sorted[0].start;
  const totalSilence = silenceGaps.reduce((sum, g) => sum + g.duration, 0);
  const totalSpeech = totalDuration - totalSilence;

  // Build cut map: ordered list of keep/cut regions
  const cutMap = [];
  let cursor = sorted[0].start;

  for (const gap of silenceGaps) {
    // Keep region before the silence
    if (cursor < gap.start) {
      cutMap.push({
        originalStart: cursor,
        originalEnd: gap.start,
        isCut: false,
      });
    }
    // Cut region (silence)
    cutMap.push({
      originalStart: gap.start,
      originalEnd: gap.end,
      isCut: true,
    });
    cursor = gap.end;
  }
  // Keep region after last silence
  if (cursor < sorted[sorted.length - 1].end) {
    cutMap.push({
      originalStart: cursor,
      originalEnd: sorted[sorted.length - 1].end,
      isCut: false,
    });
  }

  // Calculate new timestamps for kept regions
  let newTime = sorted[0].start; // Start from the original start
  for (const region of cutMap) {
    if (!region.isCut) {
      const duration = region.originalEnd - region.originalStart;
      region.newStart = newTime;
      region.newEnd = newTime + duration;
      newTime += duration;
    } else {
      region.newStart = null;
      region.newEnd = null;
    }
  }

  /**
   * Map an original timestamp to the new timeline (after silence cuts).
   * This is the critical function that prevents subtitle desync.
   * Code does arithmetic, not AI.
   */
  function timeMapping(originalTime) {
    let offset = 0;
    for (const gap of silenceGaps) {
      if (originalTime > gap.end) {
        offset += gap.duration;
      } else if (originalTime > gap.start) {
        // Inside a cut region — snap to the cut boundary
        return gap.start - offset;
      }
    }
    return originalTime - offset;
  }

  return {
    silenceGaps,
    totalSilence,
    totalSpeech,
    silenceRatio: totalDuration > 0 ? totalSilence / totalDuration : 0,
    cutMap,
    timeMapping,
    newDuration: totalDuration - totalSilence,
  };
}

/**
 * Remap transcript segments to new timeline after silence cuts.
 * @param {Array<{start, end, text}>} segments
 * @param {Function} timeMapping - from detectSilence()
 * @returns {Array<{start, end, text, originalStart, originalEnd}>}
 */
export function remapSegments(segments, timeMapping) {
  return segments.map(seg => ({
    ...seg,
    originalStart: seg.start,
    originalEnd: seg.end,
    start: timeMapping(seg.start),
    end: timeMapping(seg.end),
  })).filter(seg => seg.end > seg.start); // Remove segments that were fully inside a cut
}

/**
 * Remap crop track segments to new timeline after silence cuts.
 * @param {object} cropData - { layout, tracks: [{segments: [{start, end, crop_x, ...}]}] }
 * @param {Function} timeMapping
 * @returns {object} Remapped crop data
 */
export function remapCropData(cropData, timeMapping) {
  if (!cropData || !cropData.tracks) return cropData;

  return {
    ...cropData,
    tracks: cropData.tracks.map(track => ({
      ...track,
      segments: track.segments
        .map(seg => ({
          ...seg,
          originalStart: seg.start,
          originalEnd: seg.end,
          start: timeMapping(seg.start),
          end: timeMapping(seg.end),
        }))
        .filter(seg => seg.end > seg.start),
    })),
  };
}
