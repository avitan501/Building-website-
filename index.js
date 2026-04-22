
const express = require('express');
const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
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
const app = express();

app.use(express.json({ limit: '1mb' }));
app.use(express.urlencoded({ extended: false }));

const messagesFile = '/root/mysite/messages.json';
const tasksFile = '/root/mysite/tasks.json';
const ordersFile = '/root/mysite/orders.json';
const siteConfigFile = '/root/mysite/site-config.json';
const siteUsersFile = '/root/mysite/data/site_users.json';

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
    title: 'כניסה לחשבון',
    subtitle: 'התחברות מהירה כדי לראות את סטטוס החשבון וההזמנות',
    bg: '#f5f5f5',
    text: '#111111',
    brand: {
      name: 'Build Your Account',
      accent: '#f96302',
      dark: '#111111',
      light: '#ffffff'
    },
    entryPage: {
      eyebrow: 'WELCOME',
      headline: 'החשבון שלכם, מהיר וברור',
      subheadline: 'התחברו עם Google או עם טלפון וסיסמה כדי לראות סטטוס חשבון, הזמנות ופעילות.',
      phoneLoginTitle: 'כניסה עם טלפון',
      googleButtonLabel: 'המשך עם Google',
      registerButtonLabel: 'פתיחת חשבון חדש',
      tiles: [
        {
          title: 'סטטוס חשבון',
          content: 'הלקוחות חוזרים ורואים את מצב החשבון שלהם בכל רגע.'
        },
        {
          title: 'כניסה מהירה',
          content: 'טלפון וסיסמה היום, Google אחרי חיבור OAuth.'
        },
        {
          title: 'אווירה מסחרית',
          content: 'צבעים חמים וקוביות השראה בסגנון Home Depot.'
        },
        {
          title: 'פרופורציות נקיות',
          content: 'טיפוגרפיה ומרווחים בהשראת Apple ו-Tesla.'
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
  if (!value) return 'עדיין אין נתון';
  const date = new Date(value);
  if (Number.isNaN(date.getTime())) return 'עדיין אין נתון';
  return date.toISOString().slice(0, 16).replace('T', ' ');
}

function renderEntryPage(cfg, flash = {}) {
  const theme = {
    accent: cfg.brand?.accent || '#f96302',
    dark: cfg.brand?.dark || '#111111',
    light: cfg.brand?.light || '#ffffff',
    bg: cfg.bg || '#f5f5f5',
    text: cfg.text || '#111111',
    name: cfg.brand?.name || cfg.title || 'Build Your Account'
  };
  const entry = cfg.entryPage || {};
  const tiles = Array.isArray(entry.tiles) && entry.tiles.length ? entry.tiles : [];
  const flashHtml = flash.error
    ? `<div class="flash flash-error">${escapeHtml(flash.error)}</div>`
    : flash.info
      ? `<div class="flash flash-info">${escapeHtml(flash.info)}</div>`
      : '';
  const googleHelp = process.env.GOOGLE_CLIENT_ID
    ? 'Google login מוכן לחיבור ברגע שנפעיל OAuth מלא.'
    : 'Google login יוצג כבר עכשיו, ויהפוך לאמיתי אחרי חיבור Google OAuth.';

  return `
    <!DOCTYPE html>
    <html lang="he" dir="rtl">
      <head>
        <meta charset="utf-8" />
        <meta name="viewport" content="width=device-width, initial-scale=1" />
        <title>${escapeHtml(cfg.title || 'כניסה לחשבון')}</title>
        <style>
          :root {
            --accent: ${escapeHtml(theme.accent)};
            --dark: ${escapeHtml(theme.dark)};
            --light: ${escapeHtml(theme.light)};
            --bg: ${escapeHtml(theme.bg)};
            --text: ${escapeHtml(theme.text)};
          }
          * { box-sizing: border-box; }
          body {
            margin: 0;
            font-family: Inter, -apple-system, BlinkMacSystemFont, "Segoe UI", sans-serif;
            background: linear-gradient(180deg, #fff8f2 0%, var(--bg) 48%, #ffffff 100%);
            color: var(--text);
          }
          .top-strip {
            background: var(--accent);
            color: white;
            text-align: center;
            padding: 12px 18px;
            font-size: 14px;
            font-weight: 700;
            letter-spacing: 0.02em;
          }
          .page {
            max-width: 1220px;
            margin: 0 auto;
            padding: 28px 20px 40px;
          }
          .brand-row {
            display: flex;
            align-items: center;
            justify-content: space-between;
            gap: 16px;
            margin-bottom: 28px;
          }
          .brand-lockup {
            display: flex;
            align-items: center;
            gap: 14px;
          }
          .brand-box {
            width: 54px;
            height: 54px;
            border-radius: 14px;
            background: var(--accent);
            color: white;
            display: grid;
            place-items: center;
            font-size: 13px;
            font-weight: 900;
            line-height: 1;
            text-align: center;
            box-shadow: 0 18px 35px rgba(249, 99, 2, 0.25);
          }
          .brand-name {
            font-size: 24px;
            font-weight: 800;
          }
          .brand-sub {
            color: #5f6368;
            font-size: 14px;
          }
          .hero {
            display: grid;
            grid-template-columns: minmax(0, 1.25fr) minmax(320px, 460px);
            gap: 26px;
            align-items: stretch;
          }
          .hero-panel,
          .auth-card,
          .tile,
          .mini-card {
            background: rgba(255,255,255,0.9);
            border: 1px solid rgba(17,17,17,0.08);
            border-radius: 28px;
            box-shadow: 0 22px 60px rgba(17,17,17,0.08);
          }
          .hero-panel {
            padding: 34px;
            position: relative;
            overflow: hidden;
          }
          .hero-panel::before {
            content: "";
            position: absolute;
            inset: 0;
            background: linear-gradient(135deg, rgba(249,99,2,0.14), transparent 38%, rgba(17,17,17,0.05));
            pointer-events: none;
          }
          .eyebrow {
            display: inline-flex;
            align-items: center;
            gap: 8px;
            padding: 8px 12px;
            border-radius: 999px;
            background: rgba(249,99,2,0.12);
            color: var(--accent);
            font-size: 12px;
            font-weight: 800;
            letter-spacing: 0.12em;
            margin-bottom: 18px;
          }
          h1 {
            font-size: clamp(42px, 6vw, 74px);
            line-height: 0.95;
            margin: 0 0 18px;
            letter-spacing: -0.05em;
            max-width: 9ch;
          }
          .hero-copy {
            font-size: 18px;
            line-height: 1.7;
            color: #3c4043;
            max-width: 54ch;
            margin-bottom: 24px;
          }
          .hero-badges {
            display: flex;
            flex-wrap: wrap;
            gap: 12px;
            margin-bottom: 28px;
          }
          .hero-badge {
            padding: 11px 14px;
            border-radius: 14px;
            background: white;
            border: 1px solid rgba(17,17,17,0.08);
            font-size: 14px;
            font-weight: 700;
          }
          .tile-grid {
            display: grid;
            grid-template-columns: repeat(2, minmax(0, 1fr));
            gap: 16px;
          }
          .tile {
            padding: 20px;
            min-height: 154px;
            position: relative;
          }
          .tile::after {
            content: "";
            position: absolute;
            inset-inline-start: 0;
            top: 0;
            width: 8px;
            height: 100%;
            background: linear-gradient(180deg, var(--accent), #ffbb80);
            border-radius: 28px 0 0 28px;
          }
          .tile strong {
            display: block;
            font-size: 24px;
            margin-bottom: 10px;
            line-height: 1.05;
          }
          .tile p {
            margin: 0;
            line-height: 1.6;
            color: #4f5358;
          }
          .auth-card {
            padding: 24px;
            display: flex;
            flex-direction: column;
          }
          .auth-card h2 {
            margin: 0 0 8px;
            font-size: 30px;
            letter-spacing: -0.04em;
          }
          .auth-card p {
            margin: 0;
            color: #5f6368;
            line-height: 1.6;
          }
          .flash {
            margin: 18px 0 0;
            padding: 12px 14px;
            border-radius: 14px;
            font-size: 14px;
            font-weight: 700;
          }
          .flash-error { background: #fff2ee; color: #b42318; }
          .flash-info { background: #eef6ff; color: #175cd3; }
          .google-form { margin-top: 22px; }
          .google-button,
          .primary-button,
          .secondary-button {
            width: 100%;
            border: 0;
            border-radius: 16px;
            padding: 15px 18px;
            font-size: 15px;
            font-weight: 800;
            cursor: pointer;
            transition: transform 0.15s ease, box-shadow 0.15s ease, opacity 0.15s ease;
          }
          .google-button:hover,
          .primary-button:hover,
          .secondary-button:hover { transform: translateY(-1px); }
          .google-button {
            background: #ffffff;
            color: var(--dark);
            border: 1px solid rgba(17,17,17,0.12);
          }
          .primary-button {
            background: var(--accent);
            color: white;
            box-shadow: 0 18px 35px rgba(249, 99, 2, 0.26);
          }
          .secondary-button {
            background: #111111;
            color: white;
          }
          .google-help,
          .security-note,
          .toggle-line {
            margin-top: 10px;
            font-size: 13px;
            color: #5f6368;
            line-height: 1.6;
          }
          .divider {
            display: flex;
            align-items: center;
            gap: 12px;
            color: #90959c;
            font-size: 12px;
            font-weight: 800;
            margin: 22px 0;
            letter-spacing: 0.1em;
          }
          .divider::before,
          .divider::after {
            content: "";
            flex: 1;
            height: 1px;
            background: rgba(17,17,17,0.1);
          }
          .auth-tabs {
            display: grid;
            grid-template-columns: 1fr 1fr;
            gap: 10px;
            margin-bottom: 18px;
          }
          .tab-button {
            border: 1px solid rgba(17,17,17,0.1);
            background: #f3f4f6;
            color: #111111;
            border-radius: 14px;
            padding: 12px;
            font-weight: 800;
            cursor: pointer;
          }
          .tab-button.is-active {
            background: rgba(249,99,2,0.12);
            border-color: rgba(249,99,2,0.3);
            color: var(--accent);
          }
          .form-panel { display: none; }
          .form-panel.is-active { display: block; }
          label {
            display: block;
            font-size: 13px;
            font-weight: 800;
            color: #2c2f33;
            margin: 12px 0 8px;
          }
          input {
            width: 100%;
            border-radius: 14px;
            border: 1px solid rgba(17,17,17,0.14);
            background: white;
            padding: 15px 16px;
            font: inherit;
          }
          input:focus {
            outline: 2px solid rgba(249,99,2,0.22);
            border-color: var(--accent);
          }
          .mini-grid {
            display: grid;
            grid-template-columns: repeat(3, minmax(0, 1fr));
            gap: 14px;
            margin-top: 18px;
          }
          .mini-card {
            padding: 16px;
          }
          .mini-card strong {
            display: block;
            font-size: 13px;
            color: #5f6368;
            margin-bottom: 8px;
          }
          .mini-card span {
            font-size: 18px;
            font-weight: 800;
            line-height: 1.25;
          }
          @media (max-width: 980px) {
            .hero { grid-template-columns: 1fr; }
          }
          @media (max-width: 640px) {
            .page { padding-inline: 14px; }
            .hero-panel,
            .auth-card { padding: 22px; }
            .tile-grid,
            .mini-grid { grid-template-columns: 1fr; }
          }
        </style>
      </head>
      <body>
        <div class="top-strip">SPRING BUILD MODE, צבעים חמים, כניסה מהירה ומבנה נקי.</div>
        <main class="page">
          <div class="brand-row">
            <div class="brand-lockup">
              <div class="brand-box">BUILD</div>
              <div>
                <div class="brand-name">${escapeHtml(theme.name)}</div>
                <div class="brand-sub">${escapeHtml(cfg.subtitle || '')}</div>
              </div>
            </div>
          </div>

          <section class="hero">
            <div class="hero-panel">
              <div class="eyebrow">${escapeHtml(entry.eyebrow || 'WELCOME')}</div>
              <h1>${escapeHtml(entry.headline || 'כניסה מהירה לחשבון')}</h1>
              <div class="hero-copy">${escapeHtml(entry.subheadline || '')}</div>

              <div class="hero-badges">
                <div class="hero-badge">Home Depot energy</div>
                <div class="hero-badge">Apple/Tesla spacing</div>
                <div class="hero-badge">Status-first account</div>
              </div>

              <div class="tile-grid">
                ${tiles.map(tile => `
                  <article class="tile">
                    <strong>${escapeHtml(tile.title || '')}</strong>
                    <p>${escapeHtml(tile.content || '')}</p>
                  </article>
                `).join('')}
              </div>

              <div class="mini-grid">
                <div class="mini-card">
                  <strong>גישה חוזרת</strong>
                  <span>שמירה מאובטחת כדי שהלקוח יחזור לחשבון שלו.</span>
                </div>
                <div class="mini-card">
                  <strong>פרופורציות</strong>
                  <span>כותרות גדולות, הרבה אוויר ומוקד ברור לפעולה.</span>
                </div>
                <div class="mini-card">
                  <strong>שלב הבא</strong>
                  <span>אחרי הכניסה, נחבר סטטוס הזמנות וחשבון אמיתי.</span>
                </div>
              </div>
            </div>

            <aside class="auth-card">
              <h2>${escapeHtml(entry.phoneLoginTitle || 'כניסה לחשבון')}</h2>
              <p>כניסה אחת ברורה עם שני מסלולים, Google או טלפון וסיסמה.</p>
              ${flashHtml}

              <form class="google-form" action="/api/auth/google" method="post">
                <button class="google-button" type="submit">${escapeHtml(entry.googleButtonLabel || 'המשך עם Google')}</button>
              </form>
              <div class="google-help">${escapeHtml(googleHelp)}</div>

              <div class="divider">או</div>

              <div class="auth-tabs">
                <button type="button" class="tab-button is-active" data-tab="login">כניסה</button>
                <button type="button" class="tab-button" data-tab="register">הרשמה</button>
              </div>

              <form class="form-panel is-active" data-panel="login" action="/api/auth/login" method="post">
                <label for="login-phone">טלפון</label>
                <input id="login-phone" name="phone" type="tel" inputmode="tel" placeholder="0501234567" required />

                <label for="login-password">סיסמה</label>
                <input id="login-password" name="password" type="password" minlength="6" placeholder="••••••••" required />

                <div style="height:14px"></div>
                <button class="primary-button" type="submit">התחברות לחשבון</button>
              </form>

              <form class="form-panel" data-panel="register" action="/api/auth/register" method="post">
                <label for="register-name">שם מלא</label>
                <input id="register-name" name="fullName" type="text" placeholder="איך לקרוא לכם" />

                <label for="register-phone">טלפון</label>
                <input id="register-phone" name="phone" type="tel" inputmode="tel" placeholder="0501234567" required />

                <label for="register-password">סיסמה</label>
                <input id="register-password" name="password" type="password" minlength="6" placeholder="לפחות 6 תווים" required />

                <div style="height:14px"></div>
                <button class="secondary-button" type="submit">${escapeHtml(entry.registerButtonLabel || 'פתיחת חשבון חדש')}</button>
              </form>

              <div class="security-note">הסיסמה נשמרת בשרת בצורה מוצפנת. כדי להפעיל Google אמיתי, צריך לחבר Google OAuth.</div>
              <div class="toggle-line">נבנה את האתר דף דף. הדף הזה הוא דף הכניסה והחזרה לחשבון.</div>
            </aside>
          </section>
        </main>

        <script>
          const tabs = document.querySelectorAll('[data-tab]');
          const panels = document.querySelectorAll('[data-panel]');
          tabs.forEach(button => {
            button.addEventListener('click', () => {
              const selected = button.getAttribute('data-tab');
              tabs.forEach(tab => tab.classList.toggle('is-active', tab === button));
              panels.forEach(panel => panel.classList.toggle('is-active', panel.getAttribute('data-panel') === selected));
            });
          });
        </script>
      </body>
    </html>
  `;
}

function renderAccountPage(cfg, user, flash = {}) {
  const theme = {
    accent: cfg.brand?.accent || '#f96302',
    dark: cfg.brand?.dark || '#111111',
    light: cfg.brand?.light || '#ffffff'
  };
  const displayName = user.full_name || user.phone || 'לקוח';
  const flashHtml = flash.info ? `<div class="flash">${escapeHtml(flash.info)}</div>` : '';

  return `
    <!DOCTYPE html>
    <html lang="he" dir="rtl">
      <head>
        <meta charset="utf-8" />
        <meta name="viewport" content="width=device-width, initial-scale=1" />
        <title>החשבון שלי</title>
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
            background: linear-gradient(180deg, #fff8f2 0%, #f7f7f7 100%);
            color: #111111;
          }
          .top-strip {
            background: var(--accent);
            color: white;
            text-align: center;
            padding: 12px 18px;
            font-size: 14px;
            font-weight: 700;
          }
          .page {
            max-width: 1180px;
            margin: 0 auto;
            padding: 28px 20px 40px;
          }
          .topbar {
            display: flex;
            justify-content: space-between;
            align-items: center;
            gap: 14px;
            margin-bottom: 20px;
          }
          .logout {
            display: inline-flex;
            align-items: center;
            justify-content: center;
            background: #111111;
            color: white;
            text-decoration: none;
            border-radius: 14px;
            padding: 12px 16px;
            font-weight: 800;
          }
          .hero {
            background: white;
            border-radius: 30px;
            padding: 30px;
            box-shadow: 0 20px 50px rgba(17,17,17,0.08);
            border: 1px solid rgba(17,17,17,0.08);
            margin-bottom: 18px;
          }
          .eyebrow {
            display: inline-block;
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
            margin: 0 0 10px;
            font-size: clamp(38px, 6vw, 66px);
            line-height: 0.95;
            letter-spacing: -0.05em;
          }
          .subcopy {
            color: #52525b;
            font-size: 18px;
            line-height: 1.7;
            max-width: 52ch;
          }
          .flash {
            margin-top: 18px;
            padding: 12px 14px;
            border-radius: 14px;
            background: #eef6ff;
            color: #175cd3;
            font-weight: 700;
          }
          .stats,
          .tiles {
            display: grid;
            grid-template-columns: repeat(3, minmax(0, 1fr));
            gap: 16px;
          }
          .stats { margin-bottom: 18px; }
          .card {
            background: white;
            border-radius: 24px;
            padding: 22px;
            border: 1px solid rgba(17,17,17,0.08);
            box-shadow: 0 18px 45px rgba(17,17,17,0.06);
          }
          .card .label {
            font-size: 12px;
            letter-spacing: 0.1em;
            font-weight: 800;
            color: #5f6368;
            margin-bottom: 10px;
          }
          .card .value {
            font-size: 26px;
            font-weight: 800;
            line-height: 1.15;
          }
          .card p {
            margin: 10px 0 0;
            color: #52525b;
            line-height: 1.6;
          }
          .accent-card {
            position: relative;
            overflow: hidden;
          }
          .accent-card::before {
            content: "";
            position: absolute;
            inset-inline-start: 0;
            top: 0;
            width: 8px;
            height: 100%;
            background: linear-gradient(180deg, var(--accent), #ffbb80);
          }
          @media (max-width: 860px) {
            .stats,
            .tiles { grid-template-columns: 1fr; }
            .topbar { flex-direction: column; align-items: stretch; }
          }
        </style>
      </head>
      <body>
        <div class="top-strip">החשבון האישי שלכם, עם שמירה לחזרה מהירה.</div>
        <main class="page">
          <div class="topbar">
            <div>
              <div style="font-size:24px;font-weight:800;">${escapeHtml(cfg.brand?.name || 'Build Your Account')}</div>
              <div style="color:#5f6368;">מצב חשבון, כניסה וחזרה לפעילות</div>
            </div>
            <a class="logout" href="/logout">התנתקות</a>
          </div>

          <section class="hero">
            <div class="eyebrow">ACCOUNT STATUS</div>
            <h1>שלום ${escapeHtml(displayName)}</h1>
            <div class="subcopy">מכאן הלקוח חוזר שוב ושוב כדי לראות מצב חשבון, הזמנות ופעילות. בשלב הבא נחבר לכאן סטטוס אמיתי מהמערכת.</div>
            ${flashHtml}
          </section>

          <section class="stats">
            <article class="card accent-card">
              <div class="label">STATUS</div>
              <div class="value">${escapeHtml(user.account_status || 'חשבון פעיל')}</div>
              <p>זה המקום שבו נציג בעתיד סטטוס לקוח, הזמנות, תשלומים או בקשות.</p>
            </article>
            <article class="card">
              <div class="label">PHONE</div>
              <div class="value">${escapeHtml(user.phone || 'לא זמין')}</div>
              <p>המשתמש מזוהה לפי טלפון וסשן שמור לחזרה נוחה.</p>
            </article>
            <article class="card">
              <div class="label">LAST LOGIN</div>
              <div class="value">${escapeHtml(formatDisplayDate(user.last_login_at))}</div>
              <p>אפשר להמשיך מכאן לדף הזמנות, סטטוס עבודה או אזור אישי מלא.</p>
            </article>
          </section>

          <section class="tiles">
            <article class="card accent-card">
              <div class="label">JOINED</div>
              <div class="value">${escapeHtml(formatDisplayDate(user.created_at))}</div>
              <p>החשבון נשמר לחזרה עתידית בלי לפתוח משתמש מחדש.</p>
            </article>
            <article class="card">
              <div class="label">LOGIN METHOD</div>
              <div class="value">${escapeHtml((user.login_methods || ['phone']).join(' + '))}</div>
              <p>כרגע פעיל טלפון וסיסמה. Google יופעל כשנחבר OAuth אמיתי.</p>
            </article>
            <article class="card">
              <div class="label">NEXT STEP</div>
              <div class="value">חיבור סטטוס אמיתי</div>
              <p>בשלב הבא נחבר הזמנות, מצב חשבון, היסטוריית פעולות וקריאות שירות.</p>
            </article>
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


app.get('/', (req, res) => {
  const currentUser = readCurrentSiteUser(req);
  if (currentUser) {
    res.redirect('/account');
    return;
  }

  const cfg = readSiteConfig();
  const error = normalizeText(req.query?.error || '');
  const info = normalizeText(req.query?.info || '');
  res.send(renderEntryPage(cfg, { error, info }));
});

app.post('/api/auth/register', (req, res) => {
  const phone = normalizePhone(req.body?.phone || '');
  const password = String(req.body?.password || '').trim();
  const fullName = normalizeText(req.body?.fullName || '');

  if (phone.length < 8) {
    res.redirect('/?error=' + encodeURIComponent('צריך להזין מספר טלפון תקין.'));
    return;
  }

  if (password.length < 6) {
    res.redirect('/?error=' + encodeURIComponent('הסיסמה חייבת להכיל לפחות 6 תווים.'));
    return;
  }

  const users = readSiteUsers();
  if (users.some(user => user.phone === phone)) {
    res.redirect('/?error=' + encodeURIComponent('כבר קיים חשבון עם מספר הטלפון הזה.'));
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
    account_status: 'חשבון נוצר, ממתין לחיבור נתונים',
    login_methods: ['phone'],
    created_at: now,
    updated_at: now,
    last_login_at: now,
    session_token: '',
    session_expires_at: ''
  });

  const token = issueSessionForUser(users, 0);
  setSessionCookie(res, token);
  res.redirect('/account?info=' + encodeURIComponent('החשבון נוצר בהצלחה.'));
});

app.post('/api/auth/login', (req, res) => {
  const phone = normalizePhone(req.body?.phone || '');
  const password = String(req.body?.password || '').trim();
  const users = readSiteUsers();
  const index = users.findIndex(user => user.phone === phone);

  if (index === -1 || !verifyPassword(password, users[index])) {
    res.redirect('/?error=' + encodeURIComponent('הטלפון או הסיסמה לא נכונים.'));
    return;
  }

  const token = issueSessionForUser(users, index);
  setSessionCookie(res, token);
  res.redirect('/account?info=' + encodeURIComponent('חזרת בהצלחה לחשבון שלך.'));
});

app.post('/api/auth/google', (req, res) => {
  res.redirect('/?info=' + encodeURIComponent('Google login מוכן בעיצוב, ויופעל סופית אחרי חיבור Google OAuth.'));
});

app.get('/account', (req, res) => {
  const currentUser = readCurrentSiteUser(req);
  if (!currentUser) {
    res.redirect('/?error=' + encodeURIComponent('צריך להתחבר כדי לראות את החשבון.'));
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
  res.redirect('/?info=' + encodeURIComponent('התנתקת בהצלחה.'));
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
          <h2>✅ Tasks</h2>
          <p>Total: ${tasks.length}</p>
          <p><a href="/tasks">Open tasks</a></p>
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

app.get('/tasks', (req, res) => {
  const tasks = readTasks(tasksFile);
  const list = tasks.map(t => {
    if (typeof t === 'string') return `<li>${escapeHtml(t)}</li>`;
    return `<li><strong>${escapeHtml(t.id || '-')}</strong> - <strong>${escapeHtml(t.title || 'Untitled task')}</strong> - ${escapeHtml(t.status || 'open')} - ${escapeHtml(t.priority || 'normal')}${t.monday_item_id ? ` - Monday ${escapeHtml(t.monday_item_id)}` : ''}</li>`;
  }).join('');

  res.send(`
    <html><body>
      <h1>Tasks</h1>
      <ul>${list || '<li>No tasks yet</li>'}</ul>
      <p><a href="/ops/queue">Open queue dashboard</a></p>
      <p><a href="/ops">Back</a></p>
    </body></html>
  `);
});

app.get('/ops/queue', (req, res) => {
  const summary = getQueueStatus(tasksFile);
  const queueTasks = listQueueTasks(tasksFile).slice(0, 50);
  const counts = Object.entries(summary.counts || {})
    .map(([key, value]) => `<span class="pill"><strong>${escapeHtml(key)}</strong> ${escapeHtml(value)}</span>`)
    .join(' ');

  const rows = queueTasks.map(task => `
    <tr>
      <td>${escapeHtml(task.id || '-')}</td>
      <td>${escapeHtml(task.title || '')}</td>
      <td>${escapeHtml(task.queue_status || '-')}</td>
      <td>${escapeHtml(task.queue_run_mode || '-')}</td>
      <td>${escapeHtml(task.queue_brain || '-')}</td>
      <td>${escapeHtml(task.priority || '-')}</td>
      <td>${escapeHtml(task.updated_at || '-')}</td>
      <td>${task.monday_url ? `<a href="${escapeHtml(task.monday_url)}" target="_blank" rel="noreferrer">Monday</a>` : '-'}</td>
    </tr>
    <tr>
      <td colspan="8" class="details">
        ${task.queue_plan ? `<div><strong>Plan:</strong><pre>${escapeHtml(task.queue_plan)}</pre></div>` : ''}
        ${task.queue_result ? `<div><strong>Result:</strong><pre>${escapeHtml(task.queue_result)}</pre></div>` : ''}
        ${task.queue_error ? `<div><strong>Error:</strong><pre>${escapeHtml(task.queue_error)}</pre></div>` : ''}
      </td>
    </tr>
  `).join('');

  res.send(`
    <html>
      <head>
        <title>Agent Queue</title>
        <meta http-equiv="refresh" content="20" />
        <style>
          body { font-family: Inter, Arial, sans-serif; padding: 24px; background: #0b1020; color: #e5e7eb; }
          a { color: #93c5fd; text-decoration: none; }
          .top { display: flex; justify-content: space-between; align-items: center; gap: 16px; flex-wrap: wrap; }
          .grid { display: grid; grid-template-columns: repeat(auto-fit, minmax(220px, 1fr)); gap: 14px; margin: 20px 0; }
          .card { background: #11182d; border: 1px solid #24304d; border-radius: 12px; padding: 16px; }
          .pill { display: inline-flex; gap: 8px; align-items: center; background: #17213a; border: 1px solid #2a3a5d; border-radius: 999px; padding: 6px 10px; margin: 4px 6px 0 0; }
          table { width: 100%; border-collapse: collapse; background: #11182d; border-radius: 12px; overflow: hidden; }
          th, td { border-bottom: 1px solid #24304d; padding: 12px; text-align: left; vertical-align: top; }
          th { background: #17213a; }
          .details { background: #0f172a; }
          pre { white-space: pre-wrap; word-break: break-word; margin: 6px 0 0; font-family: ui-monospace, SFMono-Regular, monospace; }
          .muted { color: #93a4c3; }
        </style>
      </head>
      <body>
        <div class="top">
          <div>
            <h1>🧠 Agent Queue</h1>
            <p class="muted">Auto-refresh every 20 seconds. Local queue is the source of truth, Monday is the live mirror.</p>
          </div>
          <div>
            <a href="/ops">Back to ops</a>
          </div>
        </div>

        <div class="grid">
          <div class="card"><strong>Total queue tasks</strong><div>${escapeHtml(summary.totals?.queueTasks || 0)}</div></div>
          <div class="card"><strong>Total tasks</strong><div>${escapeHtml(summary.totals?.tasks || 0)}</div></div>
          <div class="card"><strong>Queue enabled</strong><div>${escapeHtml(summary.enabled ? 'yes' : 'no')}</div></div>
          <div class="card"><strong>Next up</strong><div>${escapeHtml(summary.nextUp?.id || 'none')}</div></div>
        </div>

        <div class="card" style="margin-bottom: 18px;">
          <strong>Status buckets</strong>
          <div>${counts || '<span class="muted">No queued tasks yet</span>'}</div>
        </div>

        <table>
          <thead>
            <tr>
              <th>ID</th>
              <th>Title</th>
              <th>Status</th>
              <th>Mode</th>
              <th>Brain</th>
              <th>Priority</th>
              <th>Updated</th>
              <th>Mirror</th>
            </tr>
          </thead>
          <tbody>
            ${rows || '<tr><td colspan="8">No queue tasks yet</td></tr>'}
          </tbody>
        </table>
      </body>
    </html>
  `);
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

app.get('/api/tasks', (req, res) => {
  res.json(readTasks(tasksFile));
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
