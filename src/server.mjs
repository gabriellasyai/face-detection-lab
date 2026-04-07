import express from 'express';
import multer from 'multer';
import { existsSync, mkdirSync, readFileSync, unlinkSync } from 'fs';
import { join, dirname } from 'path';
import { fileURLToPath } from 'url';
import { execSync } from 'child_process';
import { detectFaces } from './face-detector.mjs';
import { extractLandmarks } from './landmarks.mjs';
import { extractEmbeddings } from './arcface.mjs';
import { trackFaces } from './tracker.mjs';
import { detectSpeaker } from './speaker.mjs';
import { smoothCropTrack } from './smoother.mjs';
import { generateCropData } from './crop-generator.mjs';
import { extractFrames, extractAudioRMS } from './frame-extractor.mjs';

const __dirname = dirname(fileURLToPath(import.meta.url));
const PORT = parseInt(process.env.PORT || '3000');
const UPLOAD_DIR = '/tmp/face-lab-uploads';
const FRAMES_DIR = '/tmp/face-lab-frames';

mkdirSync(UPLOAD_DIR, { recursive: true });
mkdirSync(FRAMES_DIR, { recursive: true });

const app = express();
app.use(express.json());
app.use(express.static(join(__dirname, '..', 'public')));

const upload = multer({ dest: UPLOAD_DIR, limits: { fileSize: 500 * 1024 * 1024 } });

// ── Health ─────────────────────────────────────────────────
app.get('/api/health', (req, res) => {
  res.json({ ok: true, gpu: process.env.NVIDIA_VISIBLE_DEVICES || 'none' });
});

