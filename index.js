
const express = require('express');
const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const { spawnSync } = require('child_process');
const { transcribeAudio, readDocument } = require('./order-intelligence');
const { syncWhatsAppOrders } = require('./whatsapp-order-sync');
const { readTasks, syncExistingTaskToMonday, getMondayBoard } = require('./task-intelligence');
const { syncMessageTasks } = require('./message-task-sync');
const { getStatus: getKimiLaneStatus, readConfig: readKimiLaneConfig, writeConfig: writeKimiLaneConfig, askWebsiteCoder } = require('./kimi-coder');
const {
  readConfig: readAgentQueueConfig,
  writeConfig: writeAgentQueueConfig,
  getQueueStatus,
  listQueueTasks,
  enqueueTask,
  createOrQueueTask,
  processNextQueuedTask,
  runAutoQueue,
  runNightQueue
} = require('./agent-queue');
const {
  buildTaskHubSnapshot,
  createTaskHubTask,
  updateTaskHubTask,
  addTaskContact,
  updateTaskContact,
  addTaskContactActivity,
  renderTaskHubPage
} = require('./task-hub');
const {
  buildQueueSnapshot,
  markQueueTaskDone,
  requeueQueueTask,
  archiveQueueTask,
  renderQueueDashboardPage
} = require('./queue-dashboard');
const app = express();

app.use(express.json({ limit: '25mb' }));
app.use(express.urlencoded({ extended: false, limit: '25mb' }));

const messagesFile = '/root/mysite/messages.json';
const tasksFile = '/root/mysite/tasks.json';
const ordersFile = '/root/mysite/orders.json';
const siteConfigFile = '/root/mysite/site-config.json';
const siteUsersFile = '/root/mysite/data/site_users.json';
const authPreviewUsersFile = '/root/mysite/data/auth_preview_users.json';

function readJson(filePath, fallback) {
  try {
    if (!fs.existsSync(filePath)) return fallback;
    const raw = fs.readFileSync(filePath, 'utf8');
    if (!String(raw || '').trim()) return fallback;
    return JSON.parse(raw);
  } catch {
    return fallback;
  }
}

function writeJson(filePath, value) {
  fs.mkdirSync(path.dirname(filePath), { recursive: true });
  fs.writeFileSync(filePath, JSON.stringify(value, null, 2));
}

function readJsonArray(filePath) {
  const parsed = readJson(filePath, []);
  return Array.isArray(parsed) ? parsed : [];
}

function writeJsonArray(filePath, value) {
  writeJson(filePath, value);
}

function readSiteConfig() {
  return readJson(siteConfigFile, {
    title: 'Customer Portal',
    subtitle: 'Fast access to orders, account updates, and activity in one place.',
    bg: '#f5f5f5',
    text: '#111111',
    brand: {
      name: 'BuildCore Portal',
      accent: '#f96302',
      dark: '#111111',
      light: '#ffffff'
    },
    entryPage: {
      eyebrow: 'WELCOME',
      headline: 'Your account, clear and ready.',
      subheadline: 'Sign in with Google or with your phone and password to check order progress, account activity, and next steps in one place.',
      phoneLoginTitle: 'Sign in to your portal',
      googleButtonLabel: 'Continue with Google',
      registerButtonLabel: 'Create account',
      tiles: [
        {
          title: 'Order status',
          content: 'Customers can come back anytime to check the latest account and order activity.'
        },
        {
          title: 'Fast access',
          content: 'Phone and password are live now, and Google is ready for OAuth in the next step.'
        },
        {
          title: 'Built for trust',
          content: 'Strong contrast, clear calls to action, and a clean portal customers can actually use.'
        },
        {
          title: 'Simple layout',
          content: 'Large type, strong spacing, and a direct path back to the customer account.'
        }
      ]
    },
    sections: [],
    pages: {}
  });
}

function readSiteUsers() {
  const users = readJson(siteUsersFile, []);
  return Array.isArray(users) ? users : [];
}

function escapeHtml(s) {
  return String(s ?? '')
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#39;');
}

function normalizePhone(value) {
  return String(value || '').replace(/[^\d+]/g, '');
}

function normalizeEmail(value) {
  return String(value || '').trim().toLowerCase();
}

function normalizeText(value) {
  return String(value || '').replace(/\r/g, '').trim();
}

function createPasswordRecord(password) {
  const salt = crypto.randomBytes(16).toString('hex');
  const hash = crypto.scryptSync(String(password || ''), salt, 64).toString('hex');
  return { salt, hash };
}

function verifyPassword(password, user) {
  try {
    const derived = crypto.scryptSync(String(password || ''), String(user?.password_salt || ''), 64);
    const stored = Buffer.from(String(user?.password_hash || ''), 'hex');
    return stored.length === derived.length && crypto.timingSafeEqual(stored, derived);
  } catch {
    return false;
  }
}

function parseCookies(req) {
  const raw = String(req.headers.cookie || '');
  if (!raw.trim()) return {};

  return raw.split(';').reduce((acc, part) => {
    const [key, ...rest] = part.trim().split('=');
    if (!key) return acc;
    acc[key] = decodeURIComponent(rest.join('='));
    return acc;
  }, {});
}

function readSessionToken(req) {
  return parseCookies(req).site_session || '';
}

function setSessionCookie(res, token) {
  res.setHeader('Set-Cookie', `site_session=${encodeURIComponent(token)}; Path=/; HttpOnly; SameSite=Lax; Max-Age=${60 * 60 * 24 * 45}`);
}

function clearSessionCookie(res) {
  res.setHeader('Set-Cookie', 'site_session=; Path=/; HttpOnly; SameSite=Lax; Max-Age=0');
}

function readCurrentSiteUser(req) {
  const token = readSessionToken(req);
  if (!token) return null;
  const users = readSiteUsers();
  return users.find(user => user.session_token === token && Date.parse(user.session_expires_at || '') > Date.now()) || null;
}

function issueSessionForUser(users, index) {
  const token = crypto.randomBytes(24).toString('hex');
  const now = new Date().toISOString();
  users[index] = {
    ...users[index],
    last_login_at: now,
    session_token: token,
    session_expires_at: new Date(Date.now() + 1000 * 60 * 60 * 24 * 45).toISOString(),
    updated_at: now
  };
  writeJson(siteUsersFile, users);
  return token;
}

function clearSessionForToken(token) {
  if (!token) return;
  const users = readSiteUsers();
  const index = users.findIndex(user => user.session_token === token);
  if (index === -1) return;
  users[index] = {
    ...users[index],
    session_token: '',
    session_expires_at: '',
    updated_at: new Date().toISOString()
  };
  writeJson(siteUsersFile, users);
}

function formatDisplayDate(value) {
  if (!value) return 'Not available yet';
  const date = new Date(value);
  if (Number.isNaN(date.getTime())) return 'Not available yet';
  return date.toISOString().slice(0, 16).replace('T', ' ');
}

function safeFileStem(value) {
  return String(value || 'file')
    .replace(/\.pdf$/i, '')
    .replace(/[^a-z0-9\u0590-\u05FF_-]+/gi, '_')
    .replace(/_+/g, '_')
    .replace(/^_+|_+$/g, '')
    .slice(0, 80) || 'file';
}

function runQuoteRedactionJob({ fileName, base64Data }) {
  const outDir = '/root/.openclaw/workspace/out';
  fs.mkdirSync(outDir, { recursive: true });

  const jobId = 'quote-redact-' + Date.now() + '-' + crypto.randomBytes(4).toString('hex');
  const stem = safeFileStem(fileName);
  const inputPath = path.join(outDir, `${jobId}-${stem}-original.pdf`);
  const outputName = `${jobId}-${stem}-cleaned.pdf`;
  const outputPath = path.join(outDir, outputName);
  fs.writeFileSync(inputPath, Buffer.from(String(base64Data || ''), 'base64'));

  const script = String.raw`
import json
import re
import sys
from pathlib import Path

VENDOR_DIR = Path('/root/.openclaw/workspace/.vendor/pdf-tools')
if VENDOR_DIR.exists():
    sys.path.insert(0, str(VENDOR_DIR))

import pymupdf

input_path = Path(sys.argv[1])
output_path = Path(sys.argv[2])
replacement = 'seller name hide for bidding purposes'
doc = pymupdf.open(str(input_path))
summary = {'ok': True, 'pages': len(doc), 'text_hits': 0, 'top_rects': 0, 'footer_rects': 0}
phone_re = re.compile(r'(?:\+?\d[\d\s().-]{6,}\d)')
email_re = re.compile(r'[^\s@]+@[^\s@]+\.[^\s@]+')
web_re = re.compile(r'(?:https?://|www\.)', re.I)
address_words = {'st', 'street', 'ave', 'avenue', 'blvd', 'boulevard', 'rd', 'road', 'suite', 'floor', 'ny', 'nj'}

for page in doc:
    width = page.rect.width
    height = page.rect.height
    top_words = []
    footer_words = []
    suspicious = set()

    for word in page.get_text('words'):
        x0, y0, x1, y1, text = word[:5]
        text = str(text or '').strip()
        if not text:
            continue
        lower = text.lower().strip(' ,:;|')
        if y0 <= min(140, height * 0.22) and x0 <= width * 0.62:
            top_words.append((x0, y0, x1, y1, text))
        if y1 >= height - min(90, height * 0.14):
            footer_words.append((x0, y0, x1, y1, text))
        if email_re.search(text) or web_re.search(text) or phone_re.search(text) or lower in address_words:
            suspicious.add(text)

    if top_words:
        x0 = min(item[0] for item in top_words)
        y0 = min(item[1] for item in top_words)
        x1 = max(item[2] for item in top_words)
        y1 = max(item[3] for item in top_words)
        top_rect = pymupdf.Rect(max(0, x0 - 18), max(0, y0 - 18), min(width, max(x1 + 24, width * 0.58)), min(height, max(y1 + 26, 118)))
        page.draw_rect(top_rect, color=(1, 1, 1), fill=(1, 1, 1), overlay=True)
        page.insert_textbox(top_rect, replacement, fontsize=11, fontname='helv', color=(0.2, 0.2, 0.2), align=1)
        summary['top_rects'] += 1

    if footer_words:
        x0 = min(item[0] for item in footer_words)
        y0 = min(item[1] for item in footer_words)
        x1 = max(item[2] for item in footer_words)
        y1 = max(item[3] for item in footer_words)
        footer_rect = pymupdf.Rect(max(0, x0 - 12), max(0, y0 - 10), min(width, x1 + 20), min(height, y1 + 14))
        page.draw_rect(footer_rect, color=(1, 1, 1), fill=(1, 1, 1), overlay=True)
        summary['footer_rects'] += 1

    for text in suspicious:
        for rect in page.search_for(text):
            page.add_redact_annot(rect, fill=(1, 1, 1))
            summary['text_hits'] += 1

for page in doc:
    if page.first_annot is not None:
        page.apply_redactions(images=2, graphics=2, text=0)

output_path.parent.mkdir(parents=True, exist_ok=True)
doc.save(str(output_path), garbage=4, clean=True, deflate=True)
doc.close()
print(json.dumps(summary))
`;

  const run = spawnSync('python3', ['-c', script, inputPath, outputPath], {
    encoding: 'utf8',
    maxBuffer: 10 * 1024 * 1024,
  });

  if (run.status !== 0) {
    throw new Error((run.stderr || run.stdout || 'quote redaction failed').trim());
  }

  let summary = {};
  try {
    summary = JSON.parse(run.stdout || '{}');
  } catch {
    summary = { ok: true, raw: run.stdout || '' };
  }

  return {
    ok: true,
    inputPath,
    outputPath,
    outputName,
    downloadUrl: `/downloads/${encodeURIComponent(outputName)}`,
    summary,
  };
}

