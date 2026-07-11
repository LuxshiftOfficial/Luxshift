const express = require('express');
const cors = require('cors');

const app = express();

app.use(cors());
app.use(express.json({ limit: '64kb' }));

const PORT = Number(process.env.PORT || 8787);
const NVIDIA_API_KEY = process.env.NVIDIA_API_KEY;
const NVIDIA_MODEL = process.env.NVIDIA_MODEL || 'meta/llama-3.1-8b-instruct';
const NVIDIA_URL = 'https://integrate.api.nvidia.com/v1/chat/completions';

const allowedTypes = new Set([
  'work',
  'study',
  'break',
  'meal',
  'sleep',
  'exercise',
  'personal',
  'commute',
  'other'
]);

function normalizeTime(value) {
  if (typeof value !== 'string') return null;

  const text = value.trim().toUpperCase();

  const time24 = text.match(/^(\d{1,2}):(\d{2})$/);
  if (time24) {
    const hours = Number(time24[1]);
    const minutes = Number(time24[2]);

    if (hours >= 0 && hours <= 23 && minutes >= 0 && minutes <= 59) {
      return `${String(hours).padStart(2, '0')}:${String(minutes).padStart(2, '0')}`;
    }
  }

  const time12 = text.match(/^(\d{1,2})(?::(\d{2}))?\s*([AP]M)$/);
  if (time12) {
    let hours = Number(time12[1]);
    const minutes = Number(time12[2] || '00');
    const period = time12[3];

    if (hours >= 1 && hours <= 12 && minutes >= 0 && minutes <= 59) {
      if (period === 'AM' && hours === 12) hours = 0;
      if (period === 'PM' && hours !== 12) hours += 12;

      return `${String(hours).padStart(2, '0')}:${String(minutes).padStart(2, '0')}`;
    }
  }

  return null;
}

function timeToMinutes(value) {
  const time = normalizeTime(value);
  if (!time) return null;

  const [hours, minutes] = time.split(':').map(Number);
  return hours * 60 + minutes;
}

function addMinutes(time, minutesToAdd) {
  const start = timeToMinutes(time);
  if (start === null) return null;

  const total = (start + minutesToAdd) % 1440;
  const hours = Math.floor(total / 60);
  const minutes = total % 60;

  return `${String(hours).padStart(2, '0')}:${String(minutes).padStart(2, '0')}`;
}

function defaultEndTime(start, type) {
  const durations = {
    work: 60,
    study: 60,
    break: 20,
    meal: 60,
    sleep: 480,
    exercise: 60,
    personal: 60,
    commute: 30,
    other: 60
  };

  return addMinutes(start, durations[type] || 60);
}