// ── Upload video ───────────────────────────────────────────
app.post('/api/upload', upload.single('video'), (req, res) => {
  if (!req.file) return res.status(400).json({ error: 'No file' });

  // Get video info
  try {
    const info = execSync(
      `ffprobe -v quiet -print_format json -show_format -show_streams "${req.file.path}"`,
      { timeout: 10000 }
    ).toString();
    const parsed = JSON.parse(info);
    const video = parsed.streams?.find(s => s.codec_type === 'video');

    res.json({
      id: req.file.filename,
      path: req.file.path,
      width: video?.width || 0,
      height: video?.height || 0,
      duration: parseFloat(parsed.format?.duration || '0'),
      fps: eval(video?.r_frame_rate || '30') || 30,
    });
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

// ── Analyze: extract frames + detect faces ─────────────────
app.post('/api/analyze', async (req, res) => {
  const {
    videoPath,
    startTime = 0,
    endTime,
    mode = 'auto',         // auto | focus | split2
    sampleFps = 2,         // frames per second to analyze
    // Tuning params
    smoothMinCutoff = 0.05,
    smoothBeta = 0.01,
    marThreshold = 0.35,
    zoomLevel = 1.0,       // 1.0 = normal, 1.5 = tight face crop
    focusPadding = 0.3,    // padding around face (0-1)
  } = req.body;

  if (!videoPath || !existsSync(videoPath)) {
    return res.status(400).json({ error: 'Video not found' });
  }

  try {
    const jobId = Date.now().toString(36);
    const framesDir = join(FRAMES_DIR, jobId);
    mkdirSync(framesDir, { recursive: true });

    // 1. Extract frames
    console.log(`[analyze] Extracting frames: ${startTime}s-${endTime}s @ ${sampleFps}fps`);
    const frames = await extractFrames(videoPath, framesDir, startTime, endTime, sampleFps);
    console.log(`[analyze] Extracted ${frames.length} frames`);

    // 2. Detect faces in all frames
    console.log(`[analyze] Detecting faces...`);
    const detections = [];
    for (const frame of frames) {
      const faces = await detectFaces(frame.path);
      detections.push({ timestamp: frame.timestamp, faces });
    }
    console.log(`[analyze] Detected faces in ${detections.length} frames`);

    // 3. Extract landmarks for faces with detections
    console.log(`[analyze] Extracting landmarks...`);
    for (const det of detections) {
      for (const face of det.faces) {
        face.landmarks = await extractLandmarks(
          detections[0]?.faces[0] ? frames[detections.indexOf(det)].path : null,
          face.bbox
        );
      }
    }

    // 4. Extract embeddings for multi-face tracking (split2 mode)
    if (mode === 'split2' && detections.some(d => d.faces.length >= 2)) {
      console.log(`[analyze] Extracting face embeddings for split2...`);
      for (const det of detections) {
        for (const face of det.faces) {
          face.embedding = await extractEmbeddings(
            frames[detections.indexOf(det)].path,
            face.bbox
          );
        }
      }
    }

    // 5. Track faces across frames
    console.log(`[analyze] Tracking faces...`);
    const tracks = trackFaces(detections);

    // 6. Speaker detection (MAR)
    console.log(`[analyze] Detecting speaker...`);
    const audioRMS = await extractAudioRMS(videoPath, startTime, endTime);
    const speakerInfo = detectSpeaker(tracks, audioRMS, marThreshold);

    // 7. Generate smooth crop data
    console.log(`[analyze] Generating crop data (mode=${mode})...`);
    const cropData = generateCropData(tracks, speakerInfo, {
      mode,
      zoomLevel,
      focusPadding,
      smoothMinCutoff,
      smoothBeta,
    });

    // 8. Smooth the crop tracks
    const smoothed = smoothCropTrack(cropData, { minCutoff: smoothMinCutoff, beta: smoothBeta });

    // Cleanup frames
    try { execSync(`rm -rf "${framesDir}"`); } catch {}

    res.json({
      jobId,
      mode,
      framesAnalyzed: frames.length,
      tracksFound: tracks.length,
      speaker: speakerInfo,
      cropData: smoothed,
      // Raw data for debugging/tuning
      raw: {
        detections: detections.map(d => ({
          timestamp: d.timestamp,
          faces: d.faces.map(f => ({
            bbox: f.bbox,
            confidence: f.confidence,
            landmarks: f.landmarks?.slice(0, 10), // first 10 landmarks for preview
            mar: f.landmarks ? computeMAR(f.landmarks) : null,
          })),
        })),
        tracks,
      },
    });
  } catch (e) {
    console.error('[analyze] Error:', e);
    res.status(500).json({ error: e.message, stack: e.stack });
  }
});

// ── Get a single frame with overlay ────────────────────────
app.post('/api/preview-frame', async (req, res) => {
  const { videoPath, timestamp = 0, cropData, mode = 'auto' } = req.body;

  if (!videoPath || !existsSync(videoPath)) {
    return res.status(400).json({ error: 'Video not found' });
  }

  try {
    const framePath = join(FRAMES_DIR, `preview_${Date.now()}.jpg`);
    execSync(
      `ffmpeg -y -ss ${timestamp} -i "${videoPath}" -vframes 1 -q:v 2 "${framePath}"`,
      { timeout: 10000 }
    );

    const frameData = readFileSync(framePath);
    unlinkSync(framePath);

    res.json({
      frame: `data:image/jpeg;base64,${frameData.toString('base64')}`,
      timestamp,
    });
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

function computeMAR(landmarks) {
  if (!landmarks || landmarks.length < 106) return 0;
  // Mouth landmarks in 2d106det: indices 84-103 (outer lips), 96-103 (inner lips)
  // Simplified MAR: vertical distance / horizontal distance
  const top = landmarks[90];    // upper lip center
  const bottom = landmarks[96]; // lower lip center
  const left = landmarks[84];   // left corner
  const right = landmarks[88];  // right corner
  if (!top || !bottom || !left || !right) return 0;
  const vertical = Math.abs(bottom[1] - top[1]);
  const horizontal = Math.abs(right[0] - left[0]);
  return horizontal > 0 ? vertical / horizontal : 0;
}

// ── Render preview video with crop applied ──────────────────
app.post('/api/render-preview', async (req, res) => {
  const { videoPath, startTime = 0, endTime = 5, cropData, outputFormat = '9:16', mode = 'auto' } = req.body;

  if (!videoPath || !existsSync(videoPath) || !cropData) {
    return res.status(400).json({ error: 'Missing videoPath or cropData' });
  }

  try {
    const outW = outputFormat === '16:9' ? 1920 : 1080;
    const outH = outputFormat === '16:9' ? 1080 : 1920;
    const duration = Math.min(endTime - startTime, 5);
    const outputPath = join(FRAMES_DIR, `preview_${Date.now()}.mp4`);

    const layout = cropData.layout || 'single';
    const track0 = cropData.tracks?.[0];
    const track1 = cropData.tracks?.[1];

    if (!track0?.segments?.length) {
      return res.status(400).json({ error: 'No crop segments' });
    }

    // Use first segment's crop for a simple center crop preview
    const seg = track0.segments[Math.floor(track0.segments.length / 2)];
    const cx = seg.crop_x;
    const cy = seg.crop_y;
    const cw = Math.max(seg.crop_width || 0.3, 0.1);
    const ch = Math.max(seg.crop_height || 0.5, 0.1);

    let filter;
    if (layout === 'split_2' && track1?.segments?.length) {
      const seg1 = track1.segments[Math.floor(track1.segments.length / 2)];
      const cw1 = Math.max(seg1.crop_width || 0.3, 0.1);
      const ch1 = Math.max(seg1.crop_height || 0.5, 0.1);
      // Split: two crops stacked vertically
      filter = `[0:v]split=2[top][bot];` +
        `[top]crop=iw*${cw * 2}:ih*${ch * 2}:iw*${cx - cw}:ih*${cy - ch},scale=${outW}:${outH / 2}[t];` +
        `[bot]crop=iw*${cw1 * 2}:ih*${ch1 * 2}:iw*${seg1.crop_x - cw1}:ih*${seg1.crop_y - ch1},scale=${outW}:${outH / 2}[b];` +
        `[t][b]vstack[out]`;
    } else {
      // Single crop
      filter = `crop=iw*${cw * 2}:ih*${ch * 2}:iw*${Math.max(0, cx - cw)}:ih*${Math.max(0, cy - ch)},scale=${outW}:${outH}`;
    }

    const ffmpegArgs = layout === 'split_2' && track1?.segments?.length
      ? `-y -ss ${startTime} -i "${videoPath}" -t ${duration} -filter_complex "${filter}" -map "[out]" -c:v libx264 -preset ultrafast -crf 23 -an "${outputPath}"`
      : `-y -ss ${startTime} -i "${videoPath}" -t ${duration} -vf "${filter}" -c:v libx264 -preset ultrafast -crf 23 -an "${outputPath}"`;

    execSync(`ffmpeg ${ffmpegArgs}`, { timeout: 30000 });

    // Serve as static file
    const videoData = readFileSync(outputPath);
    const base64 = videoData.toString('base64');
    unlinkSync(outputPath);

    res.json({ videoUrl: `data:video/mp4;base64,${base64}` });
  } catch (e) {
    console.error('[render-preview]', e.message);
    res.status(500).json({ error: e.message });
  }
});

// ── Serve rendered previews as static files ─────────────────
app.use('/renders', express.static(FRAMES_DIR));

app.listen(PORT, '0.0.0.0', () => {
  console.log(`[face-lab] Running on http://0.0.0.0:${PORT}`);
  console.log(`[face-lab] GPU: ${process.env.NVIDIA_VISIBLE_DEVICES || 'CPU mode'}`);
});
