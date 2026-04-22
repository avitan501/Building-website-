const fs = require('fs');
const path = require('path');
const {
  readTasks,
  writeTasks,
  createTaskFromText,
  syncExistingTaskToMonday,
  normalizeTaskRecord
} = require('./task-intelligence');
const { askWebsiteCoder } = require('./kimi-coder');

const CONFIG_FILE = '/root/mysite/data/agent_queue_config.json';
const DEFAULT_ENV_FILES = ['/root/mysite/.env', '/root/.env'];

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

function parseEnvFile(filePath) {
  if (!fs.existsSync(filePath)) return {};
  const env = {};
  for (const line of fs.readFileSync(filePath, 'utf8').split(/\r?\n/)) {
    const trimmed = line.trim();
    if (!trimmed || trimmed.startsWith('#')) continue;
    const eqIndex = trimmed.indexOf('=');
    if (eqIndex === -1) continue;
    const key = trimmed.slice(0, eqIndex).trim();
    let value = trimmed.slice(eqIndex + 1).trim();
    if ((value.startsWith('"') && value.endsWith('"')) || (value.startsWith("'") && value.endsWith("'"))) {
      value = value.slice(1, -1);
    }
    env[key] = value;
  }
  return env;
}

function defaultConfig() {
  return {
    enabled: true,
    routerEnabled: true,
    routerProvider: 'openai',
    routerModel: 'gpt-4.1-mini',
    workerProvider: 'openai',
    workerModel: 'gpt-4.1',
    autoEnqueueNewTasks: true,
    autoProcessEnabled: true,
    defaultRunMode: 'now',
    autoProcessBatchSize: 1,
    nightlyEnabled: true,
    nightlyStartHourUtc: 1,
    nightlyEndHourUtc: 6,
    nightlyBatchSize: 3,
    mondayMirror: true,
    localQueueSourceOfTruth: true
  };
}

function readConfig() {
  return {
    ...defaultConfig(),
    ...readJson(CONFIG_FILE, {})
  };
}

function writeConfig(patch = {}) {
  const next = { ...readConfig(), ...patch };
  writeJson(CONFIG_FILE, next);
  return next;
}

function resolveOpenAIKey() {
  if (process.env.OPENAI_API_KEY) return process.env.OPENAI_API_KEY;
  for (const filePath of DEFAULT_ENV_FILES) {
    const parsed = parseEnvFile(filePath);
    if (parsed.OPENAI_API_KEY) return parsed.OPENAI_API_KEY;
  }
  return '';
}

function normalizeText(value) {
  return String(value || '').replace(/\r/g, '').replace(/\n{3,}/g, '\n\n').trim();
}

function clipText(value, max = 8000) {
  return String(value || '').slice(0, max);
}

function getQueueStatus(tasksFile) {
  const config = readConfig();
  const tasks = readTasks(tasksFile);
  const queueTasks = tasks.filter(task => task.queue_enabled);
  const counts = queueTasks.reduce((acc, task) => {
    const key = String(task.queue_status || 'none');
    acc[key] = (acc[key] || 0) + 1;
    return acc;
  }, {});

  return {
    ok: true,
    enabled: Boolean(config.enabled),
    config,
    totals: {
      tasks: tasks.length,
      queueTasks: queueTasks.length
    },
    counts,
    nextUp: queueTasks
      .filter(task => ['queued', 'retry'].includes(String(task.queue_status || '')))
      .sort((a, b) => String(a.queue_run_after || '').localeCompare(String(b.queue_run_after || '')))[0] || null
  };
}

function listQueueTasks(tasksFile) {
  return readTasks(tasksFile)
    .filter(task => task.queue_enabled)
    .sort((a, b) => String(b.updated_at || '').localeCompare(String(a.updated_at || '')));
}

function isNightWindow(config, now = new Date()) {
  const hour = now.getUTCHours();
  const start = Number(config.nightlyStartHourUtc || 1);
  const end = Number(config.nightlyEndHourUtc || 6);
  return hour >= start && hour < end;
}

