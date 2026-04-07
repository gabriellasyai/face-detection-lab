/**
 * One Euro Filter for smooth crop coordinate animation.
 * Adaptive: less jitter when still, less lag when moving fast.
 * Reference: https://gery.casiez.net/1euro/
 */

class OneEuroFilter {
  constructor(freq, minCutoff = 1.0, beta = 0.007, dCutoff = 1.0) {
    this.freq = freq;
    this.minCutoff = minCutoff;
    this.beta = beta;
    this.dCutoff = dCutoff;
    this.xPrev = null;
    this.dxPrev = 0;
    this.tPrev = null;
  }

  alpha(cutoff) {
    const te = 1.0 / this.freq;
    const tau = 1.0 / (2 * Math.PI * cutoff);
    return 1.0 / (1.0 + tau / te);
  }

  filter(x, t) {
    if (this.xPrev === null) {
      this.xPrev = x;
      this.tPrev = t;
      return x;
    }

    const dt = t - this.tPrev;
    if (dt <= 0) return this.xPrev;

    this.freq = 1.0 / dt;

    // Derivative
    const dx = (x - this.xPrev) * this.freq;
    const edx = this.alpha(this.dCutoff) * dx + (1 - this.alpha(this.dCutoff)) * this.dxPrev;
    this.dxPrev = edx;

    // Adaptive cutoff
    const cutoff = this.minCutoff + this.beta * Math.abs(edx);

    // Filtered value
    const filtered = this.alpha(cutoff) * x + (1 - this.alpha(cutoff)) * this.xPrev;
    this.xPrev = filtered;
    this.tPrev = t;

    return filtered;
  }
}

/**
 * Smooth crop track data using One Euro Filter.
 * @param {object} cropData - { tracks: [{player_index, segments: [{start, end, crop_x, crop_y, ...}]}], layout }
 * @param {object} opts - { minCutoff, beta }
 * @returns {object} Smoothed crop data
 */
export function smoothCropTrack(cropData, opts = {}) {
  if (!cropData || !cropData.tracks) return cropData;

  const { minCutoff = 0.05, beta = 0.01 } = opts;

  const smoothed = {
    ...cropData,
    tracks: cropData.tracks.map(track => {
      if (!track.segments || track.segments.length < 2) return track;

      const filterX = new OneEuroFilter(2, minCutoff, beta);
      const filterY = new OneEuroFilter(2, minCutoff, beta);

      const smoothedSegments = track.segments.map(seg => ({
        ...seg,
        crop_x: filterX.filter(seg.crop_x, seg.start),
        crop_y: filterY.filter(seg.crop_y, seg.start),
      }));

      return { ...track, segments: smoothedSegments };
    }),
  };

  return smoothed;
}
