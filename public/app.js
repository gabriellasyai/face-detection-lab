let videoInfo = null;
let analysisResult = null;
let currentFrameIdx = 0;
let playInterval = null;
let outputFormat = '9:16';

const $ = id => document.getElementById(id);

// Range slider values
['sampleFps','zoomLevel','focusPadding','smoothMinCutoff','smoothBeta','marThreshold','silenceThreshold','silencePadding'].forEach(id => {
  const el = $(id);
  const map = {sampleFps:'sampleFpsVal',zoomLevel:'zoomVal',focusPadding:'paddingVal',smoothMinCutoff:'minCutoffVal',smoothBeta:'betaVal',marThreshold:'marVal',silenceThreshold:'silenceThreshVal',silencePadding:'silencePaddingVal'};
  el.addEventListener('input', () => $(map[id]).textContent = parseFloat(el.value).toFixed(el.step.length > 3 ? 3 : 2));
});

// Format selector
window.setFormat = function(fmt) {
  outputFormat = fmt;
  document.querySelectorAll('.format-btn').forEach(b => b.classList.toggle('active', b.dataset.format === fmt));
  // Update result canvas aspect ratio
  const rc = $('resultCanvas');
  if (fmt === '9:16') { rc.width = 270; rc.height = 480; }
  else { rc.width = 480; rc.height = 270; }
  if (analysisResult) renderResultFrame();
};

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
    $('uploadStatus').textContent = `${videoInfo.width}×${videoInfo.height}, ${videoInfo.duration.toFixed(1)}s`;
    $('uploadStatus').className = 'status success';
    $('btnAnalyze').disabled = false;
    if (!$('endTime').value) $('endTime').value = Math.min(20, videoInfo.duration).toFixed(0);
  } catch (e) {
    $('uploadStatus').textContent = e.message;
    $('uploadStatus').className = 'status error';
  }
});

// Analyze
$('btnAnalyze').addEventListener('click', async () => {
  if (!videoInfo) return;
  $('analyzeStatus').textContent = 'Analisando...';
  $('progressBar').style.display = 'block';
  $('progressFill').style.width = '30%';
  $('btnAnalyze').disabled = true;
  try {
    const resp = await fetch('/api/analyze', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        videoPath: videoInfo.path,
        startTime: parseFloat($('startTime').value) || 0,
        endTime: parseFloat($('endTime').value) || 20,
        mode: $('mode').value,
        outputFormat,
        sampleFps: parseFloat($('sampleFps').value),
        smoothMinCutoff: parseFloat($('smoothMinCutoff').value),
        smoothBeta: parseFloat($('smoothBeta').value),
        marThreshold: parseFloat($('marThreshold').value),
        zoomLevel: parseFloat($('zoomLevel').value),
        focusPadding: parseFloat($('focusPadding').value),
        enableSilenceCut: $('enableSilenceCut').checked,
        silenceThreshold: parseFloat($('silenceThreshold').value),
        silencePadding: parseFloat($('silencePadding').value),
      }),
    });
    $('progressFill').style.width = '80%';
    analysisResult = await resp.json();
    if (analysisResult.error) throw new Error(analysisResult.error);
    $('progressFill').style.width = '100%';
    setTimeout(() => $('progressBar').style.display = 'none', 500);
    $('analyzeStatus').textContent = `${analysisResult.framesAnalyzed} frames, ${analysisResult.tracksFound} faces`;
    $('analyzeStatus').className = 'status success';
    $('btnRender').disabled = false;
    currentFrameIdx = 0;
    updateIndicators();
    updateFacesList();
    updateJsonOutput();
    renderFrame();
    renderResultFrame();
  } catch (e) {
    $('analyzeStatus').textContent = e.message;
    $('analyzeStatus').className = 'status error';
    $('progressBar').style.display = 'none';
  } finally {
    $('btnAnalyze').disabled = false;
  }
});

