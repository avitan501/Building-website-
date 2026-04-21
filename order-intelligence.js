const fs = require('fs');
const path = require('path');
const { execFile } = require('child_process');
const { PDFParse } = require('pdf-parse');
const mammoth = require('mammoth');
const Tesseract = require('tesseract.js');

function execFileAsync(command, args) {
  return new Promise((resolve, reject) => {
    execFile(command, args, { maxBuffer: 20 * 1024 * 1024 }, (error, stdout, stderr) => {
      if (error) {
        const details = stderr || stdout || error.message;
        reject(new Error(details.trim() || error.message));
        return;
      }
      resolve({ stdout, stderr });
    });
  });
}

async function runOpenClawJson(args) {
  const { stdout } = await execFileAsync('openclaw', args);
  const text = String(stdout || '').trim();
  if (!text) return {};
  try {
    return JSON.parse(text);
  } catch (error) {
    throw new Error(`Failed to parse OpenClaw JSON output: ${text.slice(0, 400)}`);
  }
}

function ensureFileReadable(filePath) {
  if (!filePath || !fs.existsSync(filePath)) {
    throw new Error(`File not found: ${filePath}`);
  }
  fs.accessSync(filePath, fs.constants.R_OK);
}

function normalizeExtractedText(value) {
  return String(value || '')
    .replace(/\r/g, '')
    .replace(/\n{3,}/g, '\n\n')
    .trim();
}

function normalizeOcrLanguage(value) {
  const language = String(value || '').toLowerCase();
  if (!language) return 'eng+heb';
  if (language === 'he' || language === 'heb' || language === 'hebrew') return 'heb';
  if (language === 'en' || language === 'eng' || language === 'english') return 'eng';
  if (language === 'he+en' || language === 'en+he' || language === 'eng+heb' || language === 'heb+eng') return 'eng+heb';
  return value;
}

async function transcribeAudio(filePath, options = {}) {
  ensureFileReadable(filePath);
  const args = ['infer', 'audio', 'transcribe', '--file', filePath, '--json'];
  if (options.language) args.push('--language', options.language);
  if (options.model) args.push('--model', options.model);
  if (options.prompt) args.push('--prompt', options.prompt);

  const result = await runOpenClawJson(args);
  const firstOutput = Array.isArray(result.outputs) ? result.outputs[0] : null;
  const text = normalizeExtractedText(firstOutput?.text || result.text || '');

  return {
    ok: Boolean(result.ok ?? text),
    kind: firstOutput?.kind || 'audio.transcription',
    path: firstOutput?.path || filePath,
    text,
    raw: result
  };
}

async function describeImage(filePath, options = {}) {
  ensureFileReadable(filePath);
  const language = normalizeOcrLanguage(options.language || 'eng+heb');
  const result = await Tesseract.recognize(filePath, language, {
    cachePath: path.join(__dirname, 'data', 'tesseract-cache'),
    logger: () => {}
  });
  const text = normalizeExtractedText(result?.data?.text || '');

  return {
    ok: Boolean(text),
    kind: 'image.ocr',
    path: filePath,
    text,
    raw: {
      confidence: result?.data?.confidence ?? null
    }
  };
}

async function readTextFile(filePath) {
  ensureFileReadable(filePath);
  const text = normalizeExtractedText(fs.readFileSync(filePath, 'utf8'));
  return {
    ok: true,
    kind: 'text.plain',
    path: filePath,
    text,
    raw: null
  };
}

async function readPdf(filePath) {
  ensureFileReadable(filePath);
  const buffer = fs.readFileSync(filePath);
  const parser = new PDFParse({ data: buffer });
  try {
    const parsed = await parser.getText();
    const text = normalizeExtractedText(parsed.text || '');
    return {
      ok: true,
      kind: 'document.pdf',
      path: filePath,
      text,
      raw: {
        pages: parsed.pages || null,
        info: parsed.info || null
      }
    };
  } finally {
    await parser.destroy().catch(() => {});
  }
}

async function readDocx(filePath) {
  ensureFileReadable(filePath);
  const parsed = await mammoth.extractRawText({ path: filePath });
  const text = normalizeExtractedText(parsed.value || '');
  return {
    ok: true,
    kind: 'document.docx',
    path: filePath,
    text,
    raw: {
      messages: parsed.messages || []
    }
  };
}

async function readDocument(filePath, options = {}) {
  ensureFileReadable(filePath);
  const ext = path.extname(filePath).toLowerCase();
  const mediaType = String(options.mediaType || '').toLowerCase();

  if (['.ogg', '.mp3', '.m4a', '.wav', '.aac', '.flac', '.webm'].includes(ext) || mediaType.startsWith('audio/')) {
    return transcribeAudio(filePath, options);
  }

  if (['.txt', '.md', '.json', '.csv', '.log'].includes(ext)) {
    return readTextFile(filePath);
  }

  if (ext === '.pdf' || mediaType === 'application/pdf') {
    return readPdf(filePath);
  }

  if (ext === '.docx' || mediaType === 'application/vnd.openxmlformats-officedocument.wordprocessingml.document') {
    return readDocx(filePath);
  }

  if (['.png', '.jpg', '.jpeg', '.webp', '.gif'].includes(ext) || mediaType.startsWith('image/')) {
    return describeImage(filePath, options);
  }

  return readTextFile(filePath);
}

module.exports = {
  transcribeAudio,
  describeImage,
  readDocument,
  normalizeExtractedText
};
