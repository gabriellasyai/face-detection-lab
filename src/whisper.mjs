/**
 * Whisper transcription via Groq API
 * Extracts speech segments with timestamps for speaker correlation
 */

import { execSync } from 'child_process';
import { readFileSync, unlinkSync } from 'fs';

const GROQ_API_KEY = process.env.GROQ_API_KEY || '';

/**
 * Transcribe audio from a video segment using Groq Whisper.
 * @param {string} videoPath
 * @param {number} startTime - seconds
 * @param {number} endTime - seconds
 * @returns {Array<{start: number, end: number, text: string}>} Speech segments with timing relative to startTime
 */
export async function transcribeSegment(videoPath, startTime, endTime) {
  if (!GROQ_API_KEY) {
    console.log('[whisper] No GROQ_API_KEY — skipping transcription');
    return [];
  }

  const duration = endTime - startTime;
  const audioPath = `/tmp/whisper_${Date.now()}.m4a`;

  try {
    // Extract audio segment
    execSync(
      `ffmpeg -y -v quiet -ss ${startTime} -i "${videoPath}" -t ${duration} -vn -c:a aac -b:a 64k "${audioPath}"`,
      { timeout: 30000 }
    );

    // Send to Groq Whisper
    const audioData = readFileSync(audioPath);
    const formData = new FormData();
    formData.append('file', new Blob([audioData], { type: 'audio/m4a' }), 'audio.m4a');
    formData.append('model', 'whisper-large-v3');
    formData.append('response_format', 'verbose_json');
    formData.append('timestamp_granularities[]', 'segment');

    console.log(`[whisper] Transcribing ${duration.toFixed(1)}s of audio...`);
    const resp = await fetch('https://api.groq.com/openai/v1/audio/transcriptions', {
      method: 'POST',
      headers: { 'Authorization': `Bearer ${GROQ_API_KEY}` },
      body: formData,
    });

    if (!resp.ok) {
      const err = await resp.text();
      console.error(`[whisper] Groq error ${resp.status}: ${err.slice(0, 200)}`);
      return [];
    }

    const result = await resp.json();
    const segments = (result.segments || []).map(seg => ({
      start: seg.start,
      end: seg.end,
      text: seg.text?.trim() || '',
    }));

    console.log(`[whisper] Got ${segments.length} segments, ${result.text?.length || 0} chars`);
    return segments;
  } catch (e) {
    console.error('[whisper] Error:', e.message);
    return [];
  } finally {
    try { unlinkSync(audioPath); } catch {}
  }
}