// Render preview video
$('btnRender').addEventListener('click', async () => {
  if (!videoInfo || !analysisResult) return;
  $('renderStatus').textContent = 'Renderizando preview...';
  $('btnRender').disabled = true;
  try {
    const resp = await fetch('/api/render-preview', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        videoPath: videoInfo.path,
        startTime: parseFloat($('startTime').value) || 0,
        endTime: Math.min((parseFloat($('startTime').value) || 0) + 5, parseFloat($('endTime').value) || 20),
        cropData: analysisResult.cropData,
        outputFormat,
        mode: $('mode').value,
      }),
    });
    const data = await resp.json();
    if (data.error) throw new Error(data.error);
    $('renderedVideo').src = data.videoUrl;
    $('renderedVideo').style.display = 'block';
    $('renderStatus').textContent = 'Preview renderizado!';
    $('renderStatus').className = 'status success';
  } catch (e) {
    $('renderStatus').textContent = e.message;
    $('renderStatus').className = 'status error';
  } finally {
    $('btnRender').disabled = false;
  }
});

// Navigation
$('btnPrev').addEventListener('click', () => { if (analysisResult?.raw?.detections) { currentFrameIdx = Math.max(0, currentFrameIdx - 1); renderFrame(); renderResultFrame(); }});
$('btnNext').addEventListener('click', () => { if (analysisResult?.raw?.detections) { currentFrameIdx = Math.min(analysisResult.raw.detections.length - 1, currentFrameIdx + 1); renderFrame(); renderResultFrame(); }});
$('btnPlay').addEventListener('click', () => {
  if (playInterval) { clearInterval(playInterval); playInterval = null; $('btnPlay').textContent = '▶'; return; }
  $('btnPlay').textContent = '⏸';
  playInterval = setInterval(() => {
    if (!analysisResult?.raw?.detections) return;
    currentFrameIdx = (currentFrameIdx + 1) % analysisResult.raw.detections.length;
    renderFrame(); renderResultFrame();
  }, 400);
});
$('btnCopyJson').addEventListener('click', () => {
  if (analysisResult?.cropData) {
    navigator.clipboard.writeText(JSON.stringify(analysisResult.cropData, null, 2));
    $('btnCopyJson').textContent = '✓ Copiado!';
    setTimeout(() => $('btnCopyJson').textContent = 'Copiar JSON', 1500);
  }
});