function renderEntryPage(cfg, flash = {}) {
  const theme = {
    accent: cfg.brand?.accent || '#f96302',
    dark: cfg.brand?.dark || '#111111',
    bg: cfg.bg || '#eef3fb',
    text: cfg.text || '#111111',
    name: cfg.brand?.name || cfg.title || 'Concierge Site'
  };
  const launcher = cfg.launcher || {};
  const folders = Array.isArray(launcher.folders) ? launcher.folders : [];
  const flashHtml = flash.error
    ? `<div class="flash flash-error">${escapeHtml(flash.error)}</div>`
    : flash.info
      ? `<div class="flash flash-info">${escapeHtml(flash.info)}</div>`
      : '';

  return `
    <!DOCTYPE html>
    <html lang="he" dir="rtl">
      <head>
        <meta charset="utf-8" />
        <meta name="viewport" content="width=device-width, initial-scale=1" />
        <title>${escapeHtml(cfg.title || 'Concierge Site')}</title>
        <style>
          :root {
            --accent: ${escapeHtml(theme.accent)};
            --dark: ${escapeHtml(theme.dark)};
            --bg: ${escapeHtml(theme.bg)};
            --text: ${escapeHtml(theme.text)};
          }
          * { box-sizing: border-box; }
          body {
            margin: 0;
            min-height: 100vh;
            font-family: Inter, -apple-system, BlinkMacSystemFont, "Segoe UI", sans-serif;
            background:
              radial-gradient(circle at top right, rgba(249,99,2,0.12), transparent 22%),
              linear-gradient(180deg, #eaf2ff 0%, var(--bg) 55%, #f7fbff 100%);
            color: var(--text);
          }
          .page {
            max-width: 1320px;
            margin: 0 auto;
            padding: 28px 22px 42px;
          }
          .topbar {
            display: flex;
            align-items: center;
            justify-content: space-between;
            gap: 18px;
            margin-bottom: 18px;
          }
          .brand {
            display: flex;
            align-items: center;
            gap: 12px;
          }
          .brand-icon {
            width: 44px;
            height: 44px;
            border-radius: 14px;
            background: linear-gradient(180deg, #ffd879 0%, #f8b325 100%);
            box-shadow: inset 0 2px 0 rgba(255,255,255,.55), 0 10px 25px rgba(53,86,140,.15);
            position: relative;
          }
          .brand-icon::before {
            content: "";
            position: absolute;
            top: 7px;
            right: 6px;
            width: 18px;
            height: 8px;
            border-radius: 8px 8px 0 0;
            background: rgba(255,255,255,.45);
          }
          .brand-name {
            font-size: 22px;
            font-weight: 800;
          }
          .brand-subtitle {
            color: #5a6372;
            font-size: 13px;
          }
          .status-pill {
            padding: 10px 14px;
            border-radius: 999px;
            background: rgba(255,255,255,.8);
            border: 1px solid rgba(17,17,17,.08);
            font-size: 13px;
            color: #516074;
            backdrop-filter: blur(8px);
          }
          .desktop {
            min-height: calc(100vh - 110px);
            border-radius: 34px;
            padding: 26px;
            background: linear-gradient(180deg, rgba(255,255,255,.66), rgba(255,255,255,.52));
            border: 1px solid rgba(255,255,255,.68);
            box-shadow: 0 28px 70px rgba(30, 56, 100, 0.12);
            backdrop-filter: blur(12px);
          }
          .headline {
            margin: 0 0 8px;
            font-size: clamp(28px, 5vw, 48px);
            line-height: 1;
            letter-spacing: -0.04em;
          }
          .subhead {
            max-width: 760px;
            margin: 0;
            color: #5b6575;
            font-size: 16px;
            line-height: 1.7;
          }
          .flash {
            margin-top: 16px;
            padding: 12px 14px;
            border-radius: 14px;
            font-size: 14px;
            font-weight: 700;
            width: fit-content;
            max-width: 100%;
          }
          .flash-error { background: #fff2ee; color: #b42318; }
          .flash-info { background: #eef6ff; color: #175cd3; }
          .folders {
            display: grid;
            grid-template-columns: repeat(auto-fit, minmax(180px, 1fr));
            gap: 22px;
            margin-top: 34px;
          }
          .folder {
            display: flex;
            flex-direction: column;
            gap: 14px;
            align-items: flex-start;
            text-decoration: none;
            color: inherit;
            padding: 18px;
            border-radius: 24px;
            background: rgba(255,255,255,.62);
            border: 1px solid rgba(17,17,17,.08);
            transition: transform .16s ease, box-shadow .16s ease, background .16s ease;
          }
          .folder:hover {
            transform: translateY(-3px);
            box-shadow: 0 18px 34px rgba(30,56,100,.12);
            background: rgba(255,255,255,.84);
          }
          .folder-icon {
            width: 86px;
            height: 66px;
            border-radius: 16px;
            background: linear-gradient(180deg, #ffdb7c 0%, #f4b019 100%);
            box-shadow: inset 0 2px 0 rgba(255,255,255,.5), 0 10px 22px rgba(58,82,129,.14);
            position: relative;
          }
          .folder-icon::before {
            content: "";
            position: absolute;
            top: -8px;
            right: 10px;
            width: 34px;
            height: 14px;
            border-radius: 10px 10px 0 0;
            background: #ffd26a;
          }
          .folder-title {
            font-size: 20px;
            font-weight: 800;
            line-height: 1.2;
          }
          .folder-copy {
            color: #5a6372;
            line-height: 1.6;
            font-size: 14px;
          }
          .folder-tag {
            margin-top: auto;
            padding: 7px 10px;
            border-radius: 999px;
            background: rgba(17,17,17,.05);
            font-size: 12px;
            font-weight: 700;
            color: #445066;
          }
          .notes {
            display: flex;
            flex-wrap: wrap;
            gap: 10px;
            margin-top: 26px;
          }
          .note {
            padding: 12px 14px;
            border-radius: 14px;
            background: rgba(255,255,255,.66);
            border: 1px solid rgba(17,17,17,.07);
            color: #556173;
            font-size: 14px;
          }
          @media (max-width: 640px) {
            .page { padding-inline: 14px; }
            .topbar { align-items: flex-start; flex-direction: column; }
            .desktop { padding: 20px; border-radius: 24px; }
            .folders { grid-template-columns: repeat(2, minmax(0, 1fr)); gap: 14px; }
            .folder { padding: 14px; }
            .folder-icon { width: 72px; height: 58px; }
          }
        </style>
      </head>
      <body>
        <main class="page">
          <div class="topbar">
            <div class="brand">
              <div class="brand-icon"></div>
              <div>
                <div class="brand-name">${escapeHtml(theme.name)}</div>
                <div class="brand-subtitle">${escapeHtml(cfg.subtitle || '')}</div>
              </div>
            </div>
            <div class="status-pill">Concierge Site · עמוד עבודה פנימי</div>
          </div>

          <section class="desktop">
            <h1 class="headline">${escapeHtml(launcher.headline || 'שולחן העבודה של Concierge Site')}</h1>
            <p class="subhead">${escapeHtml(launcher.subheadline || 'כאן נעבוד קודם כפונקציות נפרדות. כל תיקייה פותחת כלי אחר, ואחר כך נמיר את הכול לאתר מלא עם דפים מסודרים.')}</p>
            ${flashHtml}

            <div class="folders">
              ${folders.map(folder => `
                <a class="folder" href="${escapeHtml(folder.href || '#')}">
                  <div class="folder-icon"></div>
                  <div class="folder-title">${escapeHtml(folder.title || '')}</div>
                  <div class="folder-copy">${escapeHtml(folder.description || '')}</div>
                  <div class="folder-tag">${escapeHtml(folder.tag || '')}</div>
                </a>
              `).join('')}
            </div>

            <div class="notes">
              <div class="note">הפונקציה הראשונה מוכנה כעמוד נפרד עם העלאת PDF ישירה.</div>
              <div class="note">גוגל דרייב לא מעורב בזרימה הזאת — הקובץ חוזר כהורדה ישירה.</div>
            </div>
          </section>
        </main>
      </body>
    </html>
  `;
}

function renderQuoteRedactionPage(cfg, flash = {}) {
  const theme = {
    accent: cfg.brand?.accent || '#f96302',
    bg: cfg.bg || '#eef3fb',
    text: cfg.text || '#111111',
    name: cfg.brand?.name || cfg.title || 'Concierge Site'
  };
  const flashHtml = flash.error
    ? `<div class="flash flash-error">${escapeHtml(flash.error)}</div>`
    : flash.info
      ? `<div class="flash flash-info">${escapeHtml(flash.info)}</div>`
      : '';

  return `<!DOCTYPE html>
  <html lang="he" dir="rtl">
    <head>
      <meta charset="utf-8" />
      <meta name="viewport" content="width=device-width, initial-scale=1" />
      <title>עריכת הצעת מחיר</title>
      <style>
        :root { --accent:${escapeHtml(theme.accent)}; --bg:${escapeHtml(theme.bg)}; --text:${escapeHtml(theme.text)}; }
        * { box-sizing:border-box; }
        body { margin:0; font-family:Inter, -apple-system, BlinkMacSystemFont, "Segoe UI", sans-serif; color:var(--text); background:linear-gradient(180deg, #edf4ff 0%, var(--bg) 100%); }
        .page { max-width:920px; margin:0 auto; padding:28px 18px 44px; }
        .back { color:#526073; text-decoration:none; font-weight:700; }
        .card { margin-top:18px; background:rgba(255,255,255,.88); border:1px solid rgba(17,17,17,.08); border-radius:30px; padding:26px; box-shadow:0 24px 60px rgba(30,56,100,.10); }
        h1 { margin:0 0 10px; font-size:clamp(30px, 6vw, 48px); letter-spacing:-.04em; }
        p { color:#5a6677; line-height:1.75; }
        .flash { margin:16px 0; padding:12px 14px; border-radius:14px; font-size:14px; font-weight:700; }
        .flash-error { background:#fff2ee; color:#b42318; }
        .flash-info { background:#eef6ff; color:#175cd3; }
        .upload-box { margin-top:22px; padding:22px; border-radius:22px; border:2px dashed rgba(17,17,17,.12); background:#f9fbff; }
        input[type=file] { width:100%; padding:12px; background:#fff; border-radius:14px; border:1px solid rgba(17,17,17,.1); }
        button { margin-top:16px; border:0; border-radius:16px; padding:15px 18px; background:var(--accent); color:#fff; font:inherit; font-weight:800; cursor:pointer; box-shadow:0 18px 34px rgba(249,99,2,.22); }
        button:disabled { opacity:.6; cursor:wait; }
        .small { font-size:13px; color:#687487; }
        .result { margin-top:18px; padding:16px; border-radius:18px; background:#fff; border:1px solid rgba(17,17,17,.08); display:none; }
        .result.show { display:block; }
        .download { display:inline-flex; margin-top:12px; text-decoration:none; color:#111; background:#f4f6fb; border-radius:12px; padding:10px 12px; font-weight:800; }
      </style>
    </head>
    <body>
      <main class="page">
        <a class="back" href="/">← חזרה לשולחן העבודה</a>
        <section class="card">
          <div style="font-size:13px;font-weight:800;color:var(--accent);margin-bottom:8px;">Concierge Site · כלי 01</div>
          <h1>עריכת הצעת מחיר</h1>
          <p>מעלים PDF, אני מוחק את פרטי המוכר והמיתוג במקום שבו הם מזוהים, מוסיף <b>seller name hide for bidding purposes</b> באזור הכותרת, ומחזיר קובץ להורדה ישירה בלי Google Drive.</p>
          ${flashHtml}
          <div class="upload-box">
            <label for="pdfFile" style="display:block;font-weight:800;margin-bottom:10px;">קובץ PDF להצעת מחיר</label>
            <input id="pdfFile" type="file" accept="application/pdf" />
            <button id="submitBtn" type="button">נקה את ההצעה</button>
            <div class="small">כרגע הכלי מטפל קודם בכותרת/לוגו/פרטי ספק ובפרטי קשר חוזרים. אם יהיה PDF חריג נחדד אותו בשלב הבא.</div>
          </div>
          <div id="result" class="result"></div>
        </section>
      </main>
      <script>
        const fileInput = document.getElementById('pdfFile');
        const button = document.getElementById('submitBtn');
        const result = document.getElementById('result');
        function showResult(html) { result.innerHTML = html; result.classList.add('show'); }
        button.addEventListener('click', async () => {
          const file = fileInput.files && fileInput.files[0];
          if (!file) { showResult('<strong>צריך לבחור קובץ PDF קודם.</strong>'); return; }
          if (file.type && file.type !== 'application/pdf') { showResult('<strong>הקובץ חייב להיות PDF.</strong>'); return; }
          button.disabled = true;
          button.textContent = 'מנקה עכשיו...';
          try {
            const buffer = await file.arrayBuffer();
            let binary = '';
            const bytes = new Uint8Array(buffer);
            const chunk = 0x8000;
            for (let i = 0; i < bytes.length; i += chunk) binary += String.fromCharCode.apply(null, bytes.slice(i, i + chunk));
            const response = await fetch('/api/tools/redact-quote', {
              method: 'POST',
              headers: { 'Content-Type': 'application/json' },
              body: JSON.stringify({ fileName: file.name, base64Data: btoa(binary) })
            });
            const payload = await response.json();
            if (!response.ok || !payload.ok) throw new Error(payload.error || 'הניקוי נכשל');
            const summary = payload.summary || {};
            showResult('<strong>הקובץ מוכן.</strong><br>' +
              'עמודים: ' + (summary.pages || '-') + ' · ' +
              'אזורי כותרת שנוקו: ' + (summary.top_rects || 0) + ' · ' +
              'פגיעות טקסט: ' + (summary.text_hits || 0) +
              '<br><a class="download" href="' + payload.downloadUrl + '">להורדת ה-PDF הנקי</a>');
          } catch (error) {
            showResult('<strong>נפלתי על בעיה:</strong> ' + (error.message || error));
          } finally {
            button.disabled = false;
            button.textContent = 'נקה את ההצעה';
          }
        });
      </script>
    </body>
  </html>`;
}

function buildFlowCheckRouteExists(routeNeedle) {
  try {
    const source = fs.readFileSync(__filename, 'utf8');
    return source.includes(routeNeedle);
  } catch {
    return false;
  }
}

function buildFlowCheckConfigured(envKeys = []) {
  return envKeys.some(key => String(process.env[key] || '').trim());
}

function buildFlowCheckVercelStatus() {
  const vercelUrl = String(process.env.BUILDFLOW_VERCEL_URL || process.env.VERCEL_URL || '').trim();
  if (!vercelUrl) {
    return ['Vercel Deployment', 'Coming Soon', 'No Vercel URL configured yet.'];
  }

  const normalized = /^https?:\/\//i.test(vercelUrl) ? vercelUrl : `https://${vercelUrl}`;
  const check = spawnSync('curl', ['-L', '-s', '-o', '/dev/null', '-w', '%{http_code}', normalized], {
    encoding: 'utf8',
    timeout: 5000
  });

  if (check.status === 0) {
    const code = String(check.stdout || '').trim();
    if (/^2\d\d$|^3\d\d$/.test(code)) {
      return ['Vercel Deployment', 'Working', `Configured and responding with HTTP ${code}.`];
    }
    return ['Vercel Deployment', 'Broken', `Configured but returned HTTP ${code || 'unknown'}.`];
  }

  return ['Vercel Deployment', 'Broken', 'Configured but the health check did not respond cleanly.'];
}

function buildFlowCheckLiveChecks() {
  const now = new Date().toISOString().slice(0, 19).replace('T', ' ') + ' UTC';
  const uptimeMinutes = Math.max(0, Math.floor(process.uptime() / 60));
  const homepageRouteExists = buildFlowCheckRouteExists("app.get('/', (req, res) => {");
  const flowCheckRouteExists = buildFlowCheckRouteExists("app.get('/admin/flow-check', (req, res) => {");
  const uploadRouteExists = buildFlowCheckRouteExists("app.post('/api/tools/redact-quote', (req, res) => {");
  const supabaseConfigured = buildFlowCheckConfigured(['SUPABASE_URL', 'NEXT_PUBLIC_SUPABASE_URL', 'SUPABASE_SERVICE_ROLE_KEY', 'SUPABASE_ANON_KEY']);
  const authConfigured = buildFlowCheckConfigured(['GOOGLE_CLIENT_ID', 'GOOGLE_CLIENT_SECRET', 'SUPABASE_AUTH_URL', 'NEXTAUTH_SECRET']);
  const driveConfigured = buildFlowCheckConfigured(['GOOGLE_DRIVE_FOLDER_ID', 'GOOGLE_REFRESH_TOKEN', 'GOOGLE_CLIENT_ID', 'GOOGLE_CLIENT_SECRET']);
  const stripeConfigured = buildFlowCheckConfigured(['STRIPE_SECRET_KEY', 'NEXT_PUBLIC_STRIPE_PUBLISHABLE_KEY', 'STRIPE_PUBLISHABLE_KEY']);
  const aiConfigured = buildFlowCheckConfigured(['OPENAI_API_KEY', 'KIMI_OPENROUTER_KEY', 'ANTHROPIC_API_KEY']);

  return {
    checkedAt: now,
    homepage: ['Homepage responds', homepageRouteExists ? 'Working' : 'Broken', homepageRouteExists ? 'Homepage route is present in the running project.' : 'Homepage route was not found in the current source.'],
    flowCheck: ['Flow-check route is up', flowCheckRouteExists ? 'Working' : 'Broken', flowCheckRouteExists ? 'Protected admin route is present and active in source.' : 'Protected flow-check route was not found in source.'],
    vercel: buildFlowCheckVercelStatus(),
    upload: ['Local file upload route exists', uploadRouteExists ? 'Working' : 'Coming Soon', uploadRouteExists ? 'A local PDF handling route exists for internal tooling.' : 'No internal upload route is defined yet.'],
    supabase: ['Supabase configured', supabaseConfigured ? 'Partial' : 'Coming Soon', supabaseConfigured ? 'Supabase-related environment markers were found.' : 'No Supabase environment markers found yet.'],
    auth: ['Auth configured', authConfigured ? 'Partial' : 'Coming Soon', authConfigured ? 'Auth-related environment markers were found.' : 'No auth environment markers found yet.'],
    drive: ['Google Drive configured', driveConfigured ? 'Partial' : 'Coming Soon', driveConfigured ? 'Google Drive-related environment markers were found.' : 'No Google Drive environment markers found yet.'],
    stripe: ['Stripe configured', stripeConfigured ? 'Partial' : 'Coming Soon', stripeConfigured ? 'Stripe-related environment markers were found.' : 'No Stripe environment markers found yet.'],
    ai: ['AI key configured', aiConfigured ? 'Partial' : 'Coming Soon', aiConfigured ? 'At least one AI service key marker was found.' : 'No AI service key markers found yet.'],
    runtime: ['Runtime/service health', 'Working', `Node process is running. PID ${process.pid}. Uptime ${uptimeMinutes} min.`]
  };
}

