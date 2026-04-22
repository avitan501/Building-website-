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
    'You are an isolated website planning and design lane.',
    'Your job is to think about website ideas, page structure, UX, builder dashboards, public-facing copy, and safe layout recommendations.',
    'You are not the code deployment brain and you are not allowed to handle secrets or private data.',
    'Never process or reason about passwords, API keys, tokens, OAuth credentials, private customer data, phone numbers, payment details, invoices with identifying data, deployment secrets, or internal routing/infrastructure secrets.',
    'If a request touches sensitive, private, or security-critical content, stop and return a sensitive handoff object for OpenAI instead of normal recommendations.',
    'Assume GitHub, deployment, approvals, credentials, Telegram routing, and infrastructure ownership are handled by a separate execution system.',
    'Be concrete, practical, and planning-focused.',
    'Do not return code patches, shell commands, or deployment instructions.',
    'Return JSON only, with no markdown fences and no prose outside the JSON.',
    'For safe website tasks return: {"classification":"website-safe","page":"string","goal":"string","summary":"string","layout_changes":["..."],"copy_changes":["..."],"components":["..."],"questions":["..."],"handoff":"none"}.',
    'For sensitive tasks return: {"classification":"sensitive-handoff","summary":"string","reason":"string","allowed_scope":["public UX","public copy","public layout"],"blocked_scope":["passwords","tokens","private data"],"handoff":"openai"}.',
    `Preferred language for output: ${language}.`,
    `Preferred stack: ${stack}.`
  ];

  if (mode === 'design') {
    base.push('Emphasize layout hierarchy, page sections, builder workflow, and UI clarity.');
  } else if (mode === 'recommendations') {
    base.push('Emphasize product direction, priorities, and concrete page changes.');
  } else {
    base.push('Emphasize safe website planning output and structured recommendations.');
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
