const fs = require('fs');
const path = require('path');

const configFile = path.join(__dirname, 'data', 'kimi_coder_config.json');

function defaultConfig() {
  return {
    enabled: true,
    provider: 'kimi',
    model: 'moonshot-v1-8k',
    baseUrl: 'https://api.moonshot.ai/v1',
    fallbackEnabled: true,
    fallbackProvider: 'openai',
    fallbackModel: 'gpt-4.1-mini',
    fallbackBaseUrl: 'https://api.openai.com/v1',
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

function getProviderState(provider, config = readConfig()) {
  if (provider === 'openai') {
    return {
      provider,
      apiKey: process.env.OPENAI_API_KEY || '',
      model: config.fallbackModel || 'gpt-4.1-mini',
      baseUrl: config.fallbackBaseUrl || 'https://api.openai.com/v1'
    };
  }

  return {
    provider: 'kimi',
    apiKey: process.env.KIMI_API_KEY || process.env.MOONSHOT_API_KEY || '',
    model: config.model,
    baseUrl: config.baseUrl
  };
}

function getApiKey() {
  return getProviderState('kimi').apiKey;
}

function getStatus() {
  const config = readConfig();
  const primary = getProviderState(config.provider || 'kimi', config);
  const fallback = getProviderState(config.fallbackProvider || 'openai', config);
  return {
    ok: true,
    lane: 'kimi-website-coder',
    enabled: Boolean(config.enabled),
    configured: Boolean(primary.apiKey),
    provider: primary.provider,
    model: primary.model,
    baseUrl: primary.baseUrl,
    fallbackEnabled: Boolean(config.fallbackEnabled),
    fallbackProvider: fallback.provider,
    fallbackConfigured: Boolean(fallback.apiKey),
    fallbackModel: fallback.model,
    fallbackBaseUrl: fallback.baseUrl,
    defaultMode: config.defaultMode,
    defaultLanguage: config.defaultLanguage,
    defaultStack: config.defaultStack,
    note: primary.apiKey
      ? 'Primary website-coder lane is configured.'
      : 'Primary Kimi lane is missing credentials.',
    fallbackNote: config.fallbackEnabled
      ? (fallback.apiKey ? 'Fallback provider is ready.' : 'Fallback provider is not configured yet.')
      : 'Fallback is disabled.'
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

async function requestProvider(provider, { prompt, mode, language, stack }, config) {
  const providerState = getProviderState(provider, config);
  if (!providerState.apiKey) {
    throw new Error(`Missing ${provider === 'openai' ? 'OPENAI_API_KEY' : 'KIMI_API_KEY or MOONSHOT_API_KEY'}`);
  }

  const finalMode = mode || config.defaultMode || 'recommendations';
  const finalLanguage = language || config.defaultLanguage || 'en';
  const finalStack = stack || config.defaultStack || 'html-css-js';
  const system = buildSystemPrompt({ mode: finalMode, language: finalLanguage, stack: finalStack });

  const response = await fetch(`${providerState.baseUrl.replace(/\/$/, '')}/chat/completions`, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      Authorization: `Bearer ${providerState.apiKey}`
    },
    body: JSON.stringify({
      model: providerState.model,
      temperature: 0.7,
      messages: [
        { role: 'system', content: system },
        { role: 'user', content: String(prompt || '').trim() }
      ]
    })
  });

  const payload = await response.json().catch(() => ({}));
  if (!response.ok) {
    const message = payload?.error?.message || payload?.message || `${providerState.provider} request failed with status ${response.status}`;
    throw new Error(message);
  }

  return {
    ok: true,
    provider: providerState.provider,
    model: providerState.model,
    mode: finalMode,
    language: finalLanguage,
    stack: finalStack,
    text: payload?.choices?.[0]?.message?.content || '',
    raw: payload
  };
}

async function askWebsiteCoder({ prompt, mode, language, stack }) {
  const config = readConfig();
  if (!config.enabled) throw new Error('Kimi website coder lane is disabled');

  const primaryProvider = config.provider || 'kimi';
  try {
    return await requestProvider(primaryProvider, { prompt, mode, language, stack }, config);
  } catch (primaryError) {
    const fallbackProvider = config.fallbackProvider || 'openai';
    if (!config.fallbackEnabled || fallbackProvider === primaryProvider) {
      throw primaryError;
    }

    const fallbackResult = await requestProvider(fallbackProvider, { prompt, mode, language, stack }, config);
    return {
      ...fallbackResult,
      fallbackUsed: true,
      fallbackFrom: primaryProvider,
      fallbackReason: primaryError.message
    };
  }
}

module.exports = {
  readConfig,
  writeConfig,
  getStatus,
  askWebsiteCoder
};