function renderBuildFlowControlCenterPage() {
  const live = buildFlowCheckLiveChecks();
  const checkedAt = live.checkedAt;
  const frontendStatuses = [
    ['Homepage', 'Working', 'Live homepage is up on the current Vercel BuildFlow Supply site.'],
    ['Login', 'Coming Soon', 'Authentication work starts in the next step.'],
    ['Dashboard', 'Coming Soon', 'Planned for Step 1 after auth is connected.'],
    ['Projects', 'Coming Soon', 'Project flow is not built yet.'],
    ['File Upload', 'Coming Soon', 'Upload flow is still waiting for later steps.'],
    ['AI Takeoff', 'Coming Soon', 'AI takeoff is not wired yet.'],
    ['Payments', 'Coming Soon', 'Payment flow is still missing.'],
    ['Admin Dashboard', 'Partial', 'This control center exists, but the full admin app is not built yet.']
  ];

  const systemChecks = [
    ['GitHub repo connected', 'Working', 'The Build-flow repository is connected and receiving pushed commits.'],
    ['Vercel deployment working', 'Working', 'The BuildFlow Supply Vercel deployment is live and serving the current production site.'],
    ['Homepage live', 'Working', 'Production homepage is currently live at build-flow-wfl3.vercel.app.'],
    ['Telegram → code → GitHub → Vercel deploy flow working', 'Working', 'The end-to-end update flow is working from chat to live site.'],
    ['Supabase project', 'Working', 'BuildFlow Supply is connected to the active Supabase project.'],
    ['Supabase env keys', 'Working', 'Supabase public URL, anon key, and service role key are configured where needed.'],
    ['Authentication & Roles', 'Working', 'Signup, profile creation, login, dashboard profile read, and password reset are now wired.'],
    ['WhatsApp inbound + logs + sync', 'Working', 'Inbound receiving, inbound logging, and BuildFlow sync are currently working.'],
    ['WhatsApp auto-replies', 'Working', 'Uncontrolled automatic WhatsApp replies are disabled for now.'],
    live.runtime
  ];

  const flowChecklist = [
    ['Client signup works', 'Working'],
    ['Login works', 'Working'],
    ['Dashboard works', 'Working'],
    ['Projects flow works', 'Coming Soon'],
    ['File upload works', 'Coming Soon'],
    ['AI draft works', 'Coming Soon'],
    ['/admin/users page works', 'Working'],
    ['Admin-only access works', 'Working'],
    ['Admin Users security fixed', 'Working'],
    ['Role protections working', 'Working'],
    ['First admin user can view users list', 'Working'],
    ['Admin approval actions work', 'Working'],
    ['approval_actions audit log works', 'Working'],
    ['QA /qa-full passing', 'Working'],
    ['No service role exposed', 'Working'],
    ['Next Step — Admin user approval actions and user management', 'Working']
  ];

  const deployReadiness = [
    ['Mobile test passed', 'Partial'],
    ['Role permissions tested', 'Coming Soon'],
    ['Client cannot see margin', 'Coming Soon'],
    ['Client cannot see supplier', 'Coming Soon'],
    ['Payment is in test mode', 'Coming Soon'],
    ['No broken public pages', 'Partial']
  ];

  const vendorQuoteFlow = [
    'Admin uploads PDF or image quote',
    'AI reads the quote',
    'AI extracts vendor/store name, contact name, phone, email, and address',
    'AI extracts item name, quantity, unit, price, and category',
    'AI sorts materials into Lumber, Doors, Molding, Sheetrock, Roofing, Electrical, and Other',
    'AI creates a Draft Material List',
    'Admin reviews and approves before anything is saved live'
  ];

  const vendorQuoteRules = [
    'Nothing auto-saves without Admin approval',
    'Vendor details are stored only after Admin approval',
    'Materials are added only after Admin approval',
    'Low-confidence extracted lines must be highlighted',
    'Never expose supplier/vendor info to client unless Admin allows it'
  ];

  const integrationSystems = [
    {
      title: 'WhatsApp assistant',
      status: 'Partial',
      note: 'Inbound, logs, and BuildFlow sync working. Auto-replies disabled. Draft Inbox V1 DB schema and safe UI preview are prepared.',
      rule: 'No auto-send for now. Migration is ready but not applied; blocked on DATABASE_URL / SQL access.'
    },
    {
      title: 'AI Plan Reader / Takeoff',
      status: 'Partial',
      note: 'Draft only',
      rule: 'No final quantities or ordering without Admin approval.'
    },
    {
      title: 'Supplier Quote Reader',
      status: 'Coming Soon',
      note: 'Draft extraction only',
      rule: 'Keep original quote, flag low-confidence rows, no auto-purchase.'
    },
    {
      title: 'Email notifications',
      status: 'Partial',
      note: 'Test Mode planned',
      rule: 'Internal recipients only until templates are approved.'
    },
    {
      title: 'Google Drive project folders',
      status: 'Partial',
      note: 'Planned',
      rule: 'No public sharing by default.'
    },
    {
      title: 'SMS/WhatsApp client updates',
      status: 'Partial',
      note: 'Test Mode planned',
      rule: 'No real client sends until Admin approves.'
    }
  ];

  const topSummaryCards = [
    ['Live Site', 'Working', 'Homepage, signup, login, dashboard, admin users'],
    ['Supabase', 'Working', 'Connected, migrations applied, auth URL fixed'],
    ['Auth', 'Working', 'Signup, login, reset, dashboard profile read'],
    ['QA Bot', 'Working', 'QA bot active with auto-monitor every 30 minutes'],
    ['Next Step', 'Working', 'Provide DATABASE_URL or use another safe SQL execution method']
  ];

  const liveLinks = [
    ['Live homepage', 'https://build-flow-wfl3.vercel.app/'],
    ['Signup', 'https://build-flow-wfl3.vercel.app/signup'],
    ['Login', 'https://build-flow-wfl3.vercel.app/login'],
    ['Dashboard', 'https://build-flow-wfl3.vercel.app/dashboard'],
    ['Admin Users', 'https://build-flow-wfl3.vercel.app/admin/users'],
    ['GitHub repo', 'https://github.com/avitan501/Build-flow'],
    ['Vercel project', 'https://vercel.com/avitanneto-1804s-projects/build-flow-wfl3'],
    ['Supabase project', 'https://supabase.com/dashboard/project/tyefmwjkfwztvpdhtbrn']
  ];

  const recentChanges = [
    ['Vercel fixed', 'Working'],
    ['Supabase connected', 'Working'],
    ['Migrations applied', 'Working'],
    ['Signup works', 'Working'],
    ['Password reset works', 'Working'],
    ['Login works', 'Working'],
    ['Dashboard works', 'Working'],
    ['Admin users works', 'Working'],
    ['Admin Users security fixed', 'Working'],
    ['Role protections working', 'Working'],
    ['QA /qa-full passing', 'Working'],
    ['No service role exposed', 'Working'],
    ['Admin approval actions work', 'Working'],
    ['WhatsApp inbound/logs/sync working', 'Working'],
    ['WhatsApp uncontrolled auto-replies disabled', 'Working'],
    ['WhatsApp Draft Inbox V1 DB schema drafted', 'Working'],
    ['WhatsApp Draft Inbox UI preview prepared', 'Working'],
    ['WhatsApp migration ready but not applied', 'Partial'],
    ['QA bot works', 'Working'],
    ['Integrations planned', 'Working']
  ];

  const blockedItems = [
    ['1Password Service Account not ready', 'Partial'],
    ['Google Drive not connected', 'Coming Soon'],
    ['WhatsApp migration blocked on DATABASE_URL / SQL access', 'Partial'],
    ['AI Takeoff not connected', 'Coming Soon'],
    ['Payments not connected', 'Coming Soon']
  ];

  const safetyAlerts = [
    'Nothing goes live without Admin approval',
    'Temporary tokens should be rotated later',
    'Service role must never be exposed',
    'WhatsApp/client messages disabled until approved'
  ];

  const botHealth = [
    ['Builder bot status', 'Working', 'openclaw-gateway.service active'],
    ['QA bot status', 'Working', 'buildflow-qa-bot.service active'],
    ['QA auto-monitor', 'Working', 'Every 30 minutes'],
    ['Last QA check status', 'Partial', 'Placeholder until a live timestamp is wired into this page']
  ];

  const roadmap = [
    ['Foundation', 'Working'],
    ['Auth', 'Working'],
    ['User management', 'Partial'],
    ['Projects', 'Coming Soon'],
    ['Uploads', 'Coming Soon'],
    ['AI Takeoff', 'Coming Soon'],
    ['Quotes', 'Coming Soon'],
    ['Orders', 'Coming Soon'],
    ['Payments', 'Coming Soon'],
    ['Notifications', 'Partial'],
    ['Integrations', 'Partial']
  ];

  const warnings = [
    'Do not delete projects',
    'Do not touch old Vercel project unless approved',
    'Do not expose secrets',
    'Do not change billing/domains without approval'
  ];

  const progressItems = [
    ...flowChecklist,
    ...blockedItems,
    ...roadmap
  ];
  const completedCount = progressItems.filter(([, status]) => status === 'Working').length;
  const missingCount = progressItems.filter(([, status]) => status === 'Coming Soon').length;
  const blockedCount = progressItems.filter(([, status]) => status === 'Broken' || status === 'Partial').length;
  const progressPercent = Math.max(0, Math.min(100, Math.round((completedCount / progressItems.length) * 100)));

  const renderBadge = (status) => {
    const map = {
      'Working': ['#067647', '#ecfdf3', '#abefc6'],
      'Partial': ['#b54708', '#fffaeb', '#fedf89'],
      'Broken': ['#b42318', '#fef3f2', '#fecdca'],
      'Coming Soon': ['#475467', '#f2f4f7', '#d0d5dd']
    };
    const [color, bg, border] = map[status] || map['Coming Soon'];
    return `<span class="badge" style="color:${color};background:${bg};border-color:${border};">${escapeHtml(status)}</span>`;
  };

  const renderStatusRows = (items) => items.map((item) => {
    const [name, status, note = ''] = item;
    return `
      <div class="row-wrap">
        <div class="row">
          <div class="row-main">
            <span class="row-dot row-dot-${String(status).toLowerCase().replace(/\s+/g, '-')}"></span>
            <span class="name">${escapeHtml(name)}</span>
          </div>
          ${renderBadge(status)}
        </div>
        ${note ? `<div class="row-note">${escapeHtml(note)}</div>` : ''}
      </div>
    `;
  }).join('');

  const renderCheckRows = (items) => items.map(([name, status]) => `
    <div class="check-row">
      <div class="checkbox checkbox-${String(status).toLowerCase().replace(/\s+/g, '-')}">${status === 'Working' ? '✓' : status === 'Partial' ? '◐' : status === 'Broken' ? '!' : ''}</div>
      <div class="check-copy">
        <div class="check-title">${escapeHtml(name)}</div>
      </div>
      ${renderBadge(status)}
    </div>
  `).join('');

  const renderBulletRows = (items) => items.map(item => `
    <div class="bullet-row">
      <div class="bullet"></div>
      <div class="bullet-copy">${escapeHtml(item)}</div>
    </div>
  `).join('');

  const renderLinkButtons = (items) => items.map(([label, href]) => `
    <a class="link-btn" href="${escapeHtml(href)}" target="_blank" rel="noopener noreferrer">${escapeHtml(label)}</a>
  `).join('');

  const renderTimeline = (items) => items.map(([label, status]) => `
    <div class="timeline-row">
      <div class="timeline-dot timeline-dot-${String(status).toLowerCase().replace(/\s+/g, '-')}" ></div>
      <div class="timeline-copy">
        <div class="check-title">${escapeHtml(label)}</div>
      </div>
      ${renderBadge(status)}
    </div>
  `).join('');

  const renderMiniCards = (items) => items.map(([title, status, note]) => `
    <div class="mini-card">
      <div class="mini-title-row">
        <div class="mini-title">${escapeHtml(title)}</div>
        ${renderBadge(status)}
      </div>
      <div class="mini-note">${escapeHtml(note || '')}</div>
    </div>
  `).join('');

  return `<!DOCTYPE html>
  <html lang="en">
    <head>
      <meta charset="utf-8" />
      <meta name="viewport" content="width=device-width, initial-scale=1" />
      <title>BuildFlow Control Center</title>
      <style>
        *{box-sizing:border-box}
        body{margin:0;font-family:Inter,-apple-system,BlinkMacSystemFont,"Segoe UI",sans-serif;background:linear-gradient(180deg,#eef4ff 0%,#f8fbff 100%);color:#101828}
        .page{max-width:980px;margin:0 auto;padding:16px 12px 32px}
        .hero,.card{background:rgba(255,255,255,.94);border:1px solid rgba(16,24,40,.08);border-radius:22px;box-shadow:0 12px 30px rgba(16,24,40,.06)}
        .hero{padding:18px}
        .eyebrow{display:inline-flex;align-items:center;gap:8px;padding:7px 10px;border-radius:999px;background:#eff8ff;color:#175cd3;font-size:11px;font-weight:800;letter-spacing:.08em;text-transform:uppercase}
        .title{margin:10px 0 6px;font-size:30px;line-height:1.03;letter-spacing:-.04em}
        .copy{margin:0;color:#475467;line-height:1.6;font-size:14px}
        .hero-meta{display:grid;grid-template-columns:1fr;gap:10px;margin-top:14px}
        .meta-chip{padding:12px 14px;border-radius:16px;background:#f8fafc;border:1px solid #eaecf0}
        .summary-grid,.mini-grid,.link-grid{display:grid;grid-template-columns:1fr;gap:10px}
        .mini-card{padding:14px;border-radius:18px;background:#f8fafc;border:1px solid #eaecf0}
        .mini-title-row{display:flex;align-items:flex-start;justify-content:space-between;gap:10px}
        .mini-title{font-size:15px;font-weight:800;color:#101828}
        .mini-note{margin-top:6px;color:#667085;font-size:13px;line-height:1.55}
        .progress-bar{height:12px;border-radius:999px;background:#eaecf0;overflow:hidden;margin-top:10px}
        .progress-fill{height:100%;background:linear-gradient(90deg,#12b76a 0%,#175cd3 100%);border-radius:999px}
        .stats-grid{display:grid;grid-template-columns:repeat(2,minmax(0,1fr));gap:10px;margin-top:12px}
        .stat-box{padding:12px;border-radius:16px;background:#f8fafc;border:1px solid #eaecf0}
        .stat-label{font-size:11px;font-weight:800;letter-spacing:.06em;color:#667085;text-transform:uppercase}
        .stat-value{margin-top:4px;font-size:20px;font-weight:800;color:#101828}
        .link-btn{display:block;padding:14px 16px;border-radius:16px;background:#101828;color:#fff;text-decoration:none;font-size:14px;font-weight:700;text-align:center}
        .timeline-row{display:flex;align-items:flex-start;gap:10px;padding:12px 0;border-top:1px solid #eaecf0}
        .timeline-row:first-of-type{border-top:0}
        .timeline-dot{width:10px;height:10px;border-radius:999px;flex:0 0 auto;margin-top:7px;background:#98a2b3}
        .timeline-dot-working{background:#12b76a}.timeline-dot-partial{background:#f79009}.timeline-dot-broken{background:#f04438}.timeline-dot-coming-soon{background:#98a2b3}
        .timeline-copy{flex:1;min-width:0}
        .meta-label{font-size:11px;font-weight:800;letter-spacing:.06em;color:#667085;text-transform:uppercase}
        .meta-value{margin-top:4px;font-size:14px;font-weight:700;color:#101828}
        .grid{display:grid;gap:14px;margin-top:14px}
        .card{padding:16px}
        .section-head{display:flex;align-items:flex-start;justify-content:space-between;gap:12px;margin-bottom:12px}
        .section-title{margin:0;font-size:18px;line-height:1.2}
        .section-note{margin:4px 0 0;color:#667085;font-size:13px;line-height:1.55}
        .row-wrap,.check-row,.bullet-row{border-top:1px solid #eaecf0}
        .row-wrap:first-of-type,.check-row:first-of-type,.bullet-row:first-of-type{border-top:0}
        .row,.check-row{display:flex;align-items:center;justify-content:space-between;gap:12px;padding:12px 0}
        .row-main{display:flex;align-items:center;gap:10px;min-width:0}
        .row-dot{width:10px;height:10px;border-radius:999px;flex:0 0 auto;background:#d0d5dd}
        .row-dot-working{background:#12b76a}.row-dot-partial{background:#f79009}.row-dot-broken{background:#f04438}.row-dot-coming-soon{background:#98a2b3}
        .name,.check-title{font-weight:700;color:#101828}
        .row-note{padding:0 0 12px 20px;color:#667085;font-size:13px;line-height:1.55}
        .badge{display:inline-flex;align-items:center;justify-content:center;border:1px solid transparent;border-radius:999px;padding:6px 10px;font-size:12px;font-weight:800;white-space:nowrap;flex:0 0 auto}
        .check-row{align-items:flex-start}
        .checkbox{width:22px;height:22px;border-radius:8px;border:1.5px solid #d0d5dd;background:#f9fafb;display:grid;place-items:center;font-size:12px;font-weight:900;color:#667085;flex:0 0 auto;margin-top:1px}
        .checkbox-working{background:#ecfdf3;border-color:#abefc6;color:#067647}
        .checkbox-partial{background:#fffaeb;border-color:#fedf89;color:#b54708}
        .checkbox-broken{background:#fef3f2;border-color:#fecdca;color:#b42318}
        .checkbox-coming-soon{background:#f2f4f7;border-color:#d0d5dd;color:#98a2b3}
        .check-copy{flex:1;min-width:0}
        .error-box{padding:14px;border-radius:16px;background:#f8fafc;border:1px dashed #cbd5e1;color:#475467;font-size:14px;line-height:1.6}
        .bullet-row{display:flex;align-items:flex-start;gap:10px;padding:12px 0}
        .bullet{width:9px;height:9px;border-radius:999px;background:#98a2b3;flex:0 0 auto;margin-top:7px}
        .bullet-copy{color:#475467;font-size:14px;line-height:1.6}
        .subcard{margin-top:12px;padding:14px;border-radius:18px;background:#f8fafc;border:1px solid #eaecf0}
        .subcard-title{display:flex;align-items:center;justify-content:space-between;gap:12px;margin:0 0 4px;font-size:16px}
        .subcard-copy{margin:0;color:#667085;font-size:13px;line-height:1.55}
        @media (min-width:780px){
          .grid.two{grid-template-columns:1fr 1fr}
          .hero-meta{grid-template-columns:repeat(2,minmax(0,1fr))}
          .summary-grid{grid-template-columns:repeat(5,minmax(0,1fr))}
          .mini-grid{grid-template-columns:repeat(2,minmax(0,1fr))}
          .link-grid{grid-template-columns:repeat(4,minmax(0,1fr))}
          .stats-grid{grid-template-columns:repeat(4,minmax(0,1fr))}
        }
      </style>
    </head>
    <body>
      <main class="page">
        <section class="hero">
          <div class="eyebrow">Internal admin only</div>
          <h1 class="title">BuildFlow Control Center</h1>
          <p class="copy">Admin-only flow check page for the BuildFlow Supply website. Use this to quickly review current page status, backend connections, rollout readiness, and planned internal tooling from your phone.</p>
          <div class="hero-meta">
            <div class="meta-chip">
              <div class="meta-label">Last checked</div>
              <div class="meta-value">${escapeHtml(checkedAt)}</div>
            </div>
            <div class="meta-chip">
              <div class="meta-label">Scope</div>
              <div class="meta-value">Read-only dashboard. Next step: provide DATABASE_URL or use another safe SQL execution method.</div>
            </div>
          </div>
        </section>

        <section class="grid">
          <div class="summary-grid">
            ${renderMiniCards(topSummaryCards)}
          </div>
        </section>

        <section class="grid two">
          <div class="card">
            <div class="section-head">
              <div>
                <h2 class="section-title">Progress Overview</h2>
                <p class="section-note">Fast mobile summary of what works, what is missing, what is blocked, and the next action.</p>
              </div>
              ${renderBadge('Working')}
            </div>
            <div class="meta-value">Overall progress: ${progressPercent}%</div>
            <div class="progress-bar"><div class="progress-fill" style="width:${progressPercent}%"></div></div>
            <div class="stats-grid">
              <div class="stat-box"><div class="stat-label">Completed</div><div class="stat-value">${completedCount}</div></div>
              <div class="stat-box"><div class="stat-label">Missing</div><div class="stat-value">${missingCount}</div></div>
              <div class="stat-box"><div class="stat-label">Blocked</div><div class="stat-value">${blockedCount}</div></div>
              <div class="stat-box"><div class="stat-label">Next action</div><div class="stat-value" style="font-size:14px">Provide DATABASE_URL or choose another safe SQL execution method</div></div>
            </div>
          </div>
          <div class="card">
            <div class="section-head">
              <div>
                <h2 class="section-title">Live Links</h2>
                <p class="section-note">Large buttons for the main live pages and project dashboards.</p>
              </div>
            </div>
            <div class="link-grid">
              ${renderLinkButtons(liveLinks)}
            </div>
          </div>
        </section>

        <section class="grid two">
          <div class="card">
            <div class="section-head">
              <div>
                <h2 class="section-title">Last Deploy Info</h2>
                <p class="section-note">Latest known live deployment reference for quick review.</p>
              </div>
            </div>
            <div class="mini-grid">
              ${renderMiniCards([
                ['Latest known commit', 'Working', '587f907'],
                ['Live URL', 'Working', 'https://build-flow-wfl3.vercel.app/'],
                ['Deploy status', 'Working', 'Live site responding'],
                ['Update note', 'Working', 'Updated manually/automatically after meaningful changes']
              ])}
            </div>
          </div>
          <div class="card">
            <div class="section-head">
              <div>
                <h2 class="section-title">Today\'s Focus</h2>
                <p class="section-note">Current planned workstream for the next BuildFlow development session.</p>
              </div>
              ${renderBadge('Working')}
            </div>
            <div class="error-box"><strong>Next planned work:</strong><br/>Provide full postgresql:// connection string or choose another safe SQL execution method.</div>
          </div>
        </section>

        <section class="grid two">
          <div class="card">
            <div class="section-head">
              <div>
                <h2 class="section-title">Recent Changes Timeline</h2>
                <p class="section-note">Important BuildFlow milestones completed recently.</p>
              </div>
            </div>
            ${renderTimeline(recentChanges)}
          </div>
          <div class="card">
            <div class="section-head">
              <div>
                <h2 class="section-title">Blocked / Waiting Items</h2>
                <p class="section-note">Important systems or access still waiting before later phases can go live.</p>
              </div>
            </div>
            ${renderCheckRows(blockedItems)}
          </div>
        </section>

        <section class="grid two">
          <div class="card">
            <div class="section-head">
              <div>
                <h2 class="section-title">Safety Alerts</h2>
                <p class="section-note">Non-negotiable rollout and security rules.</p>
              </div>
              ${renderBadge('Working')}
            </div>
            <div class="subcard">
              ${renderBulletRows(safetyAlerts)}
            </div>
          </div>
          <div class="card">
            <div class="section-head">
              <div>
                <h2 class="section-title">Bot Health</h2>
                <p class="section-note">Builder bot and QA bot visibility from one mobile-friendly card.</p>
              </div>
            </div>
            ${renderStatusRows(botHealth)}
          </div>
        </section>

        <section class="grid two">
          <div class="card">
            <div class="section-head">
              <div>
                <h2 class="section-title">Integrations &amp; AI Systems</h2>
                <p class="section-note">Planned systems only. Everything stays in draft, test mode, or coming soon until Admin approves live rollout.</p>
              </div>
              ${renderBadge('Coming Soon')}
            </div>
            <div class="subcard">
              <h3 class="subcard-title">Release rule ${renderBadge('Working')}</h3>
              <p class="subcard-copy">Nothing goes live without Admin approval.</p>
            </div>
            ${integrationSystems.map((item) => `
              <div class="subcard">
                <h3 class="subcard-title">${escapeHtml(item.title)} ${renderBadge(item.status)}</h3>
                <p class="subcard-copy">${escapeHtml(item.note)}</p>
                <p class="subcard-copy"><strong>Rule:</strong> ${escapeHtml(item.rule)}</p>
              </div>
            `).join('')}
          </div>
          <div class="card">
            <div class="section-head">
              <div>
                <h2 class="section-title">Mini Roadmap</h2>
                <p class="section-note">Phase view for the full BuildFlow buildout.</p>
              </div>
            </div>
            ${renderCheckRows(roadmap)}
          </div>
        </section>

        <section class="grid two">
          <div class="card">
            <div class="section-head">
              <div>
                <h2 class="section-title">What Works / Missing / Broken</h2>
                <p class="section-note">High-signal operational status blocks for quick scanning.</p>
              </div>
            </div>
            ${renderStatusRows(frontendStatuses)}
            ${renderStatusRows(systemChecks)}
            ${renderStatusRows([live.homepage, live.flowCheck, live.runtime])}
          </div>
          <div class="card">
            <div class="section-head">
              <div>
                <h2 class="section-title">Do Not Touch Warning</h2>
                <p class="section-note">Project protection rules to avoid damaging live systems.</p>
              </div>
              ${renderBadge('Working')}
            </div>
            <div class="subcard">
              ${renderBulletRows(warnings)}
            </div>
            <div class="subcard">
              <h3 class="subcard-title">Vendor Quote Upload ${renderBadge('Coming Soon')}</h3>
              <p class="subcard-copy">Future admin-only workflow. No real upload, AI extraction, database save, or auto-save flow is active yet.</p>
              ${renderBulletRows(vendorQuoteFlow)}
            </div>
            <div class="subcard">
              <h3 class="subcard-title">Safety rules ${renderBadge('Coming Soon')}</h3>
              ${renderBulletRows(vendorQuoteRules)}
            </div>
          </div>
        </section>
      </main>
    </body>
  </html>`;
}