function isTaskEligible(task, { nightOnly = false, now = new Date() } = {}) {
  if (!task?.queue_enabled) return false;
  const queueStatus = String(task.queue_status || '');
  if (!['queued', 'retry'].includes(queueStatus)) return false;
  const runMode = String(task.queue_run_mode || 'manual');
  if (nightOnly && runMode !== 'night') return false;
  if (!nightOnly && runMode === 'night') return false;
  const runAfter = task.queue_run_after ? Date.parse(task.queue_run_after) : 0;
  if (Number.isFinite(runAfter) && runAfter && runAfter > now.getTime()) return false;
  return true;
}

function chooseQueuedTask(tasks, options = {}) {
  const candidates = tasks.filter(task => isTaskEligible(task, options));
  return candidates.sort((a, b) => {
    const pa = String(a.priority || 'normal');
    const pb = String(b.priority || 'normal');
    const priorityWeight = { high: 0, normal: 1, low: 2 };
    const diff = (priorityWeight[pa] ?? 1) - (priorityWeight[pb] ?? 1);
    if (diff) return diff;
    return String(a.created_at || '').localeCompare(String(b.created_at || ''));
  })[0] || null;
}

async function callOpenAI(messages, model) {
  const apiKey = resolveOpenAIKey();
  if (!apiKey) throw new Error('Missing OPENAI_API_KEY');

  const response = await fetch('https://api.openai.com/v1/chat/completions', {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      Authorization: `Bearer ${apiKey}`
    },
    body: JSON.stringify({
      model,
      temperature: 0.2,
      messages
    })
  });

  const payload = await response.json().catch(() => ({}));
  if (!response.ok) {
    const message = payload?.error?.message || payload?.message || `OpenAI request failed with status ${response.status}`;
    throw new Error(message);
  }

  return payload?.choices?.[0]?.message?.content || '';
}

function heuristicRoute(task) {
  const text = `${task.title || ''}\n${task.description || ''}`.toLowerCase();
  const websiteSignals = ['website', 'site', 'homepage', 'landing page', 'ui', 'ux', 'component', 'layout', 'design', 'figma', 'html', 'css', 'javascript', 'react', 'next', 'vercel', 'אתר', 'דף נחיתה', 'עמוד בית', 'עיצוב', 'קומפוננטה', 'layout'];
  const actionSignals = ['deploy', 'server', 'fix', 'build', 'flow', 'automation', 'queue', 'task', 'integrate', 'api', 'תור', 'אוטומציה', 'פיתוח', 'תיקון'];
  const worker = websiteSignals.some(signal => text.includes(signal)) || ['development', 'technical'].includes(String(task.category || ''))
    ? 'website-coder'
    : 'general-smart';
  const mode = websiteSignals.some(signal => text.includes(signal)) ? 'code' : 'recommendations';
  const complexity = actionSignals.some(signal => text.includes(signal)) || text.length > 350 ? 'high' : 'normal';
  return {
    worker,
    mode,
    complexity,
    summary: task.title || 'Queued task',
    objective: normalizeText(task.description || task.source_text || task.title),
    instructions: worker === 'website-coder'
      ? 'Focus on product/build steps, structure, code, and execution detail.'
      : 'Focus on execution, practical next steps, and useful operator output.'
  };
}

function parseJsonObject(text) {
  const value = String(text || '').trim();
  if (!value) return null;
  try {
    return JSON.parse(value);
  } catch {
    const match = value.match(/\{[\s\S]*\}/);
    if (!match) return null;
    try {
      return JSON.parse(match[0]);
    } catch {
      return null;
    }
  }
}

async function routeTask(task, config) {
  const fallback = heuristicRoute(task);
  if (!config.routerEnabled || config.routerProvider !== 'openai') {
    return { ...fallback, provider: 'heuristic', model: 'heuristic-router', usedFallback: true };
  }

  try {
    const content = await callOpenAI([
      {
        role: 'system',
        content: 'You are a cheap routing brain. Return JSON only with keys worker, mode, complexity, summary, objective, instructions. Worker must be either "website-coder" or "general-smart". Mode must be either "recommendations", "code", or "plan". Keep objective short and practical.'
      },
      {
        role: 'user',
        content: JSON.stringify({
          id: task.id,
          title: task.title,
          description: task.description,
          category: task.category,
          priority: task.priority,
          task_type: task.task_type,
          next_step: task.next_step
        })
      }
    ], config.routerModel || 'gpt-4.1-mini');

    const parsed = parseJsonObject(content);
    if (!parsed?.worker || !parsed?.objective) throw new Error('router returned invalid JSON');
    return {
      worker: ['website-coder', 'general-smart'].includes(parsed.worker) ? parsed.worker : fallback.worker,
      mode: ['recommendations', 'code', 'plan'].includes(parsed.mode) ? parsed.mode : fallback.mode,
      complexity: ['low', 'normal', 'high'].includes(parsed.complexity) ? parsed.complexity : fallback.complexity,
      summary: normalizeText(parsed.summary || fallback.summary),
      objective: normalizeText(parsed.objective || fallback.objective),
      instructions: normalizeText(parsed.instructions || fallback.instructions),
      provider: 'openai',
      model: config.routerModel || 'gpt-4.1-mini'
    };
  } catch (error) {
    return {
      ...fallback,
      provider: 'heuristic',
      model: 'heuristic-router',
      usedFallback: true,
      fallbackReason: error.message
    };
  }
}

