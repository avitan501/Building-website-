const fs = require('fs');
const path = require('path');

const configFile = path.join(__dirname, 'data', 'kimi_coder_config.json');

function defaultConfig() {
  return {
    enabled: true,
    provider: 'kimi',
    model: 'moonshot-v1-8k',
    baseUrl: 'https://api.moonshot.ai/v1',
    defaultMode: 'recommendations',
    defaultLanguage: 'en',
    defaultStack: 'html-css-js'
  };
}

function readConfig() {
  try {
    if (!fs.existsSync(configFile)) return defaultConfig();
    const parsed = JSON.parse(fs.readFileSync(configFile, 'utf8'));
    return { ...defaultConfig(), ...(parsed || {}) };
  } catch {
    return defaultConfig();
  }
}

function writeConfig(patch = {}) {
  const cleanedPatch = Object.fromEntries(
    Object.entries(patch || {}).filter(([, value]) => value !== undefined)
  );
  const next = { ...readConfig(), ...cleanedPatch };
  fs.mkdirSync(path.dirname(configFile), { recursive: true });
  fs.writeFileSync(configFile, JSON.stringify(next, null, 2));
  return next;
}

function getApiKey() {
  return process.env.KIMI_API_KEY || process.env.MOONSHOT_API_KEY || '';
}

function getStatus() {
  const config = readConfig();
  const apiKey = getApiKey();
  return {
    ok: true,
    lane: 'kimi-website-coder',
    enabled: Boolean(config.enabled),
    configured: Boolean(apiKey),
    provider: config.provider,
    model: config.model,
    baseUrl: config.baseUrl,
    defaultMode: config.defaultMode,
    defaultLanguage: config.defaultLanguage,
    defaultStack: config.defaultStack,
    note: apiKey
      ? 'Kimi lane can accept isolated website coding requests.'
      : 'Missing KIMI_API_KEY or MOONSHOT_API_KEY. Lane is scaffolded but not yet authenticated.'
  };
}

function buildSystemPrompt({ mode, language, stack }) {
  const base = [
    'You are an isolated website coder and designer lane.',
    'You only help with website planning, UX recommendations, copy structure, front-end code, and styling.',
    'Do not talk about credentials, deployment secrets, Telegram routing, or infrastructure ownership.',
    'Assume GitHub, Vercel, deployment, approvals, and orchestration are handled by a separate system.',
    'Be concrete, practical, and implementation-ready.',
    `Preferred language for output: ${language}.`,
    `Preferred stack: ${stack}.`
  ];

  if (mode === 'code') {
    base.push('Return implementation-focused output with clear file suggestions, component structure, and styling guidance.');
  } else if (mode === 'design') {
    base.push('Return design-focused output with visual direction, hierarchy, sections, layout, and UI suggestions.');
  } else {
    base.push('Return recommendations first, with 2-3 options and one clear recommendation.');
  }

  return base.join(' ');
}

async function askWebsiteCoder({ prompt, mode, language, stack }) {
  const config = readConfig();
  const apiKey = getApiKey();

  if (!config.enabled) throw new Error('Kimi website coder lane is disabled');
  if (!apiKey) throw new Error('Missing KIMI_API_KEY or MOONSHOT_API_KEY');

  const finalMode = mode || config.defaultMode || 'recommendations';
  const finalLanguage = language || config.defaultLanguage || 'en';
  const finalStack = stack || config.defaultStack || 'html-css-js';
  const system = buildSystemPrompt({ mode: finalMode, language: finalLanguage, stack: finalStack });

  const response = await fetch(`${config.baseUrl.replace(/\/$/, '')}/chat/completions`, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      Authorization: `Bearer ${apiKey}`
    },
    body: JSON.stringify({
      model: config.model,
      temperature: 0.7,
      messages: [
        { role: 'system', content: system },
        { role: 'user', content: String(prompt || '').trim() }
      ]
    })
  });

  const payload = await response.json().catch(() => ({}));
  if (!response.ok) {
    const message = payload?.error?.message || payload?.message || `Kimi request failed with status ${response.status}`;
    throw new Error(message);
  }

  const text = payload?.choices?.[0]?.message?.content || '';
  return {
    ok: true,
    provider: config.provider,
    model: config.model,
    mode: finalMode,
    language: finalLanguage,
    stack: finalStack,
    text,
    raw: payload
  };
}

module.exports = {
  readConfig,
  writeConfig,
  getStatus,
  askWebsiteCoder
};