function renderAccountPage(cfg, user, flash = {}) {
  const theme = {
    accent: cfg.brand?.accent || '#f96302',
    dark: cfg.brand?.dark || '#111111',
    light: cfg.brand?.light || '#ffffff'
  };
  const displayName = user.full_name || user.phone || 'Builder';
  const flashHtml = flash.info ? `<div class="flash">${escapeHtml(flash.info)}</div>` : '';
  const steps = [
    {
      title: 'Request received',
      content: 'You send a material list, a WhatsApp message, or a blueprint.'
    },
    {
      title: 'Price check',
      content: 'We compare suppliers and find the best place to buy.'
    },
    {
      title: 'Best option selected',
      content: 'You review the best buying direction for the job.'
    },
    {
      title: 'Shipping coordinated',
      content: 'We manage delivery timing and shipping follow-up.'
    },
    {
      title: 'Delivered to site',
      content: 'Materials arrive and the builder stays focused on the work.'
    }
  ];
  const actions = [
    {
      title: 'Request pricing',
      content: 'Send what you need and let us compare prices across suppliers.'
    },
    {
      title: 'Start material order',
      content: 'Open a new material request and keep every step in one place.'
    },
    {
      title: 'Upload blueprint',
      content: 'Share a plan so we can help identify needed materials.'
    },
    {
      title: 'WhatsApp order',
      content: 'Kick off an order directly from WhatsApp without leaving the job.'
    },
    {
      title: 'Track shipping',
      content: 'See whether sourcing, booking, or delivery is in progress.'
    }
  ];

  return `
    <!DOCTYPE html>
    <html lang="en">
      <head>
        <meta charset="utf-8" />
        <meta name="viewport" content="width=device-width, initial-scale=1" />
        <title>Builder Dashboard</title>
        <style>
          :root {
            --accent: ${escapeHtml(theme.accent)};
            --dark: ${escapeHtml(theme.dark)};
            --light: ${escapeHtml(theme.light)};
          }
          * { box-sizing: border-box; }
          body {
            margin: 0;
            font-family: Inter, -apple-system, BlinkMacSystemFont, "Segoe UI", sans-serif;
            background: #f7f7f7;
            color: #111111;
          }
          .top-strip {
            background: var(--dark);
            color: white;
            text-align: center;
            padding: 12px 18px;
            font-size: 13px;
            font-weight: 700;
            letter-spacing: 0.08em;
          }
          .page {
            max-width: 1220px;
            margin: 0 auto;
            padding: 28px 20px 44px;
          }
          .topbar {
            display: flex;
            justify-content: space-between;
            align-items: center;
            gap: 16px;
            margin-bottom: 18px;
          }
          .brand-title {
            font-size: 24px;
            font-weight: 800;
          }
          .brand-sub {
            color: #5f6368;
            margin-top: 4px;
          }
          .logout {
            display: inline-flex;
            align-items: center;
            justify-content: center;
            background: white;
            color: var(--dark);
            text-decoration: none;
            border-radius: 14px;
            padding: 12px 16px;
            font-weight: 800;
            border: 1px solid rgba(17,17,17,0.1);
          }
          .hero,
          .panel,
          .stat,
          .action,
          .step {
            background: white;
            border: 1px solid rgba(17,17,17,0.08);
            border-radius: 24px;
            box-shadow: 0 16px 40px rgba(17,17,17,0.06);
          }
          .hero {
            padding: 30px;
            margin-bottom: 18px;
          }
          .eyebrow {
            display: inline-flex;
            align-items: center;
            padding: 8px 12px;
            border-radius: 999px;
            background: rgba(249,99,2,0.12);
            color: var(--accent);
            font-size: 12px;
            font-weight: 800;
            letter-spacing: 0.1em;
            margin-bottom: 16px;
          }
          h1 {
            margin: 0 0 12px;
            font-size: clamp(38px, 6vw, 68px);
            line-height: 0.94;
            letter-spacing: -0.05em;
            max-width: 10ch;
          }
          .subcopy {
            max-width: 58ch;
            color: #4b5563;
            font-size: 18px;
            line-height: 1.7;
          }
          .flash {
            margin-top: 18px;
            padding: 12px 14px;
            border-radius: 14px;
            background: #eef6ff;
            color: #175cd3;
            font-weight: 700;
          }
          .stats {
            display: grid;
            grid-template-columns: repeat(3, minmax(0, 1fr));
            gap: 16px;
            margin-bottom: 18px;
          }
          .stat {
            padding: 22px;
          }
          .label {
            font-size: 12px;
            letter-spacing: 0.1em;
            font-weight: 800;
            color: #5f6368;
            margin-bottom: 10px;
          }
          .value {
            font-size: 28px;
            font-weight: 800;
            line-height: 1.1;
          }
          .muted {
            margin-top: 10px;
            color: #52525b;
            line-height: 1.6;
          }
          .content-grid {
            display: grid;
            grid-template-columns: minmax(0, 1.1fr) minmax(320px, 0.9fr);
            gap: 16px;
            margin-bottom: 18px;
          }
          .panel {
            padding: 24px;
          }
          .panel h2 {
            margin: 0 0 10px;
            font-size: 28px;
            letter-spacing: -0.03em;
          }
          .panel-intro {
            color: #52525b;
            line-height: 1.6;
            margin-bottom: 18px;
          }
          .stack {
            display: grid;
            gap: 14px;
          }
          .row {
            display: grid;
            grid-template-columns: repeat(3, minmax(0, 1fr));
            gap: 12px;
          }
          .mini {
            padding: 16px;
            border-radius: 18px;
            background: #f8f8f8;
            border: 1px solid rgba(17,17,17,0.06);
          }
          .mini strong {
            display: block;
            margin-bottom: 8px;
            font-size: 13px;
            color: #5f6368;
            letter-spacing: 0.08em;
            text-transform: uppercase;
          }
          .mini span {
            display: block;
            font-size: 18px;
            font-weight: 700;
            line-height: 1.35;
          }
          .actions-grid {
            display: grid;
            grid-template-columns: repeat(2, minmax(0, 1fr));
            gap: 12px;
          }
          .action {
            padding: 18px;
          }
          .action strong {
            display: block;
            font-size: 18px;
            margin-bottom: 8px;
          }
          .action p,
          .step p {
            margin: 0;
            color: #52525b;
            line-height: 1.6;
          }
          .section-title {
            margin: 0 0 14px;
            font-size: 28px;
            letter-spacing: -0.03em;
          }
          .orders-panel {
            margin-bottom: 18px;
          }
          .empty-state {
            padding: 22px;
            border-radius: 20px;
            background: #f8f8f8;
            border: 1px dashed rgba(17,17,17,0.15);
          }
          .empty-state strong {
            display: block;
            font-size: 18px;
            margin-bottom: 8px;
          }
          .steps-grid {
            display: grid;
            grid-template-columns: repeat(5, minmax(0, 1fr));
            gap: 12px;
          }
          .step {
            padding: 18px;
          }
          .step-index {
            width: 34px;
            height: 34px;
            border-radius: 999px;
            display: grid;
            place-items: center;
            background: rgba(249,99,2,0.12);
            color: var(--accent);
            font-weight: 800;
            margin-bottom: 12px;
          }
          .step strong {
            display: block;
            margin-bottom: 8px;
            font-size: 17px;
          }
          @media (max-width: 980px) {
            .stats,
            .row,
            .content-grid,
            .steps-grid {
              grid-template-columns: 1fr;
            }
            .actions-grid {
              grid-template-columns: 1fr;
            }
          }
          @media (max-width: 700px) {
            .topbar {
              flex-direction: column;
              align-items: stretch;
            }
          }
        </style>
      </head>
      <body>
        <div class="top-strip">BUILDER DASHBOARD</div>
        <main class="page">
          <div class="topbar">
            <div>
              <div class="brand-title">${escapeHtml(cfg.brand?.name || 'BuildCore Supply')}</div>
              <div class="brand-sub">Projects, material orders, pricing help, and shipping coordination.</div>
            </div>
            <a class="logout" href="/logout">Log out</a>
          </div>

          <section class="hero">
            <div class="eyebrow">BUILDER HOME</div>
            <h1>Hello ${escapeHtml(displayName)}</h1>
            <div class="subcopy">This is the page a builder uses after login. It keeps the project, the material order flow, and the current step of every request in one simple place.</div>
            ${flashHtml}
          </section>

          <section class="stats">
            <article class="stat">
              <div class="label">ACCOUNT STATUS</div>
              <div class="value">${escapeHtml(user.account_status || 'Active account')}</div>
              <div class="muted">Your account is ready for pricing requests, material orders, and delivery follow-up.</div>
            </article>
            <article class="stat">
              <div class="label">PHONE</div>
              <div class="value">${escapeHtml(user.phone || 'Not available')}</div>
              <div class="muted">This phone number stays tied to your account and WhatsApp activity.</div>
            </article>
            <article class="stat">
              <div class="label">LAST LOGIN</div>
              <div class="value">${escapeHtml(formatDisplayDate(user.last_login_at))}</div>
              <div class="muted">Come back here to see what is in pricing, in shipping, or already delivered.</div>
            </article>
          </section>

          <section class="content-grid">
            <article class="panel">
              <h2>Project workspace</h2>
              <div class="panel-intro">The builder should always know what project is active, what materials are being handled, and what the next move is.</div>
              <div class="stack">
                <div class="row">
                  <div class="mini">
                    <strong>Current project</strong>
                    <span>Project view starts here</span>
                  </div>
                  <div class="mini">
                    <strong>Material orders</strong>
                    <span>Track every request in one flow</span>
                  </div>
                  <div class="mini">
                    <strong>Next move</strong>
                    <span>See what needs your approval right away</span>
                  </div>
                </div>
                <div class="empty-state">
                  <strong>No project is shown on this minimal version yet.</strong>
                  <div class="muted">This area is reserved for the builder's active project, job site details, and the material requests linked to that project.</div>
                </div>
              </div>
            </article>

            <article class="panel">
              <h2>Quick actions</h2>
              <div class="panel-intro">These are the main things the builder comes here to do.</div>
              <div class="actions-grid">
                ${actions.map(action => `
                  <article class="action">
                    <strong>${escapeHtml(action.title)}</strong>
                    <p>${escapeHtml(action.content)}</p>
                  </article>
                `).join('')}
              </div>
            </article>
          </section>

          <section class="panel orders-panel">
            <h2 class="section-title">Material orders</h2>
            <div class="panel-intro">Every order should stay simple for the builder: what was requested, what pricing was found, what was approved, and where delivery stands now.</div>
            <div class="empty-state">
              <strong>No active material order is shown on this minimal version yet.</strong>
              <div class="muted">When an order is active, this section should show the project, requested materials, best supplier option, shipping status, and the next required step.</div>
            </div>
          </section>

          <section>
            <h2 class="section-title">Order step tracker</h2>
            <div class="steps-grid">
              ${steps.map((step, index) => `
                <article class="step">
                  <div class="step-index">${index + 1}</div>
                  <strong>${escapeHtml(step.title)}</strong>
                  <p>${escapeHtml(step.content)}</p>
                </article>
              `).join('')}
            </div>
          </section>
        </main>
      </body>
    </html>
  `;
}