async function runGeneralSmartWorker(task, route, config) {
  const prompt = [
    `Task ID: ${task.id}`,
    `Title: ${task.title}`,
    `Category: ${task.category}`,
    `Priority: ${task.priority}`,
    `Objective: ${route.objective}`,
    task.description ? `Description:\n${task.description}` : '',
    task.next_step ? `Current next step: ${task.next_step}` : '',
    'Produce a compact execution output with these sections:',
    '1. Outcome',
    '2. Recommended actions',
    '3. Risks or blockers',
    '4. Suggested next step'
  ].filter(Boolean).join('\n\n');

  const text = await callOpenAI([
    {
      role: 'system',
      content: 'You are the smart executor brain for a task queue. Be concise, practical, and action-oriented. Do not invent external facts.'
    },
    {
      role: 'user',
      content: prompt
    }
  ], config.workerModel || 'gpt-4.1');

  return {
    provider: 'openai',
    model: config.workerModel || 'gpt-4.1',
    text: normalizeText(text)
  };
}

async function runWorker(task, route, config) {
  if (route.worker === 'website-coder') {
    const prompt = [
      route.objective,
      route.instructions,
      task.description ? `Task details:\n${task.description}` : '',
      task.next_step ? `Current next step: ${task.next_step}` : ''
    ].filter(Boolean).join('\n\n');

    const result = await askWebsiteCoder({
      prompt,
      mode: route.mode === 'plan' ? 'recommendations' : route.mode,
      language: 'en',
      stack: 'html-css-js'
    });

    return {
      provider: result.provider,
      model: result.model,
      text: normalizeText(result.text),
      fallbackUsed: Boolean(result.fallbackUsed),
      fallbackFrom: result.fallbackFrom || '',
      fallbackReason: result.fallbackReason || ''
    };
  }

  return runGeneralSmartWorker(task, route, config);
}

function patchTask(tasks, index, patch) {
  tasks[index] = normalizeTaskRecord({ ...tasks[index], ...patch }, tasks[index], tasks);
  return tasks[index];
}

async function syncTaskIfNeeded(tasksFile, taskId, config) {
  if (!config.mondayMirror) return { skipped: true, reason: 'monday mirror disabled' };
  try {
    return await syncExistingTaskToMonday(tasksFile, taskId);
  } catch (error) {
    return { ok: false, error: error.message };
  }
}

async function enqueueTask(tasksFile, text, overrides = {}) {
  const config = readConfig();
  const runMode = String(overrides.queue_run_mode || overrides.queueRunMode || config.defaultRunMode || 'now');
  const result = await createTaskFromText(tasksFile, text, {
    ...(overrides || {}),
    queue_enabled: true,
    queue_status: 'queued',
    queue_run_mode: ['manual', 'now', 'night'].includes(runMode) ? runMode : 'now',
    queue_run_after: overrides.queue_run_after || overrides.queueRunAfter || new Date().toISOString(),
    queue_result: '',
    queue_error: '',
    queue_brain: '',
    queue_plan: ''
  });
  return result;
}

async function createOrQueueTask(tasksFile, text, overrides = {}) {
  const config = readConfig();
  const wantsQueue = typeof overrides.autoQueue === 'boolean'
    ? overrides.autoQueue
    : typeof overrides.auto_queue === 'boolean'
      ? overrides.auto_queue
      : Boolean(config.autoEnqueueNewTasks);

  if (wantsQueue) {
    return enqueueTask(tasksFile, text, overrides);
  }

  return createTaskFromText(tasksFile, text, overrides);
}