// Update quality indicators
function updateIndicators() {
  if (!analysisResult) return;
  const r = analysisResult;
  const dets = r.raw?.detections || [];
  const tracks = r.raw?.tracks || [];

  // Faces count
  const maxFaces = Math.max(...dets.map(d => d.faces.length), 0);
  $('indFaces').textContent = `${tracks.length} tracked (max ${maxFaces}/frame)`;
  setDot('indFaces', tracks.length > 0 ? '#22c55e' : '#ef4444');

  // Average confidence
  const allConf = dets.flatMap(d => d.faces.map(f => f.confidence));
  const avgConf = allConf.length > 0 ? allConf.reduce((a, b) => a + b) / allConf.length : 0;
  $('indConfidence').innerHTML = `${(avgConf * 100).toFixed(0)}% ${badge(avgConf > 0.8 ? 'good' : avgConf > 0.5 ? 'warn' : 'bad', avgConf > 0.8 ? 'Ótimo' : avgConf > 0.5 ? 'OK' : 'Baixo')}`;
  setDot('indConfidence', avgConf > 0.8 ? '#22c55e' : avgConf > 0.5 ? '#fbbf24' : '#ef4444');

  // Stability: how much crop_x varies between consecutive segments
  const cropTrack = r.cropData?.tracks?.[0];
  if (cropTrack?.segments?.length > 1) {
    const diffs = [];
    for (let i = 1; i < cropTrack.segments.length; i++) {
      diffs.push(Math.abs(cropTrack.segments[i].crop_x - cropTrack.segments[i-1].crop_x));
    }
    const avgDiff = diffs.reduce((a, b) => a + b) / diffs.length;
    const stability = Math.max(0, 1 - avgDiff * 20); // 0-1 scale
    $('indStability').innerHTML = `${(stability * 100).toFixed(0)}% ${badge(stability > 0.8 ? 'good' : stability > 0.5 ? 'warn' : 'bad', stability > 0.8 ? 'Estável' : stability > 0.5 ? 'Moderado' : 'Instável')}`;
    setDot('indStability', stability > 0.8 ? '#22c55e' : stability > 0.5 ? '#fbbf24' : '#ef4444');
  }

  // Speaker
  const speaker = r.speaker;
  if (speaker) {
    $('indSpeaker').innerHTML = speaker.speakerId >= 0 ? `Face #${speaker.speakerId} 🎤` : 'Não detectado';
    setDot('indSpeaker', speaker.speakerId >= 0 ? '#22c55e' : '#fbbf24');
  }

  // MAR
  const allMar = dets.flatMap(d => d.faces.filter(f => f.mar).map(f => f.mar));
  const avgMar = allMar.length > 0 ? allMar.reduce((a, b) => a + b) / allMar.length : 0;
  $('indMAR').innerHTML = `${avgMar.toFixed(3)} ${badge(avgMar > 0.2 ? 'good' : 'warn', avgMar > 0.2 ? 'Falando' : 'Quieto')}`;
  setDot('indMAR', avgMar > 0.2 ? '#22c55e' : '#fbbf24');

  // Coverage
  const framesWithFaces = dets.filter(d => d.faces.length > 0).length;
  const coverage = dets.length > 0 ? framesWithFaces / dets.length : 0;
  $('indCoverage').innerHTML = `${(coverage * 100).toFixed(0)}% (${framesWithFaces}/${dets.length}) ${badge(coverage > 0.9 ? 'good' : coverage > 0.7 ? 'warn' : 'bad', coverage > 0.9 ? 'Ótimo' : coverage > 0.7 ? 'OK' : 'Baixo')}`;
  setDot('indCoverage', coverage > 0.9 ? '#22c55e' : coverage > 0.7 ? '#fbbf24' : '#ef4444');

  // Recommended layout
  const layout = r.cropData?.layout || 'single';
  const layoutLabels = { single: 'Single (1 face)', split_2: 'Split 2 (2 faces)' };
  $('indLayout').textContent = layoutLabels[layout] || layout;
  setDot('indLayout', '#7c3aed');

  // Silence
  if (r.silence) {
    const s = r.silence;
    $('indSilence').innerHTML = `${s.gaps} cortes (${s.totalSilence.toFixed(1)}s) ${badge(s.silenceRatio < 0.1 ? 'good' : s.silenceRatio < 0.3 ? 'warn' : 'bad', `${(s.silenceRatio * 100).toFixed(0)}%`)}`;
    setDot('indSilence', s.gaps > 0 ? '#22c55e' : '#71717a');
    $('indNewDuration').textContent = `${s.newDuration.toFixed(1)}s (era ${(s.totalSpeech + s.totalSilence).toFixed(1)}s)`;
    setDot('indNewDuration', '#22c55e');
  } else {
    $('indSilence').textContent = 'Desativado';
    setDot('indSilence', '#71717a');
    $('indNewDuration').textContent = '—';
  }
}

function setDot(valueId, color) {
  const el = $(valueId);
  if (el) el.closest('.indicator')?.querySelector('.dot')?.style.setProperty('background', color);
}
function badge(type, text) { return `<span class="badge ${type}">${text}</span>`; }

function updateFacesList() {
  if (!analysisResult?.raw?.tracks) return;
  const colors = ['#7c3aed', '#22c55e', '#ef4444', '#f59e0b'];
  const speaker = analysisResult.speaker?.speakerId;
  const scores = analysisResult.speaker?.scores || {};
  $('facesList').innerHTML = analysisResult.raw.tracks.map((t, i) => {
    const avgConf = t.positions.reduce((s, p) => s + (p.confidence || 0), 0) / t.positions.length;
    return `<div class="face-card">
      <div class="color-dot" style="background:${colors[i % colors.length]}"></div>
      <div style="flex:1;font-size:12px">
        <strong>Face #${t.id}</strong>${t.id === speaker ? ' 🎤' : ''}
        <br>${t.positions.length} frames | conf ${(avgConf * 100).toFixed(0)}% | score ${(scores[t.id] || 0).toFixed(1)}
      </div>
    </div>`;
  }).join('');
}

function updateJsonOutput() {
  if (!analysisResult?.cropData) return;
  $('jsonOutput').textContent = JSON.stringify(analysisResult.cropData, null, 2);
}