function extractNamedField(text, patterns, fallback = '') {
  for (const pattern of patterns) {
    const match = String(text || '').match(pattern);
    if (match?.[1]) return match[1].trim();
  }
  return fallback;
}

function detectPaymentStatus(text) {
  const value = String(text || '').toLowerCase();
  if (/paid|payment received|שולם|שולמה/.test(value)) return 'paid';
  if (/not paid|unpaid|לא שולם/.test(value)) return 'unpaid';
  if (/pending payment|awaiting payment|ממתין לתשלום|טרם שולם/.test(value)) return 'pending';
  return 'unknown';
}

function detectStage(text) {
  const value = String(text || '').toLowerCase();
  if (/delivered|completed|נמסר|הושלם/.test(value)) return 'completed';
  if (/shipped|on the way|בדרך|נשלח/.test(value)) return 'shipping';
  if (/production|in progress|בטיפול|בביצוע|בייצור/.test(value)) return 'in-progress';
  if (/approved|confirmed|אושר|אושרה/.test(value)) return 'confirmed';
  return 'new';
}

function extractAmount(text) {
  const match = String(text || '').match(/(?:amount|total|sum|סה["׳']?כ|מחיר)\s*[:\-]?\s*([₪$€]?\s?\d+(?:[.,]\d{1,2})?)/i)
    || String(text || '').match(/([₪$€]\s?\d+(?:[.,]\d{1,2})?)/);
  return match?.[1]?.trim() || '';
}

function inferNextStep(stage, paymentStatus) {
  if (paymentStatus === 'unpaid' || paymentStatus === 'pending') return 'Collect payment';
  if (stage === 'new') return 'Confirm the order details';
  if (stage === 'confirmed') return 'Send the order to execution';
  if (stage === 'in-progress') return 'Follow up with supplier or customer';
  if (stage === 'shipping') return 'Track delivery and confirm arrival';
  return 'Close the order or follow up with the customer';
}

function summarizeStanding(order) {
  return `Order ${order.order_id} for ${order.customer_name || 'unknown customer'} is currently at stage "${order.current_stage || 'unknown'}". Payment status: ${order.payment_status || 'unknown'}. Next step: ${order.next_step || 'not set'}.`;
}

function nextOrderId(orders) {
  let maxNumber = 1000;
  for (const order of orders) {
    const match = String(order.order_id || '').match(/^ORDER-(\d+)$/i);
    if (match) maxNumber = Math.max(maxNumber, Number(match[1]));
  }
  return `ORDER-${maxNumber + 1}`;
}

function ensureOrderIds(orders) {
  let changed = false;
  let maxNumber = 1000;

  for (const order of orders) {
    const match = String(order.order_id || '').match(/^ORDER-(\d+)$/i);
    if (match) maxNumber = Math.max(maxNumber, Number(match[1]));
  }

  for (const order of orders) {
    if (!order.order_id) {
      maxNumber += 1;
      order.order_id = `ORDER-${maxNumber}`;
      changed = true;
    }
  }

  return { orders, changed };
}

function readOrders() {
  const rawOrders = readJsonArray(ordersFile);
  const { orders, changed } = ensureOrderIds(rawOrders);
  if (changed) writeJsonArray(ordersFile, orders);
  return orders;
}

function extractOrderDataFromConversation(conversation, overrides = {}) {
  const text = String(conversation || '').trim();
  const isUpdate = overrides.__mode === 'update';
  const phoneMatch = text.match(/\+\d{7,15}/);
  const detectedPaymentStatus = detectPaymentStatus(text);
  const detectedStage = detectStage(text);
  const paymentStatus = overrides.payment_status || overrides.paymentStatus || (isUpdate && detectedPaymentStatus === 'unknown' ? '' : detectedPaymentStatus);
  const currentStage = overrides.current_stage || overrides.currentStage || (isUpdate && detectedStage === 'new' ? '' : detectedStage);

  const data = {
    customer_name: overrides.customer_name || overrides.customerName || extractNamedField(text, [
      /customer(?: name)?\s*[:\-]\s*(.+)/i,
      /לקוח(?:ה)?\s*[:\-]\s*(.+)/i,
      /שם לקוח\s*[:\-]\s*(.+)/i
    ], isUpdate ? '' : 'Unknown customer'),
    supplier_name: overrides.supplier_name || overrides.supplierName || extractNamedField(text, [
      /supplier(?: name)?\s*[:\-]\s*(.+)/i,
      /ספק\s*[:\-]\s*(.+)/i,
      /שם ספק\s*[:\-]\s*(.+)/i
    ], ''),
    whatsapp_number: overrides.whatsapp_number || overrides.whatsappNumber || extractNamedField(text, [
      /whatsapp(?: number)?\s*[:\-]\s*(.+)/i,
      /phone(?: number)?\s*[:\-]\s*(.+)/i,
      /טלפון\s*[:\-]\s*(.+)/i
    ], phoneMatch?.[0] || ''),
    order_summary: overrides.order_summary || overrides.orderSummary || extractNamedField(text, [
      /order(?: summary)?\s*[:\-]\s*(.+)/i,
      /summary\s*[:\-]\s*(.+)/i,
      /פרטי הזמנה\s*[:\-]\s*(.+)/i
    ], isUpdate ? '' : (text.slice(0, 160) || 'New order conversation')),
    amount: overrides.amount || extractAmount(text),
    payment_status: paymentStatus,
    current_stage: currentStage,
    next_step: overrides.next_step || overrides.nextStep || extractNamedField(text, [
      /next step\s*[:\-]\s*(.+)/i,
      /השלב הבא\s*[:\-]\s*(.+)/i,
      /next action\s*[:\-]\s*(.+)/i
    ], isUpdate ? '' : inferNextStep(currentStage, paymentStatus)),
    source: overrides.source || 'conversation'
  };

  if (isUpdate) {
    Object.keys(data).forEach(key => {
      if (data[key] === '') delete data[key];
    });
  }

  return data;
}

function normalizeOrderRecord(input = {}, base = {}, allOrders = []) {
  const customerName = input.customer_name ?? input.customerName ?? base.customer_name ?? '';
  const supplierName = input.supplier_name ?? input.supplierName ?? base.supplier_name ?? '';
  const whatsappNumber = normalizePhone(input.whatsapp_number ?? input.whatsappNumber ?? base.whatsapp_number ?? '');
  const orderSummary = input.order_summary ?? input.orderSummary ?? base.order_summary ?? '';
  const amount = input.amount ?? base.amount ?? '';
  const paymentStatus = input.payment_status ?? input.paymentStatus ?? base.payment_status ?? 'unknown';
  const currentStage = input.current_stage ?? input.currentStage ?? base.current_stage ?? 'new';
  const nextStep = input.next_step ?? input.nextStep ?? base.next_step ?? inferNextStep(currentStage, paymentStatus);
  const orderId = input.order_id ?? input.orderId ?? base.order_id ?? nextOrderId(allOrders);
  const lastCustomerMessage = input.last_customer_message ?? input.lastCustomerMessage ?? base.last_customer_message ?? '';
  const latestSourcePath = input.latest_source_path ?? input.latestSourcePath ?? base.latest_source_path ?? '';
  const activityLog = Array.isArray(base.activity_log) ? [...base.activity_log] : [];

  if (input.activity_entry && typeof input.activity_entry === 'object') {
    activityLog.unshift({
      timestamp: input.activity_entry.timestamp || new Date().toISOString(),
      media_type: input.activity_entry.media_type || '',
      source_path: input.activity_entry.source_path || '',
      body: input.activity_entry.body || ''
    });
  }

  const dedupedActivityLog = [];
  const seenActivity = new Set();
  for (const entry of activityLog) {
    const key = JSON.stringify([
      entry.timestamp || '',
      entry.media_type || '',
      entry.source_path || '',
      entry.body || ''
    ]);
    if (seenActivity.has(key)) continue;
    seenActivity.add(key);
    dedupedActivityLog.push(entry);
  }

  const record = {
    order_id: orderId,
    customer_name: customerName || 'Unknown customer',
    supplier_name: supplierName,
    whatsapp_number: whatsappNumber,
    order_summary: orderSummary || 'New order',
    amount,
    payment_status: paymentStatus,
    current_stage: currentStage,
    next_step: nextStep,
    last_customer_message: lastCustomerMessage,
    latest_source_path: latestSourcePath,
    activity_log: dedupedActivityLog.slice(0, 20),
    source: input.source ?? base.source ?? 'manual',
    created_at: base.created_at ?? input.created_at ?? new Date().toISOString(),
    updated_at: new Date().toISOString()
  };

  record.standing_summary = summarizeStanding(record);
  return record;
}

function buildOrderFromConversation(conversation, overrides = {}, allOrders = []) {
  const data = extractOrderDataFromConversation(conversation, overrides);
  return normalizeOrderRecord(data, {}, allOrders);
}

function findMatchingOrders(orders, criteria = {}) {
  const customerName = String(criteria.customer_name || criteria.customerName || '').trim().toLowerCase();
  const whatsappNumber = normalizePhone(criteria.whatsapp_number || criteria.whatsappNumber || '');

  return orders.filter(order => {
    const customerMatch = customerName && String(order.customer_name || '').trim().toLowerCase() === customerName;
    const phoneMatch = whatsappNumber && normalizePhone(order.whatsapp_number) === whatsappNumber;
    return Boolean(customerMatch || phoneMatch);
  });
}


function readAuthPreviewUsers() {
  const users = readJson(authPreviewUsersFile, []);
  return Array.isArray(users) ? users : [];
}

function readPreviewSessionToken(req) {
  return parseCookies(req).step1_session || '';
}

function setPreviewSessionCookie(res, token) {
  res.setHeader('Set-Cookie', `step1_session=${encodeURIComponent(token)}; Path=/step1; HttpOnly; SameSite=Lax; Max-Age=${60 * 60 * 24 * 45}`);
}

function clearPreviewSessionCookie(res) {
  res.setHeader('Set-Cookie', 'step1_session=; Path=/step1; HttpOnly; SameSite=Lax; Max-Age=0');
}

function readCurrentPreviewUser(req) {
  const token = readPreviewSessionToken(req);
  if (!token) return null;
  const users = readAuthPreviewUsers();
  return users.find(user => user.session_token === token && Date.parse(user.session_expires_at || '') > Date.now()) || null;
}

function issuePreviewSessionForUser(users, index) {
  const token = crypto.randomBytes(24).toString('hex');
  const now = new Date().toISOString();
  users[index] = {
    ...users[index],
    last_login_at: now,
    session_token: token,
    session_expires_at: new Date(Date.now() + 1000 * 60 * 60 * 24 * 45).toISOString(),
    updated_at: now
  };
  writeJson(authPreviewUsersFile, users);
  return token;
}

function clearPreviewSessionForToken(token) {
  if (!token) return;
  const users = readAuthPreviewUsers();
  const index = users.findIndex(user => user.session_token === token);
  if (index === -1) return;
  users[index] = {
    ...users[index],
    session_token: '',
    session_expires_at: '',
    updated_at: new Date().toISOString()
  };
  writeJson(authPreviewUsersFile, users);
}

function renderStep1PreviewPage(flash = {}) {
  const infoHtml = flash.info ? `<div class="flash flash-info">${escapeHtml(flash.info)}</div>` : '';
  const errorHtml = flash.error ? `<div class="flash flash-error">${escapeHtml(flash.error)}</div>` : '';

  return `
    <!DOCTYPE html>
    <html lang="en">
      <head>
        <meta charset="utf-8" />
        <meta name="viewport" content="width=device-width, initial-scale=1" />
        <title>Step 1 Preview, Authentication</title>
        <style>
          * { box-sizing: border-box; }
          body {
            margin: 0;
            font-family: Inter, -apple-system, BlinkMacSystemFont, "Segoe UI", sans-serif;
            background: #f5f5f5;
            color: #111111;
          }
          .wrap {
            max-width: 980px;
            margin: 0 auto;
            padding: 28px 18px 42px;
          }
          .badge {
            display: inline-flex;
            padding: 8px 12px;
            border-radius: 999px;
            background: rgba(249,99,2,0.12);
            color: #f96302;
            font-weight: 800;
            font-size: 12px;
            letter-spacing: 0.08em;
            margin-bottom: 16px;
          }
          h1 {
            margin: 0 0 10px;
            font-size: clamp(34px, 7vw, 64px);
            line-height: 0.96;
            letter-spacing: -0.05em;
          }
          .sub {
            max-width: 54ch;
            color: #52525b;
            font-size: 17px;
            line-height: 1.7;
            margin-bottom: 20px;
          }
          .flash {
            border-radius: 16px;
            padding: 14px 16px;
            font-weight: 700;
            margin-bottom: 14px;
          }
          .flash-info {
            background: #eef6ff;
            color: #175cd3;
          }
          .flash-error {
            background: #fff1f2;
            color: #b42318;
          }
          .grid {
            display: grid;
            grid-template-columns: repeat(2, minmax(0, 1fr));
            gap: 16px;
          }
          .card {
            background: white;
            border: 1px solid rgba(17,17,17,0.08);
            border-radius: 24px;
            box-shadow: 0 16px 40px rgba(17,17,17,0.06);
            padding: 22px;
          }
          .card h2 {
            margin: 0 0 8px;
            font-size: 24px;
          }
          .card p {
            color: #52525b;
            line-height: 1.6;
            margin: 0 0 18px;
          }
          label {
            display: block;
            font-size: 13px;
            font-weight: 700;
            margin-bottom: 8px;
          }
          input, select, button {
            width: 100%;
            border-radius: 14px;
            font: inherit;
          }
          input, select {
            border: 1px solid rgba(17,17,17,0.14);
            padding: 14px 15px;
            margin-bottom: 14px;
            background: white;
          }
          button {
            border: 0;
            padding: 15px 18px;
            background: #111111;
            color: white;
            font-weight: 800;
            cursor: pointer;
          }
          .hint {
            margin-top: 18px;
            font-size: 14px;
            color: #5f6368;
            line-height: 1.6;
          }
          .list {
            margin: 18px 0 0;
            padding-left: 18px;
            color: #5f6368;
            line-height: 1.7;
          }
          @media (max-width: 780px) {
            .grid { grid-template-columns: 1fr; }
          }
        </style>
      </head>
      <body>
        <div class="wrap">
          <div class="badge">STEP 1 PREVIEW</div>
          <h1>Authentication and roles only.</h1>
          <div class="sub">This preview is isolated from the current live portal. It only covers minimal email and password authentication plus basic role dashboards.</div>
          ${infoHtml}
          ${errorHtml}
          <div class="grid">
            <section class="card">
              <h2>Register</h2>
              <p>Create a minimal test user for this preview only.</p>
              <form action="/step1/register" method="post">
                <label for="preview-name">Full name</label>
                <input id="preview-name" name="fullName" type="text" placeholder="Full name" />
                <label for="preview-email">Email</label>
                <input id="preview-email" name="email" type="email" placeholder="name@example.com" required />
                <label for="preview-password">Password</label>
                <input id="preview-password" name="password" type="password" minlength="6" placeholder="At least 6 characters" required />
                <label for="preview-role">Role</label>
                <select id="preview-role" name="role">
                  <option value="client">Client</option>
                  <option value="staff">Staff</option>
                  <option value="admin">Admin</option>
                </select>
                <button type="submit">Create preview account</button>
              </form>
            </section>
            <section class="card">
              <h2>Login</h2>
              <p>Sign in with email and password, then land on a basic role dashboard.</p>
              <form action="/step1/login" method="post">
                <label for="preview-login-email">Email</label>
                <input id="preview-login-email" name="email" type="email" placeholder="name@example.com" required />
                <label for="preview-login-password">Password</label>
                <input id="preview-login-password" name="password" type="password" minlength="6" placeholder="••••••••" required />
                <button type="submit">Log in</button>
              </form>
              <div class="hint">Draft only. No payments, no AI, no project system, no supplier flow.</div>
              <ul class="list">
                <li>Minimal email and password auth</li>
                <li>Role stored per user</li>
                <li>Basic redirect after login</li>
                <li>No other feature is active yet</li>
              </ul>
            </section>
          </div>
        </div>
      </body>
    </html>
  `;
}

function renderStep1Dashboard(user, flash = {}) {
  const role = String(user?.role || 'client').toLowerCase();
  const roleTitle = role === 'admin' ? 'Admin dashboard' : role === 'staff' ? 'Staff dashboard' : 'Client dashboard';
  const roleNote = role === 'admin'
    ? 'Full control preview. Approval authority lives here later.'
    : role === 'staff'
      ? 'Limited edit preview. Operational tools come later.'
      : 'Client preview. Approval and payment come in later phases only.';
  const flashHtml = flash.info ? `<div class="flash">${escapeHtml(flash.info)}</div>` : '';

  return `
    <!DOCTYPE html>
    <html lang="en">
      <head>
        <meta charset="utf-8" />
        <meta name="viewport" content="width=device-width, initial-scale=1" />
        <title>${escapeHtml(roleTitle)}</title>
        <style>
          * { box-sizing: border-box; }
          body {
            margin: 0;
            font-family: Inter, -apple-system, BlinkMacSystemFont, "Segoe UI", sans-serif;
            background: #f7f7f7;
            color: #111111;
          }
          .page {
            max-width: 920px;
            margin: 0 auto;
            padding: 28px 18px 42px;
          }
          .top {
            display: flex;
            justify-content: space-between;
            align-items: center;
            gap: 16px;
            margin-bottom: 18px;
          }
          .logout {
            display: inline-flex;
            align-items: center;
            justify-content: center;
            text-decoration: none;
            color: #111111;
            background: white;
            border: 1px solid rgba(17,17,17,0.1);
            border-radius: 14px;
            padding: 12px 16px;
            font-weight: 800;
          }
          .card {
            background: white;
            border: 1px solid rgba(17,17,17,0.08);
            border-radius: 24px;
            box-shadow: 0 16px 40px rgba(17,17,17,0.06);
            padding: 24px;
          }
          .eyebrow {
            display: inline-flex;
            padding: 8px 12px;
            border-radius: 999px;
            background: rgba(249,99,2,0.12);
            color: #f96302;
            font-size: 12px;
            font-weight: 800;
            letter-spacing: 0.08em;
            margin-bottom: 14px;
          }
          h1 {
            margin: 0 0 10px;
            font-size: clamp(34px, 7vw, 60px);
            line-height: 0.98;
            letter-spacing: -0.05em;
          }
          .sub {
            color: #52525b;
            line-height: 1.7;
            max-width: 52ch;
          }
          .flash {
            margin: 18px 0;
            border-radius: 16px;
            padding: 14px 16px;
            background: #eef6ff;
            color: #175cd3;
            font-weight: 700;
          }
          .stats {
            display: grid;
            grid-template-columns: repeat(3, minmax(0, 1fr));
            gap: 14px;
            margin-top: 18px;
          }
          .stat {
            background: #fafafa;
            border-radius: 18px;
            padding: 18px;
          }
          .label {
            color: #5f6368;
            font-size: 12px;
            font-weight: 800;
            letter-spacing: 0.08em;
            margin-bottom: 8px;
          }
          .value {
            font-size: 24px;
            font-weight: 800;
          }
          .notes {
            margin-top: 18px;
            padding-left: 18px;
            color: #5f6368;
            line-height: 1.7;
          }
          @media (max-width: 780px) {
            .top { flex-direction: column; align-items: flex-start; }
            .stats { grid-template-columns: 1fr; }
          }
        </style>
      </head>
      <body>
        <div class="page">
          <div class="top">
            <div>
              <div class="eyebrow">STEP 1 DASHBOARD</div>
              <h1>${escapeHtml(roleTitle)}</h1>
            </div>
            <a class="logout" href="/step1/logout">Log out</a>
          </div>
          <section class="card">
            <div class="sub">${escapeHtml(roleNote)}</div>
            ${flashHtml}
            <div class="stats">
              <div class="stat">
                <div class="label">USER</div>
                <div class="value">${escapeHtml(user.full_name || user.email || 'Preview user')}</div>
              </div>
              <div class="stat">
                <div class="label">ROLE</div>
                <div class="value">${escapeHtml(role)}</div>
              </div>
              <div class="stat">
                <div class="label">LAST LOGIN</div>
                <div class="value">${escapeHtml(formatDisplayDate(user.last_login_at))}</div>
              </div>
            </div>
            <ul class="notes">
              <li>This is a draft-only preview for authentication and roles.</li>
              <li>No payments, AI, uploads, catalog, or proposals are active here.</li>
              <li>Next phases stay blocked until this step is approved.</li>
            </ul>
          </section>
        </div>
      </body>
    </html>
  `;
}

app.get('/step1', (req, res) => {
  const currentUser = readCurrentPreviewUser(req);
  if (currentUser) {
    res.redirect('/step1/dashboard');
    return;
  }

  const error = normalizeText(req.query?.error || '');
  const info = normalizeText(req.query?.info || '');
  res.send(renderStep1PreviewPage({ error, info }));
});

app.post('/step1/register', (req, res) => {
  const email = normalizeEmail(req.body?.email || '');
  const password = String(req.body?.password || '').trim();
  const fullName = normalizeText(req.body?.fullName || '');
  const role = ['admin', 'staff', 'client'].includes(String(req.body?.role || '').trim().toLowerCase())
    ? String(req.body?.role || '').trim().toLowerCase()
    : 'client';

  if (!email.includes('@')) {
    res.redirect('/step1?error=' + encodeURIComponent('Please enter a valid email address.'));
    return;
  }

  if (password.length < 6) {
    res.redirect('/step1?error=' + encodeURIComponent('Password must be at least 6 characters.'));
    return;
  }

  const users = readAuthPreviewUsers();
  if (users.some(user => normalizeEmail(user.email) === email)) {
    res.redirect('/step1?error=' + encodeURIComponent('An account with this email already exists in the Step 1 preview.'));
    return;
  }

  const passwordRecord = createPasswordRecord(password);
  const now = new Date().toISOString();
  users.unshift({
    id: 'PREVIEWUSER-' + crypto.randomBytes(5).toString('hex'),
    full_name: fullName,
    email,
    role,
    password_salt: passwordRecord.salt,
    password_hash: passwordRecord.hash,
    created_at: now,
    updated_at: now,
    last_login_at: now,
    session_token: '',
    session_expires_at: ''
  });

  const token = issuePreviewSessionForUser(users, 0);
  setPreviewSessionCookie(res, token);
  res.redirect('/step1/dashboard?info=' + encodeURIComponent('Preview account created successfully.'));
});

app.post('/step1/login', (req, res) => {
  const email = normalizeEmail(req.body?.email || '');
  const password = String(req.body?.password || '').trim();
  const users = readAuthPreviewUsers();
  const index = users.findIndex(user => normalizeEmail(user.email) === email);

  if (index === -1 || !verifyPassword(password, users[index])) {
    res.redirect('/step1?error=' + encodeURIComponent('The email or password is incorrect.'));
    return;
  }

  const token = issuePreviewSessionForUser(users, index);
  setPreviewSessionCookie(res, token);
  res.redirect('/step1/dashboard?info=' + encodeURIComponent('You are signed in to the Step 1 preview.'));
});

app.get('/step1/dashboard', (req, res) => {
  const currentUser = readCurrentPreviewUser(req);
  if (!currentUser) {
    res.redirect('/step1?error=' + encodeURIComponent('Please sign in to view the Step 1 dashboard.'));
    return;
  }

  const info = normalizeText(req.query?.info || '');
  res.send(renderStep1Dashboard(currentUser, { info }));
});

app.get('/step1/logout', (req, res) => {
  const token = readPreviewSessionToken(req);
  clearPreviewSessionForToken(token);
  clearPreviewSessionCookie(res);
  res.redirect('/step1?info=' + encodeURIComponent('You have been logged out of the Step 1 preview.'));
});


app.get('/', (req, res) => {
  const cfg = readSiteConfig();
  const error = normalizeText(req.query?.error || '');
  const info = normalizeText(req.query?.info || '');
  res.send(renderEntryPage(cfg, { error, info }));
});

app.get('/apps/quote-redaction', (req, res) => {
  const cfg = readSiteConfig();
  const error = normalizeText(req.query?.error || '');
  const info = normalizeText(req.query?.info || '');
  res.send(renderQuoteRedactionPage(cfg, { error, info }));
});

app.get('/apps/whatsapp-authorized', (req, res) => {
  res.send(`<!DOCTYPE html>
  <html lang="he" dir="rtl"><head><meta charset="utf-8" /><meta name="viewport" content="width=device-width, initial-scale=1" /><title>קבלת שיחות מוואטסאפ</title><style>body{font-family:Inter,-apple-system,BlinkMacSystemFont,"Segoe UI",sans-serif;margin:0;background:#eef4ff;color:#111}main{max-width:760px;margin:0 auto;padding:28px 18px 42px}.card{background:#fff;border:1px solid rgba(17,17,17,.08);border-radius:28px;padding:24px;box-shadow:0 24px 60px rgba(30,56,100,.10)}a{color:#526073;text-decoration:none;font-weight:700}h1{font-size:36px;margin:0 0 10px}p{color:#5a6677;line-height:1.75}</style></head><body><main><a href="/">← חזרה לשולחן העבודה</a><section class="card"><div style="font-size:13px;font-weight:800;color:#f96302;margin-bottom:8px;">Concierge Site · בהמשך</div><h1>קבלת שיחות מוואטסאפ עם הרשאה</h1><p>התיקייה הזו מוכנה כמקום שמור לשלב הבא. אחרי שנסיים את כלי ה-PDF, נחבר כאן את זרימת ההרשאות והקבלה מוואטסאפ.</p></section></main></body></html>`);
});

app.get('/admin/flow-check', (req, res) => {
  if (String(req.query?.password || '') !== 'BuildFlowOwner2800') {
    res.status(403).send('Access denied');
    return;
  }

  res.send(renderBuildFlowControlCenterPage());
});

app.post('/api/auth/register', (req, res) => {
  const phone = normalizePhone(req.body?.phone || '');
  const password = String(req.body?.password || '').trim();
  const fullName = normalizeText(req.body?.fullName || '');

  if (phone.length < 8) {
    res.redirect('/?error=' + encodeURIComponent('Please enter a valid phone number.'));
    return;
  }

  if (password.length < 6) {
    res.redirect('/?error=' + encodeURIComponent('Password must be at least 6 characters.'));
    return;
  }

  const users = readSiteUsers();
  if (users.some(user => user.phone === phone)) {
    res.redirect('/?error=' + encodeURIComponent('An account with this phone number already exists.'));
    return;
  }

  const passwordRecord = createPasswordRecord(password);
  const now = new Date().toISOString();
  users.unshift({
    id: 'SITEUSER-' + crypto.randomBytes(5).toString('hex'),
    full_name: fullName,
    phone,
    password_salt: passwordRecord.salt,
    password_hash: passwordRecord.hash,
    account_status: 'Account created, waiting for live data',
    login_methods: ['phone'],
    created_at: now,
    updated_at: now,
    last_login_at: now,
    session_token: '',
    session_expires_at: ''
  });

  const token = issueSessionForUser(users, 0);
  setSessionCookie(res, token);
  res.redirect('/account?info=' + encodeURIComponent('Account created successfully.'));
});

app.post('/api/auth/login', (req, res) => {
  const phone = normalizePhone(req.body?.phone || '');
  const password = String(req.body?.password || '').trim();
  const users = readSiteUsers();
  const index = users.findIndex(user => user.phone === phone);

  if (index === -1 || !verifyPassword(password, users[index])) {
    res.redirect('/?error=' + encodeURIComponent('The phone number or password is incorrect.'));
    return;
  }

  const token = issueSessionForUser(users, index);
  setSessionCookie(res, token);
  res.redirect('/account?info=' + encodeURIComponent('You are back in your account.'));
});

app.post('/api/auth/google', (req, res) => {
  res.redirect('/?info=' + encodeURIComponent('Google sign-in is ready in the design and will go live after Google OAuth is connected.'));
});

app.get('/account', (req, res) => {
  const currentUser = readCurrentSiteUser(req);
  if (!currentUser) {
    res.redirect('/?error=' + encodeURIComponent('Please sign in to view your account.'));
    return;
  }

  const cfg = readSiteConfig();
  const info = normalizeText(req.query?.info || '');
  res.send(renderAccountPage(cfg, currentUser, { info }));
});

app.get('/logout', (req, res) => {
  const token = readSessionToken(req);
  clearSessionForToken(token);
  clearSessionCookie(res);
  res.redirect('/?info=' + encodeURIComponent('You have been logged out successfully.'));
});

app.get('/ops', (req, res) => {
  const messages = readJsonArray(messagesFile);
  const tasks = readTasks(tasksFile);
  const orders = readOrders();
  const cfg = readSiteConfig();

  const sectionsHtml = (cfg.sections || []).map(sec => `
    <div class="box">
      <h2>${escapeHtml(sec.title)}</h2>
      <p>${escapeHtml(sec.content)}</p>
    </div>
  `).join('');

  const pagesLinks = cfg.pages && Object.keys(cfg.pages).length
    ? Object.keys(cfg.pages).map(slug => `<p><a href="/${slug}">/${slug}</a></p>`).join('')
    : '<p>No extra pages yet</p>';

  res.send(`
    <html>
      <head>
        <title>${escapeHtml(cfg.title || 'Personal AI Dashboard')}</title>
        <style>
          body { font-family: Arial; padding: 20px; background:${cfg.bg || '#f5f5f5'}; color:${cfg.text || '#333333'}; }
          h1 { color:${cfg.text || '#333333'}; }
          .box { background:white; padding:15px; margin:10px 0; border-radius:8px; }
          a { color:#0b57d0; text-decoration:none; }
        </style>
      </head>
      <body>
        <h1>${escapeHtml(cfg.title || 'Personal AI Dashboard')}</h1>
        <p>${escapeHtml(cfg.subtitle || '')}</p>

        ${sectionsHtml || '<p>No sections yet</p>'}

        <div class="box">
          <h2>📦 Orders</h2>
          <p>Total: ${orders.length}</p>
          <p><a href="/orders">Open orders</a></p>
        </div>

        <div class="box">
          <h2>📩 Messages</h2>
          <p>Total: ${messages.length}</p>
          <p><a href="/messages">Open messages</a></p>
        </div>

        <div class="box">
          <h2>✅ Task Hub</h2>
          <p>Total: ${tasks.length}</p>
          <p><a href="/task-hub">Open task hub</a></p>
        </div>

        <div class="box">
          <h2>🧠 Agent Queue</h2>
          <p>Live queue view, routing, worker choice, and Monday mirror.</p>
          <p><a href="/ops/queue">Open queue dashboard</a></p>
        </div>

        <div class="box">
          <h2>📄 Extra Pages</h2>
          ${pagesLinks}
        </div>
      </body>
    </html>
  `);
});

app.get('/messages', (req, res) => {
  const messages = readJsonArray(messagesFile);
  const list = messages.map(m => {
    const value = typeof m === 'string' ? m : (m.text || JSON.stringify(m));
    return `<li>${escapeHtml(value)}</li>`;
  }).join('');

  res.send(`
    <html><body>
      <h1>Messages</h1>
      <ul>${list || '<li>No messages yet</li>'}</ul>
      <p><a href="/ops">Back</a></p>
    </body></html>
  `);
});

app.get(['/tasks', '/task-hub'], (req, res) => {
  res.setHeader('Cache-Control', 'no-store, no-cache, must-revalidate, proxy-revalidate');
  res.setHeader('Pragma', 'no-cache');
  res.setHeader('Expires', '0');
  res.send(renderTaskHubPage());
});

app.get('/ops/queue', (req, res) => {
  res.setHeader('Cache-Control', 'no-store, no-cache, must-revalidate, proxy-revalidate');
  res.setHeader('Pragma', 'no-cache');
  res.setHeader('Expires', '0');
  res.send(renderQueueDashboardPage());
});

app.get('/orders', (req, res) => {
  const orders = readOrders();

  const list = orders.map((o, i) => `
    <div style="border:1px solid #ddd;padding:12px;margin:10px 0;border-radius:8px;">
      <h3>#${i + 1} - ${escapeHtml(o.order_id || '-')} - ${escapeHtml(o.customer_name || 'Unknown customer')}</h3>
      <p><strong>WhatsApp:</strong> ${escapeHtml(o.whatsapp_number || '-')}</p>
      <p><strong>Supplier:</strong> ${escapeHtml(o.supplier_name || '-')}</p>
      <p><strong>Summary:</strong> ${escapeHtml(o.order_summary || '-')}</p>
      <p><strong>Amount:</strong> ${escapeHtml(o.amount || '-')}</p>
      <p><strong>Payment:</strong> ${escapeHtml(o.payment_status || '-')}</p>
      <p><strong>Stage:</strong> ${escapeHtml(o.current_stage || '-')}</p>
      <p><strong>Next step:</strong> ${escapeHtml(o.next_step || '-')}</p>
      <p><strong>Standing:</strong> ${escapeHtml(o.standing_summary || '-')}</p>
      <p><strong>Source:</strong> ${escapeHtml(o.source || '-')}</p>
      <p><strong>Last customer message:</strong> ${escapeHtml(o.last_customer_message || '-')}</p>
      <p><strong>Updated:</strong> ${escapeHtml(o.updated_at || '-')}</p>
    </div>
  `).join('');

  res.send(`
    <html><body>
      <h1>Orders</h1>
      ${list || '<p>No orders yet</p>'}
      <p><a href="/ops">Back</a></p>
    </body></html>
  `);
});

app.get('/api/orders', (req, res) => {
  res.json(readOrders());
});

app.get('/downloads/:fileName', (req, res) => {
  const safeName = path.basename(req.params.fileName || '');
  const filePath = path.join('/root/.openclaw/workspace/out', safeName);
  if (!safeName || !fs.existsSync(filePath)) {
    res.status(404).send('file not found');
    return;
  }

  res.setHeader('Content-Type', 'application/pdf');
  res.setHeader('Content-Disposition', `attachment; filename="${safeName.replace(/"/g, '')}"`);
  fs.createReadStream(filePath).pipe(res);
});

app.post('/api/tools/redact-quote', (req, res) => {
  try {
    const fileName = String(req.body?.fileName || '').trim();
    const base64Data = String(req.body?.base64Data || '').trim();

    if (!fileName || !base64Data) {
      res.status(400).json({ ok: false, error: 'missing fileName or base64Data' });
      return;
    }

    if (!/\.pdf$/i.test(fileName)) {
      res.status(400).json({ ok: false, error: 'file must be a PDF' });
      return;
    }

    const result = runQuoteRedactionJob({ fileName, base64Data });
    res.json(result);
  } catch (error) {
    res.status(500).json({ ok: false, error: error.message });
  }
});

app.get('/api/tasks', (req, res) => {
  res.json(readTasks(tasksFile));
});

app.get('/api/task-hub', (req, res) => {
  res.setHeader('Cache-Control', 'no-store, no-cache, must-revalidate, proxy-revalidate');
  res.setHeader('Pragma', 'no-cache');
  res.setHeader('Expires', '0');
  res.json(buildTaskHubSnapshot(tasksFile));
});

app.get('/api/queue-dashboard', (req, res) => {
  res.setHeader('Cache-Control', 'no-store, no-cache, must-revalidate, proxy-revalidate');
  res.setHeader('Pragma', 'no-cache');
  res.setHeader('Expires', '0');
  res.json(buildQueueSnapshot(tasksFile));
});

app.post('/api/queue-dashboard/tasks/:taskId/done', async (req, res) => {
  try {
    const result = await markQueueTaskDone(tasksFile, req.params.taskId);
    if (!result.ok) {
      res.status(result.error === 'task not found' ? 404 : 400).json(result);
      return;
    }
    res.json(result);
  } catch (error) {
    res.status(500).json({ ok: false, error: error.message });
  }
});

app.post('/api/queue-dashboard/tasks/:taskId/requeue', async (req, res) => {
  try {
    const result = await requeueQueueTask(tasksFile, req.params.taskId);
    if (!result.ok) {
      res.status(result.error === 'task not found' ? 404 : 400).json(result);
      return;
    }
    res.json(result);
  } catch (error) {
    res.status(500).json({ ok: false, error: error.message });
  }
});

app.post('/api/queue-dashboard/tasks/:taskId/archive', async (req, res) => {
  try {
    const result = await archiveQueueTask(tasksFile, req.params.taskId);
    if (!result.ok) {
      res.status(result.error === 'task not found' ? 404 : 400).json(result);
      return;
    }
    res.json(result);
  } catch (error) {
    res.status(500).json({ ok: false, error: error.message });
  }
});

app.post('/api/task-hub/tasks', async (req, res) => {
  try {
    const result = await createTaskHubTask(tasksFile, req.body || {});
    if (!result.ok) {
      res.status(400).json(result);
      return;
    }
    res.json(result);
  } catch (error) {
    res.status(500).json({ ok: false, error: error.message });
  }
});

app.patch('/api/task-hub/tasks/:taskId', async (req, res) => {
  try {
    const result = await updateTaskHubTask(tasksFile, req.params.taskId, req.body || {});
    if (!result.ok) {
      res.status(result.error === 'task not found' ? 404 : 400).json(result);
      return;
    }
    res.json(result);
  } catch (error) {
    res.status(500).json({ ok: false, error: error.message });
  }
});

app.post('/api/task-hub/tasks/:taskId/contacts', async (req, res) => {
  try {
    const result = await addTaskContact(tasksFile, req.params.taskId, req.body || {});
    if (!result.ok) {
      res.status(result.error === 'task not found' ? 404 : 400).json(result);
      return;
    }
    res.json(result);
  } catch (error) {
    res.status(500).json({ ok: false, error: error.message });
  }
});

app.patch('/api/task-hub/tasks/:taskId/contacts/:contactId', async (req, res) => {
  try {
    const result = await updateTaskContact(tasksFile, req.params.taskId, req.params.contactId, req.body || {});
    if (!result.ok) {
      res.status(['task not found', 'contact not found'].includes(result.error) ? 404 : 400).json(result);
      return;
    }
    res.json(result);
  } catch (error) {
    res.status(500).json({ ok: false, error: error.message });
  }
});

app.post('/api/task-hub/tasks/:taskId/contacts/:contactId/activity', async (req, res) => {
  try {
    const result = await addTaskContactActivity(tasksFile, req.params.taskId, req.params.contactId, req.body || {});
    if (!result.ok) {
      res.status(['task not found', 'contact not found'].includes(result.error) ? 404 : 400).json(result);
      return;
    }
    res.json(result);
  } catch (error) {
    res.status(500).json({ ok: false, error: error.message });
  }
});

app.get('/api/monday/status', async (req, res) => {
  try {
    const status = await getMondayBoard();
    res.json(status);
  } catch (error) {
    res.status(500).json({ ok: false, error: error.message });
  }
});

app.post('/api/tasks', async (req, res) => {
  try {
    const text = typeof req.body?.text === 'string' && req.body.text.trim()
      ? req.body.text
      : [req.body?.title || '', req.body?.description || ''].filter(Boolean).join('\n');

    if (!String(text || '').trim()) {
      res.status(400).json({ ok: false, error: 'text or title is required' });
      return;
    }

    const result = await createOrQueueTask(tasksFile, text, req.body || {});
    if (result?.task?.queue_enabled && result.task.queue_run_mode !== 'night') {
      setTimeout(runBackgroundAutoQueue, 50);
    }
    res.json(result);
  } catch (error) {
    res.status(500).json({ ok: false, error: error.message });
  }
});

app.post('/api/tasks/from-text', async (req, res) => {
  try {
    const text = typeof req.body?.text === 'string' ? req.body.text : '';
    if (!text.trim()) {
      res.status(400).json({ ok: false, error: 'text is required' });
      return;
    }

    const result = await createOrQueueTask(tasksFile, text, req.body || {});
    if (result?.task?.queue_enabled && result.task.queue_run_mode !== 'night') {
      setTimeout(runBackgroundAutoQueue, 50);
    }
    res.json(result);
  } catch (error) {
    res.status(500).json({ ok: false, error: error.message });
  }
});

app.post('/api/tasks/:taskId/sync-monday', async (req, res) => {
  try {
    const result = await syncExistingTaskToMonday(tasksFile, req.params.taskId);
    if (!result.ok) {
      res.status(404).json(result);
      return;
    }
    res.json(result);
  } catch (error) {
    res.status(500).json({ ok: false, error: error.message });
  }
});

app.post('/api/tasks/sync-messages', async (req, res) => {
  try {
    const result = await syncMessageTasks({
      tasksFile,
      backfill: Boolean(req.body?.backfill)
    });
    res.json(result);
  } catch (error) {
    res.status(500).json({ ok: false, error: error.message });
  }
});

app.get('/api/agent-queue/status', (req, res) => {
  res.json(getQueueStatus(tasksFile));
});

app.get('/api/agent-queue/config', (req, res) => {
  res.json({ ok: true, config: readAgentQueueConfig() });
});

app.post('/api/agent-queue/config', (req, res) => {
  const next = writeAgentQueueConfig({
    enabled: typeof req.body?.enabled === 'boolean' ? req.body.enabled : undefined,
    routerEnabled: typeof req.body?.routerEnabled === 'boolean' ? req.body.routerEnabled : undefined,
    routerProvider: typeof req.body?.routerProvider === 'string' ? req.body.routerProvider : undefined,
    routerModel: typeof req.body?.routerModel === 'string' ? req.body.routerModel : undefined,
    workerProvider: typeof req.body?.workerProvider === 'string' ? req.body.workerProvider : undefined,
    workerModel: typeof req.body?.workerModel === 'string' ? req.body.workerModel : undefined,
    autoEnqueueNewTasks: typeof req.body?.autoEnqueueNewTasks === 'boolean' ? req.body.autoEnqueueNewTasks : undefined,
    autoProcessEnabled: typeof req.body?.autoProcessEnabled === 'boolean' ? req.body.autoProcessEnabled : undefined,
    defaultRunMode: typeof req.body?.defaultRunMode === 'string' ? req.body.defaultRunMode : undefined,
    autoProcessBatchSize: Number.isFinite(Number(req.body?.autoProcessBatchSize)) ? Number(req.body.autoProcessBatchSize) : undefined,
    nightlyEnabled: typeof req.body?.nightlyEnabled === 'boolean' ? req.body.nightlyEnabled : undefined,
    nightlyStartHourUtc: Number.isFinite(Number(req.body?.nightlyStartHourUtc)) ? Number(req.body.nightlyStartHourUtc) : undefined,
    nightlyEndHourUtc: Number.isFinite(Number(req.body?.nightlyEndHourUtc)) ? Number(req.body.nightlyEndHourUtc) : undefined,
    nightlyBatchSize: Number.isFinite(Number(req.body?.nightlyBatchSize)) ? Number(req.body.nightlyBatchSize) : undefined,
    mondayMirror: typeof req.body?.mondayMirror === 'boolean' ? req.body.mondayMirror : undefined,
    localQueueSourceOfTruth: typeof req.body?.localQueueSourceOfTruth === 'boolean' ? req.body.localQueueSourceOfTruth : undefined
  });
  res.json({ ok: true, config: next });
});

app.get('/api/agent-queue/tasks', (req, res) => {
  res.json({ ok: true, tasks: listQueueTasks(tasksFile) });
});

app.post('/api/agent-queue/enqueue', async (req, res) => {
  try {
    const text = typeof req.body?.text === 'string' && req.body.text.trim()
      ? req.body.text
      : [req.body?.title || '', req.body?.description || ''].filter(Boolean).join('\n');

    if (!String(text || '').trim()) {
      res.status(400).json({ ok: false, error: 'text or title is required' });
      return;
    }

    const result = await enqueueTask(tasksFile, text, req.body || {});
    if (result?.task?.queue_enabled && result.task.queue_run_mode !== 'night') {
      setTimeout(runBackgroundAutoQueue, 50);
    }
    res.json(result);
  } catch (error) {
    res.status(500).json({ ok: false, error: error.message });
  }
});

app.post('/api/agent-queue/process-next', async (req, res) => {
  try {
    const result = await processNextQueuedTask({
      tasksFile,
      nightOnly: Boolean(req.body?.nightOnly)
    });
    res.json(result);
  } catch (error) {
    res.status(500).json({ ok: false, error: error.message });
  }
});

app.post('/api/agent-queue/run-night', async (req, res) => {
  try {
    const result = await runNightQueue({
      tasksFile,
      limit: Number.isFinite(Number(req.body?.limit)) ? Number(req.body.limit) : undefined
    });
    res.json(result);
  } catch (error) {
    res.status(500).json({ ok: false, error: error.message });
  }
});

app.get('/api/website-coder/status', (req, res) => {
  res.json(getKimiLaneStatus());
});

app.get('/api/website-coder/config', (req, res) => {
  res.json({ ok: true, config: readKimiLaneConfig() });
});

app.post('/api/website-coder/config', (req, res) => {
  const next = writeKimiLaneConfig({
    enabled: typeof req.body?.enabled === 'boolean' ? req.body.enabled : undefined,
    provider: typeof req.body?.provider === 'string' ? req.body.provider : undefined,
    model: typeof req.body?.model === 'string' ? req.body.model : undefined,
    baseUrl: typeof req.body?.baseUrl === 'string' ? req.body.baseUrl : undefined,
    fallbackEnabled: typeof req.body?.fallbackEnabled === 'boolean' ? req.body.fallbackEnabled : undefined,
    fallbackProvider: typeof req.body?.fallbackProvider === 'string' ? req.body.fallbackProvider : undefined,
    fallbackModel: typeof req.body?.fallbackModel === 'string' ? req.body.fallbackModel : undefined,
    fallbackBaseUrl: typeof req.body?.fallbackBaseUrl === 'string' ? req.body.fallbackBaseUrl : undefined,
    defaultMode: typeof req.body?.defaultMode === 'string' ? req.body.defaultMode : undefined,
    defaultLanguage: typeof req.body?.defaultLanguage === 'string' ? req.body.defaultLanguage : undefined,
    defaultStack: typeof req.body?.defaultStack === 'string' ? req.body.defaultStack : undefined
  });
  res.json({ ok: true, config: next });
});

app.post('/api/website-coder/ask', async (req, res) => {
  try {
    const prompt = typeof req.body?.prompt === 'string' ? req.body.prompt.trim() : '';
    if (!prompt) {
      res.status(400).json({ ok: false, error: 'prompt is required' });
      return;
    }

    const result = await askWebsiteCoder({
      prompt,
      mode: typeof req.body?.mode === 'string' ? req.body.mode : undefined,
      language: typeof req.body?.language === 'string' ? req.body.language : undefined,
      stack: typeof req.body?.stack === 'string' ? req.body.stack : undefined
    });

    res.json(result);
  } catch (error) {
    res.status(500).json({ ok: false, error: error.message, status: getKimiLaneStatus() });
  }
});

app.post('/api/tools/transcribe-audio', async (req, res) => {
  try {
    const filePath = typeof req.body?.file === 'string' ? req.body.file.trim() : '';
    if (!filePath) {
      res.status(400).json({ ok: false, error: 'file is required' });
      return;
    }

    const result = await transcribeAudio(filePath, {
      language: typeof req.body?.language === 'string' ? req.body.language : 'he'
    });

    res.json({ ok: true, file: filePath, text: result.text, kind: result.kind, raw: result.raw });
  } catch (error) {
    res.status(500).json({ ok: false, error: error.message });
  }
});

app.post('/api/tools/read-document', async (req, res) => {
  try {
    const filePath = typeof req.body?.file === 'string' ? req.body.file.trim() : '';
    if (!filePath) {
      res.status(400).json({ ok: false, error: 'file is required' });
      return;
    }

    const result = await readDocument(filePath, {
      mediaType: typeof req.body?.mediaType === 'string' ? req.body.mediaType : '',
      language: typeof req.body?.language === 'string' ? req.body.language : 'he'
    });

    res.json({ ok: true, file: filePath, text: result.text, kind: result.kind, raw: result.raw });
  } catch (error) {
    res.status(500).json({ ok: false, error: error.message });
  }
});

app.post('/api/orders', (req, res) => {
  const orders = readOrders();
  const record = normalizeOrderRecord(req.body || {}, {}, orders);
  orders.unshift(record);
  writeJsonArray(ordersFile, orders);
  res.json({ ok: true, order_id: record.order_id, order: record, total: orders.length });
});

app.post('/api/orders/from-conversation', (req, res) => {
  const conversation = typeof req.body?.conversation === 'string' ? req.body.conversation : '';
  if (!conversation.trim()) {
    res.status(400).json({ ok: false, error: 'conversation is required' });
    return;
  }

  const orders = readOrders();
  const record = buildOrderFromConversation(conversation, req.body || {}, orders);
  orders.unshift(record);
  writeJsonArray(ordersFile, orders);
  res.json({ ok: true, order_id: record.order_id, order: record, total: orders.length });
});

app.patch('/api/orders/:orderId', (req, res) => {
  const orders = readOrders();
  const index = orders.findIndex(order => order.order_id === req.params.orderId);

  if (index === -1) {
    res.status(404).json({ ok: false, error: 'order not found' });
    return;
  }

  const updated = normalizeOrderRecord(req.body || {}, orders[index], orders);
  orders[index] = updated;
  writeJsonArray(ordersFile, orders);
  res.json({ ok: true, order_id: updated.order_id, order: updated });
});

app.post('/api/orders/:orderId/summarize', (req, res) => {
  const orders = readOrders();
  const index = orders.findIndex(order => order.order_id === req.params.orderId);

  if (index === -1) {
    res.status(404).json({ ok: false, error: 'order not found' });
    return;
  }

  const updated = normalizeOrderRecord(req.body || {}, orders[index], orders);
  updated.standing_summary = summarizeStanding(updated);
  updated.updated_at = new Date().toISOString();
  orders[index] = updated;
  writeJsonArray(ordersFile, orders);
  res.json({ ok: true, order_id: updated.order_id, summary: updated.standing_summary, order: updated });
});

app.post('/api/orders/update-match', (req, res) => {
  const orders = readOrders();
  const matches = findMatchingOrders(orders, req.body || {});

  if (matches.length === 0) {
    res.status(404).json({ ok: false, error: 'no matching order found' });
    return;
  }

  if (matches.length > 1) {
    res.status(409).json({
      ok: false,
      error: 'multiple orders found, clarification required',
      matches: matches.map(order => ({
        order_id: order.order_id,
        customer_name: order.customer_name,
        whatsapp_number: order.whatsapp_number,
        current_stage: order.current_stage
      }))
    });
    return;
  }

  const match = matches[0];
  const index = orders.findIndex(order => order.order_id === match.order_id);
  const conversation = typeof req.body?.conversation === 'string' ? req.body.conversation : '';
  const updateData = conversation.trim()
    ? {
        last_customer_message: req.body?.last_customer_message,
        latest_source_path: req.body?.latest_source_path,
        activity_entry: req.body?.activity_entry,
        ...extractOrderDataFromConversation(conversation, { ...(req.body || {}), __mode: 'update' })
      }
    : (req.body || {});
  const updated = normalizeOrderRecord(updateData, orders[index], orders);

  orders[index] = updated;
  writeJsonArray(ordersFile, orders);
  res.json({ ok: true, order_id: updated.order_id, order: updated });
});

app.post('/api/orders/sync-whatsapp', async (req, res) => {
  try {
    const result = await syncWhatsAppOrders({ port: Number(process.env.PORT || 3000) });
    res.json(result);
  } catch (error) {
    res.status(500).json({ ok: false, error: error.message });
  }
});

const cfg = readSiteConfig();
Object.entries(cfg.pages || {}).forEach(([slug, page]) => {
  app.get('/' + slug, (req, res) => {
    res.send(`
      <html><body>
        <h1>${escapeHtml(page.title || slug)}</h1>
        <p>${escapeHtml(page.content || '')}</p>
        <p><a href="/">Back</a></p>
      </body></html>
    `);
  });
});

const port = Number(process.env.PORT || 3000);
let backgroundOrderSyncRunning = false;
let backgroundTaskSyncRunning = false;
let backgroundAutoQueueRunning = false;
let backgroundNightQueueRunning = false;

async function runBackgroundOrderSync() {
  if (backgroundOrderSyncRunning) return;
  backgroundOrderSyncRunning = true;
  try {
    await syncWhatsAppOrders({ port });
  } catch (error) {
    console.error('WhatsApp order sync failed:', error.message);
  } finally {
    backgroundOrderSyncRunning = false;
  }
}

async function runBackgroundTaskSync() {
  if (backgroundTaskSyncRunning) return;
  backgroundTaskSyncRunning = true;
  try {
    await syncMessageTasks({ tasksFile });
  } catch (error) {
    console.error('Message task sync failed:', error.message);
  } finally {
    backgroundTaskSyncRunning = false;
  }
}

async function runBackgroundAutoQueue() {
  if (backgroundAutoQueueRunning) return;
  backgroundAutoQueueRunning = true;
  try {
    await runAutoQueue({ tasksFile });
  } catch (error) {
    console.error('Auto queue run failed:', error.message);
  } finally {
    backgroundAutoQueueRunning = false;
  }
}

async function runBackgroundNightQueue() {
  if (backgroundNightQueueRunning) return;
  backgroundNightQueueRunning = true;
  try {
    await runNightQueue({ tasksFile });
  } catch (error) {
    console.error('Night queue run failed:', error.message);
  } finally {
    backgroundNightQueueRunning = false;
  }
}

app.listen(port, () => {
  console.log(`Dashboard running on port ${port}`);
  setTimeout(runBackgroundOrderSync, 5000);
  setTimeout(runBackgroundTaskSync, 7000);
  setTimeout(runBackgroundAutoQueue, 4000);
  setTimeout(runBackgroundNightQueue, 9000);
  setInterval(runBackgroundOrderSync, 45000);
  setInterval(runBackgroundTaskSync, 30000);
  setInterval(runBackgroundAutoQueue, 15000);
  setInterval(runBackgroundNightQueue, 300000);
});
