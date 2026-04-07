// State
let videoInfo = null;
let analysisResult = null;
let currentFrameIdx = 0;
let playInterval = null;

// Elements
const $ = id => document.getElementById(id);

// Range sliders → display values
['sampleFps', 'zoomLevel', 'focusPadding', 'smoothMinCutoff', 'smoothBeta', 'marThreshold'].forEach(id => {
  const el = $(id);
  const valId = {
    sampleFps: 'sampleFpsVal', zoomLevel: 'zoomVal', focusPadding: 'paddingVal',
    smoothMinCutoff: 'minCutoffVal', smoothBeta: 'betaVal', marThreshold: 'marVal',
  }[id];
  el.addEventListener('input', () => {
    $(valId).textContent = parseFloat(el.value).toFixed(el.step.includes('.0') ? 1 : el.step.split('.')[1]?.length || 2);
  });
});

// Upload
$('btnUpload').addEventListener('click', async () => {
  const file = $('videoFile').files[0];
  if (!file) return;

  $('uploadStatus').textContent = 'Enviando...';
  $('uploadStatus').className = 'status';

  const form = new FormData();
  form.append('video', file);

  try {
    const resp = await fetch('/api/upload', { method: 'POST', body: form });
    videoInfo = await resp.json();
    if (videoInfo.error) throw new Error(videoInfo.error);

    $('uploadStatus').textContent = `${videoInfo.width}x${videoInfo.height}, ${videoInfo.duration.toFixed(1)}s, ${videoInfo.fps.toFixed(0)}fps`;
    $('uploadStatus').className = 'status success';
    $('btnAnalyze').disabled = false;

    if (!$('endTime').value) $('endTime').value = Math.min(30, videoInfo.duration).toFixed(0);
  } catch (e) {
    $('uploadStatus').textContent = e.message;
    $('uploadStatus').className = 'status error';
  }
});

// Analyze
$('btnAnalyze').addEventListener('click', async () => {
  if (!videoInfo) return;

  $('analyzeStatus').textContent = 'Analisando faces...';
  $('analyzeStatus').className = 'status';
  $('btnAnalyze').disabled = true;

  try {
    const resp = await fetch('/api/analyze', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        videoPath: videoInfo.path,
        startTime: parseFloat($('startTime').value) || 0,
        endTime: parseFloat($('endTime').value) || 30,
        mode: $('mode').value,
        sampleFps: parseFloat($('sampleFps').value),
        smoothMinCutoff: parseFloat($('smoothMinCutoff').value),
        smoothBeta: parseFloat($('smoothBeta').value),
        marThreshold: parseFloat($('marThreshold').value),
        zoomLevel: parseFloat($('zoomLevel').value),
        focusPadding: parseFloat($('focusPadding').value),
      }),
    });

    analysisResult = await resp.json();
    if (analysisResult.error) throw new Error(analysisResult.error);

    $('analyzeStatus').textContent = `${analysisResult.framesAnalyzed} frames, ${analysisResult.tracksFound} faces tracked`;
    $('analyzeStatus').className = 'status success';
    $('btnReSmooth').disabled = false;

    // Update UI
    updateFacesList();
    updateJsonOutput();
    renderTimeline();
    currentFrameIdx = 0;
    renderFrame();

  } catch (e) {
    $('analyzeStatus').textContent = e.message;
    $('analyzeStatus').className = 'status error';
  } finally {
    $('btnAnalyze').disabled = false;
  }
});

// Re-smooth with new params
$('btnReSmooth').addEventListener('click', async () => {
  // TODO: Call a re-smooth endpoint with updated One Euro params
  $('analyzeStatus').textContent = 'Re-suavização será implementada aqui';
});

// Frame navigation
$('btnPrev').addEventListener('click', () => {
  if (!analysisResult?.raw?.detections) return;
  currentFrameIdx = Math.max(0, currentFrameIdx - 1);
  renderFrame();
});

$('btnNext').addEventListener('click', () => {
  if (!analysisResult?.raw?.detections) return;
  currentFrameIdx = Math.min(analysisResult.raw.detections.length - 1, currentFrameIdx + 1);
  renderFrame();
});

$('btnPlay').addEventListener('click', () => {
  if (playInterval) {
    clearInterval(playInterval);
    playInterval = null;
    $('btnPlay').textContent = '▶ Play';
    return;
  }
  $('btnPlay').textContent = '⏸ Pause';
  playInterval = setInterval(() => {
    if (!analysisResult?.raw?.detections) return;
    currentFrameIdx++;
    if (currentFrameIdx >= analysisResult.raw.detections.length) currentFrameIdx = 0;
    renderFrame();
  }, 500);
});

// Copy JSON
$('btnCopyJson').addEventListener('click', () => {
  if (analysisResult?.cropData) {
    navigator.clipboard.writeText(JSON.stringify(analysisResult.cropData, null, 2));
    $('btnCopyJson').textContent = 'Copiado!';
    setTimeout(() => $('btnCopyJson').textContent = 'Copiar JSON', 2000);
  }
});