// Render source frame with overlays
async function renderFrame() {
  if (!analysisResult?.raw?.detections || !videoInfo) return;
  const det = analysisResult.raw.detections[currentFrameIdx];
  if (!det) return;
  $('frameInfo').textContent = `${currentFrameIdx + 1}/${analysisResult.raw.detections.length} | ${det.timestamp.toFixed(1)}s | ${det.faces.length} face(s)`;
  try {
    const resp = await fetch('/api/preview-frame', {
      method: 'POST', headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ videoPath: videoInfo.path, timestamp: det.timestamp }),
    });
    const data = await resp.json();
    if (data.error) return;
    const img = new Image();
    img.onload = () => {
      const c = $('previewCanvas');
      c.width = img.width; c.height = img.height;
      const ctx = c.getContext('2d');
      ctx.drawImage(img, 0, 0);
      const colors = ['#7c3aed', '#22c55e', '#ef4444', '#f59e0b'];
      det.faces.forEach((face, i) => {
        const [x1, y1, x2, y2] = face.bbox;
        ctx.strokeStyle = colors[i % colors.length]; ctx.lineWidth = 3;
        ctx.strokeRect(x1 * img.width, y1 * img.height, (x2 - x1) * img.width, (y2 - y1) * img.height);
        ctx.fillStyle = colors[i % colors.length]; ctx.font = 'bold 12px sans-serif';
        ctx.fillText(`${(face.confidence * 100).toFixed(0)}% MAR:${(face.mar || 0).toFixed(2)}`, x1 * img.width, y1 * img.height - 4);
        if (face.landmarks) face.landmarks.forEach(([lx, ly]) => {
          ctx.beginPath(); ctx.arc(lx * img.width, ly * img.height, 1.5, 0, Math.PI * 2); ctx.fillStyle = '#fff'; ctx.fill();
        });
      });
      // Crop overlay
      const track = analysisResult.cropData?.tracks?.[0];
      const seg = track?.segments?.find(s => det.timestamp >= s.start && det.timestamp < s.end);
      if (seg) {
        const cx = seg.crop_x * img.width, cy = seg.crop_y * img.height;
        ctx.strokeStyle = '#f59e0b'; ctx.lineWidth = 2; ctx.setLineDash([4, 4]);
        const cw = (seg.crop_width || 0.3) * img.width, ch = (seg.crop_height || 0.5) * img.height;
        ctx.strokeRect(cx - cw / 2, cy - ch / 2, cw, ch);
        ctx.setLineDash([]);
      }
    };
    img.src = data.frame;
  } catch {}
}

// Render simulated final output
function renderResultFrame() {
  if (!analysisResult?.raw?.detections || !videoInfo) return;
  const det = analysisResult.raw.detections[currentFrameIdx];
  if (!det) return;
  const rc = $('resultCanvas');
  const ctx = rc.getContext('2d');
  const mode = $('mode').value;
  const layout = analysisResult.cropData?.layout;

  // Get source frame from preview canvas
  const sc = $('previewCanvas');
  if (sc.width === 0) return;

  ctx.fillStyle = '#000';
  ctx.fillRect(0, 0, rc.width, rc.height);

  if (layout === 'split_2' && analysisResult.cropData?.tracks?.length >= 2) {
    // Split view: top half = track 0, bottom half = track 1
    const halfH = rc.height / 2;
    [0, 1].forEach(ti => {
      const track = analysisResult.cropData.tracks[ti];
      const seg = track?.segments?.find(s => det.timestamp >= s.start && det.timestamp < s.end) || track?.segments?.[0];
      if (!seg) return;
      const sx = seg.crop_x * sc.width, sy = seg.crop_y * sc.height;
      const sw = Math.max((seg.crop_width || 0.3) * sc.width, 50);
      const sh = Math.max((seg.crop_height || 0.3) * sc.height, 50);
      ctx.drawImage(sc, sx - sw, sy - sh, sw * 2, sh * 2, 0, ti * halfH, rc.width, halfH);
    });
    // Divider
    ctx.fillStyle = '#000'; ctx.fillRect(0, halfH - 1, rc.width, 2);
  } else {
    // Single crop
    const track = analysisResult.cropData?.tracks?.[0];
    const seg = track?.segments?.find(s => det.timestamp >= s.start && det.timestamp < s.end) || track?.segments?.[0];
    if (seg) {
      const sx = seg.crop_x * sc.width, sy = seg.crop_y * sc.height;
      const sw = Math.max((seg.crop_width || 0.3) * sc.width, 50);
      const sh = Math.max((seg.crop_height || 0.5) * sc.height, 50);
      ctx.drawImage(sc, sx - sw, sy - sh, sw * 2, sh * 2, 0, 0, rc.width, rc.height);
    }
  }
}