async function processNextQueuedTask({ tasksFile, nightOnly = false } = {}) {
  const config = readConfig();
  if (!config.enabled) return { ok: false, error: 'agent queue disabled' };

  const tasks = readTasks(tasksFile);
  const nextTask = chooseQueuedTask(tasks, { nightOnly, now: new Date() });
  if (!nextTask) {
    return { ok: true, processed: false, reason: nightOnly ? 'no eligible nightly task' : 'no eligible queued task' };
  }

  const index = tasks.findIndex(task => task.id === nextTask.id);
  if (index === -1) return { ok: false, error: 'queued task disappeared' };

  patchTask(tasks, index, {
    queue_status: 'routing',
    queue_locked_at: new Date().toISOString(),
    queue_error: ''
  });
  writeTasks(tasksFile, tasks);
  await syncTaskIfNeeded(tasksFile, nextTask.id, config);

  try {
    const route = await routeTask(tasks[index], config);
    patchTask(tasks, index, {
      queue_status: 'running',
      queue_brain: route.worker,
      queue_router_model: route.model,
      queue_plan: [route.summary, route.objective, route.instructions].filter(Boolean).join('\n\n')
    });
    writeTasks(tasksFile, tasks);
    await syncTaskIfNeeded(tasksFile, nextTask.id, config);

    const worker = await runWorker(tasks[index], route, config);
    patchTask(tasks, index, {
      queue_status: 'done',
      queue_last_run_at: new Date().toISOString(),
      queue_worker_model: worker.model,
      queue_result: clipText(worker.text, 12000),
      queue_error: worker.fallbackUsed
        ? clipText(`Fallback used from ${worker.fallbackFrom}: ${worker.fallbackReason}`, 1500)
        : '',
      next_step: tasks[index].next_step || 'Review agent output and decide whether to act, edit, or deploy.'
    });
    writeTasks(tasksFile, tasks);
    const monday = await syncTaskIfNeeded(tasksFile, nextTask.id, config);
    return { ok: true, processed: true, task: tasks[index], route, worker, monday };
  } catch (error) {
    patchTask(tasks, index, {
      queue_status: 'retry',
      queue_last_run_at: new Date().toISOString(),
      queue_error: clipText(error.message, 2000)
    });
    writeTasks(tasksFile, tasks);
    const monday = await syncTaskIfNeeded(tasksFile, nextTask.id, config);
    return { ok: false, processed: true, task: tasks[index], error: error.message, monday };
  }
}

async function runAutoQueue({ tasksFile, limit } = {}) {
  const config = readConfig();
  if (!config.enabled) return { ok: false, error: 'agent queue disabled' };
  if (!config.autoProcessEnabled) return { ok: false, error: 'auto processing disabled' };

  const maxRuns = Math.max(1, Number(limit || config.autoProcessBatchSize || 1));
  const runs = [];
  for (let i = 0; i < maxRuns; i += 1) {
    const result = await processNextQueuedTask({ tasksFile, nightOnly: false });
    runs.push(result);
    if (!result.processed) break;
  }

  return {
    ok: true,
    processed: runs.filter(run => run.processed).length,
    runs
  };
}

async function runNightQueue({ tasksFile, limit } = {}) {
  const config = readConfig();
  if (!config.enabled) return { ok: false, error: 'agent queue disabled' };
  if (!config.nightlyEnabled) return { ok: false, error: 'night queue disabled' };
  if (!isNightWindow(config)) return { ok: true, processed: 0, reason: 'outside night window' };

  const maxRuns = Math.max(1, Number(limit || config.nightlyBatchSize || 3));
  const runs = [];
  for (let i = 0; i < maxRuns; i += 1) {
    const result = await processNextQueuedTask({ tasksFile, nightOnly: true });
    runs.push(result);
    if (!result.processed) break;
  }

  return {
    ok: true,
    processed: runs.filter(run => run.processed).length,
    runs
  };
}

module.exports = {
  CONFIG_FILE,
  readConfig,
  writeConfig,
  getQueueStatus,
  listQueueTasks,
  enqueueTask,
  createOrQueueTask,
  processNextQueuedTask,
  runAutoQueue,
  runNightQueue,
  isNightWindow
};