// Render frame with face overlay
async function renderFrame() {
  if (!analysisResult?.raw?.detections || !videoInfo) return;

  const det = analysisResult.raw.detections[currentFrameIdx];
  if (!det) return;

  $('frameInfo').textContent = `Frame ${currentFrameIdx + 1}/${analysisResult.raw.detections.length} | ${det.timestamp.toFixed(2)}s | ${det.faces.length} face(s)`;

  // Get frame image
  try {
    const resp = await fetch('/api/preview-frame', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ videoPath: videoInfo.path, timestamp: det.timestamp }),
    });
    const data = await resp.json();
    if (data.error) return;

    const img = new Image();
    img.onload = () => {
      const canvas = $('previewCanvas');
      const area = $('previewArea');
      canvas.width = img.width;
      canvas.height = img.height;
      canvas.style.width = '100%';
      canvas.style.height = 'auto';
      area.querySelector('span')?.remove();

      const ctx = canvas.getContext('2d');
      ctx.drawImage(img, 0, 0);

      // Draw face bounding boxes
      const colors = ['#7c3aed', '#22c55e', '#ef4444', '#f59e0b'];
      det.faces.forEach((face, i) => {
        const [x1, y1, x2, y2] = face.bbox;
        const px1 = x1 * img.width, py1 = y1 * img.height;
        const pw = (x2 - x1) * img.width, ph = (y2 - y1) * img.height;

        ctx.strokeStyle = colors[i % colors.length];
        ctx.lineWidth = 3;
        ctx.strokeRect(px1, py1, pw, ph);

        // Confidence label
        ctx.fillStyle = colors[i % colors.length];
        ctx.font = 'bold 14px Inter, sans-serif';
        ctx.fillText(`${(face.confidence * 100).toFixed(0)}%${face.mar ? ` MAR:${face.mar.toFixed(2)}` : ''}`, px1, py1 - 5);

        // Keypoints
        if (face.landmarks) {
          face.landmarks.forEach(([lx, ly]) => {
            ctx.beginPath();
            ctx.arc(lx * img.width, ly * img.height, 2, 0, Math.PI * 2);
            ctx.fillStyle = '#fff';
            ctx.fill();
          });
        }
      });

      // Draw crop overlay
      if (analysisResult.cropData?.tracks?.length > 0) {
        const track = analysisResult.cropData.tracks[0];
        const seg = track.segments?.find(s => det.timestamp >= s.start && det.timestamp < s.end) || track.segments?.[0];
        if (seg) {
          const cx = seg.crop_x * img.width;
          const cy = seg.crop_y * img.height;
          const cw = (seg.crop_width || 0.4) * img.width;
          const ch = (seg.crop_height || 0.7) * img.height;

          ctx.strokeStyle = '#f59e0b';
          ctx.lineWidth = 2;
          ctx.setLineDash([5, 5]);
          ctx.strokeRect(cx - cw / 2, cy - ch / 2, cw, ch);
          ctx.setLineDash([]);

          // Crosshair at crop center
          ctx.strokeStyle = '#f59e0b';
          ctx.lineWidth = 1;
          ctx.beginPath();
          ctx.moveTo(cx - 10, cy); ctx.lineTo(cx + 10, cy);
          ctx.moveTo(cx, cy - 10); ctx.lineTo(cx, cy + 10);
          ctx.stroke();
        }
      }
    };
    img.src = data.frame;
  } catch (e) {
    console.error('Frame render error:', e);
  }
}

function updateFacesList() {
  if (!analysisResult?.raw?.tracks) return;
  const el = $('facesList');
  const colors = ['#7c3aed', '#22c55e', '#ef4444', '#f59e0b'];
  const speaker = analysisResult.speaker?.speakerId;

  el.innerHTML = analysisResult.raw.tracks.map((track, i) => `
    <div class="face-item">
      <div class="dot" style="background:${colors[i % colors.length]}"></div>
      <div class="info">
        <strong>Face #${track.id}</strong>
        ${track.id === speaker ? ' 🎤 Speaker' : ''}
        <br>${track.positions.length} detections
        ${analysisResult.speaker?.scores?.[track.id] ? ` | score: ${analysisResult.speaker.scores[track.id].toFixed(1)}` : ''}
      </div>
    </div>
  `).join('');
}

function updateJsonOutput() {
  if (!analysisResult?.cropData) return;
  $('jsonOutput').textContent = JSON.stringify(analysisResult.cropData, null, 2);
}

function renderTimeline() {
  if (!analysisResult?.raw?.detections) return;
  const el = $('timeline');
  const dets = analysisResult.raw.detections;
  const minT = dets[0]?.timestamp || 0;
  const maxT = dets[dets.length - 1]?.timestamp || 1;
  const range = maxT - minT || 1;

  const colors = ['#7c3aed', '#22c55e', '#ef4444', '#f59e0b'];

  let html = '';
  dets.forEach((det, i) => {
    const left = ((det.timestamp - minT) / range) * 100;
    det.faces.forEach((face, fi) => {
      const h = face.confidence * 40;
      html += `<div class="bar" style="left:${left}%;width:4px;height:${h}px;bottom:0;top:auto;background:${colors[fi % colors.length]}"></div>`;
    });
  });

  el.innerHTML = html;

  // Click to seek
  el.addEventListener('click', (e) => {
    const rect = el.getBoundingClientRect();
    const pct = (e.clientX - rect.left) / rect.width;
    currentFrameIdx = Math.round(pct * (dets.length - 1));
    renderFrame();
  });
}