function cleanJson(rawText) {
  if (typeof rawText !== 'string') return null;

  const text = rawText
    .trim()
    .replace(/^```json\s*/i, '')
    .replace(/^```\s*/i, '')
    .replace(/\s*```$/i, '');

  const firstBrace = text.indexOf('{');
  const lastBrace = text.lastIndexOf('}');

  if (firstBrace < 0 || lastBrace <= firstBrace) return null;

  try {
    return JSON.parse(text.slice(firstBrace, lastBrace + 1));
  } catch (_error) {
    return null;
  }
}

function normalizeSchedule(parsed) {
  const rawBlocks = Array.isArray(parsed?.blocks) ? parsed.blocks : [];

  const blocks = rawBlocks
    .map((block) => {
      const type = allowedTypes.has(block?.type) ? block.type : 'other';
      const start = normalizeTime(block?.start);
      const suppliedEnd = normalizeTime(block?.end);

      return {
        title:
          typeof block?.title === 'string' && block.title.trim()
            ? block.title.trim().slice(0, 80)
            : 'Schedule block',
        start,
        end: suppliedEnd || defaultEndTime(start, type),
        type,
        note:
          typeof block?.note === 'string' && block.note.trim()
            ? block.note.trim().slice(0, 180)
            : 'Parsed from your description.',
        confidence: Number.isFinite(Number(block?.confidence))
          ? Math.min(1, Math.max(0, Number(block.confidence)))
          : 0.85
      };
    })
    .filter((block) => block.start || block.end)
    .sort((a, b) => {
      return (timeToMinutes(a.start) ?? 9999) - (timeToMinutes(b.start) ?? 9999);
    })
    .slice(0, 6);

  return {
    summary:
      typeof parsed?.summary === 'string' && parsed.summary.trim()
        ? parsed.summary.trim().slice(0, 160)
        : 'Structured schedule',
    confidence: Number.isFinite(Number(parsed?.confidence))
      ? Math.min(1, Math.max(0, Number(parsed.confidence)))
      : 0.85,
    reasons: Array.isArray(parsed?.reasons)
      ? parsed.reasons
          .filter((reason) => typeof reason === 'string' && reason.trim())
          .map((reason) => reason.trim().slice(0, 180))
          .slice(0, 4)
      : [],
    blocks
  };
}

function buildPrompt(strict = false) {
  return `
You are LuxShift's schedule parser.

Return JSON only. No markdown. No explanation. No code fences.
${strict ? 'The response must begin with { and end with }.' : ''}

Use this exact shape:
{
  "summary": "short summary",
  "confidence": 0.0,
  "reasons": ["short assumption only when needed"],
  "blocks": [
    {
      "title": "string",
      "start": "HH:MM",
      "end": "HH:MM",
      "type": "work|study|break|meal|sleep|exercise|personal|commute|other",
      "note": "short useful sentence",
      "confidence": 0.0
    }
  ]
}

Rules:
- Use 24-hour HH:MM.
- Return 3 to 6 blocks in chronological order.
- Infer reasonable end times when necessary.
- Do not use null values.
`.trim();
}

async function askNvidia(text, strict = false) {
  const response = await fetch(NVIDIA_URL, {
    method: 'POST',
    headers: {
      Authorization: `Bearer ${NVIDIA_API_KEY}`,
      'Content-Type': 'application/json'
    },
    body: JSON.stringify({
      model: NVIDIA_MODEL,
      messages: [
        { role: 'system', content: buildPrompt(strict) },
        { role: 'user', content: text }
      ],
      temperature: 0,
      max_tokens: 650
    })
  });

  const data = await response.json();

  if (!response.ok) {
    throw new Error(
      data?.detail ||
      data?.message ||
      data?.error?.message ||
      `NVIDIA request failed (${response.status})`
    );
  }

  return data?.choices?.[0]?.message?.content || '';
}

app.get('/health', (_req, res) => {
  res.json({
    ok: true,
    model: NVIDIA_MODEL,
    keyConfigured: Boolean(NVIDIA_API_KEY)
  });
});

app.post('/parse-schedule', async (req, res) => {
  try {
    if (!NVIDIA_API_KEY) {
      return res.status(500).json({
        error: 'Missing NVIDIA_API_KEY on server.'
      });
    }

    const text = String(req.body?.text || '').trim();

    if (!text) {
      return res.status(400).json({
        error: 'Missing text.'
      });
    }

    if (text.length > 8000) {
      return res.status(400).json({
        error: 'Schedule text is too long. Please keep it under 8,000 characters.'
      });
    }

    let rawResponse = await askNvidia(text, false);
    let parsed = cleanJson(rawResponse);

    if (!parsed) {
      rawResponse = await askNvidia(text, true);
      parsed = cleanJson(rawResponse);
    }

    if (!parsed) {
      return res.status(502).json({
        error: 'The NVIDIA model did not return valid schedule JSON.'
      });
    }

    const schedule = normalizeSchedule(parsed);

    if (!schedule.blocks.length) {
      schedule.confidence = Math.min(schedule.confidence, 0.3);
      schedule.reasons = schedule.reasons.length
        ? schedule.reasons
        : ['Add clearer times and an ending time to build a timeline.'];
    }

    return res.json(schedule);
  } catch (error) {
    return res.status(500).json({
      error: 'Schedule parsing failed.',
      details: error?.message || 'Unknown server error.'
    });
  }
});

app.listen(PORT, () => {
  console.log(`LuxShift proxy running at http://localhost:${PORT}`);
  console.log(`NVIDIA model: ${NVIDIA_MODEL}`);
});