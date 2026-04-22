const fs = require('fs');
const path = require('path');

const TASK_ID_PREFIX = 'TASK-';
const DEFAULT_MONDAY_FILES = [
  '/root/assistant-hub/.env',
  '/root/.env',
  '/root/ai-system/.env'
];

function readJsonArray(filePath) {
  try {
    if (!fs.existsSync(filePath)) return [];
    const raw = fs.readFileSync(filePath, 'utf8') || '[]';
    const parsed = JSON.parse(raw);
    return Array.isArray(parsed) ? parsed : [];
  } catch {
    return [];
  }
}

function writeJsonArray(filePath, value) {
  fs.writeFileSync(filePath, JSON.stringify(value, null, 2));
}

function parseEnvFile(filePath) {
  if (!fs.existsSync(filePath)) return {};
  const lines = fs.readFileSync(filePath, 'utf8').split(/\r?\n/);
  const env = {};
  for (const line of lines) {
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

function normalizePhone(value) {
  return String(value || '').replace(/[^\d+]/g, '');
}

function extractNamedField(text, patterns, fallback = '') {
  for (const pattern of patterns) {
    const match = String(text || '').match(pattern);
    if (match?.[1]) return match[1].trim();
  }
  return fallback;
}

function extractAmount(text) {
  const match = String(text || '').match(/(?:amount|total|sum|price|budget|סה["׳']?כ|מחיר|עלות|תקציב)\s*[:\-]?\s*([₪$€]?\s?\d+(?:[.,]\d{1,2})?|\d+(?:[.,]\d{1,2})?\s?[₪$€])/i)
    || String(text || '').match(/([₪$€]\s?\d+(?:[.,]\d{1,2})?|\d+(?:[.,]\d{1,2})?\s?[₪$€])/);
  return match?.[1]?.trim() || '';
}

function normalizeTags(value) {
  if (!Array.isArray(value)) return [];
  return [...new Set(value
    .map(tag => String(tag || '').trim())
    .filter(Boolean))];
}

function normalizeComparableText(value) {
  return normalizeTitle(value).toLowerCase();
}

function normalizeConversationEntry(entry = {}) {
  return {
    timestamp: entry.timestamp || new Date().toISOString(),
    source: String(entry.source || '').trim(),
    chat_id: String(entry.chat_id || entry.chatId || '').trim(),
    contact: String(entry.contact || entry.from || '').trim(),
    body: normalizeTaskText(entry.body || '')
  };
}

function mergeConversationHistory(baseHistory = [], incomingEntries = []) {
  const normalized = [
    ...baseHistory,
    ...incomingEntries
      .map(entry => normalizeConversationEntry(entry))
      .filter(entry => entry.body)
  ];

  const seen = new Set();
  const result = [];
  for (const entry of normalized) {
    const key = JSON.stringify([entry.timestamp, entry.source, entry.chat_id, entry.contact, entry.body]);
    if (seen.has(key)) continue;
    seen.add(key);
    result.push(entry);
  }

  return result.slice(-30);
}

function buildRelatedKeys(task = {}) {
  return normalizeTags([
    ...(Array.isArray(task.tags) ? task.tags : []),
    task.whatsapp_number ? `phone:${normalizePhone(task.whatsapp_number)}` : '',
    task.customer_name ? `customer:${normalizeComparableText(task.customer_name)}` : '',
    task.supplier_name ? `supplier:${normalizeComparableText(task.supplier_name)}` : '',
    task.source_chat_id ? `chat:${String(task.source_chat_id).trim()}` : '',
    task.task_type ? `type:${normalizeComparableText(task.task_type)}` : '',
    task.category ? `category:${normalizeComparableText(task.category)}` : ''
  ]);
}

function formatConversationHistory(history = []) {
  return history
    .slice(-20)
    .map(entry => {
      const sourceBits = [entry.source, entry.chat_id || entry.contact].filter(Boolean).join(' ');
      return `[${entry.timestamp}]${sourceBits ? ` ${sourceBits}` : ''}\n${entry.body}`.trim();
    })
    .join('\n\n')
    .trim();
}

function extractTaskIdReference(text) {
  const match = String(text || '').match(/\bTASK-\d+\b/i);
  return match ? match[0].toUpperCase() : '';
}

function resolveMondayConfig() {
  const env = {
    MONDAY_API_TOKEN: process.env.MONDAY_API_TOKEN || '',
    MONDAY_BOARD_ID: process.env.MONDAY_BOARD_ID || ''
  };

  let sourceFile = 'process.env';
  if (!env.MONDAY_API_TOKEN || !env.MONDAY_BOARD_ID) {
    for (const filePath of DEFAULT_MONDAY_FILES) {
      const parsed = parseEnvFile(filePath);
      if (!env.MONDAY_API_TOKEN && parsed.MONDAY_API_TOKEN) env.MONDAY_API_TOKEN = parsed.MONDAY_API_TOKEN;
      if (!env.MONDAY_BOARD_ID && parsed.MONDAY_BOARD_ID) env.MONDAY_BOARD_ID = parsed.MONDAY_BOARD_ID;
      if (parsed.MONDAY_API_TOKEN || parsed.MONDAY_BOARD_ID) sourceFile = filePath;
      if (env.MONDAY_API_TOKEN && env.MONDAY_BOARD_ID) break;
    }
  }

  return {
    token: env.MONDAY_API_TOKEN,
    boardId: env.MONDAY_BOARD_ID,
    sourceFile
  };
}

async function mondayRequest(query, variables = {}) {
  const cfg = resolveMondayConfig();
  if (!cfg.token || !cfg.boardId) {
    return { skipped: true, reason: 'missing monday configuration' };
  }

  const response = await fetch('https://api.monday.com/v2', {
    method: 'POST',
    headers: {
      Authorization: cfg.token,
      'Content-Type': 'application/json'
    },
    body: JSON.stringify({ query, variables })
  });

  const payload = await response.json();
  if (!response.ok || payload.errors?.length) {
    const message = payload.errors?.map(error => error.message).join('; ') || `monday request failed with status ${response.status}`;
    throw new Error(message);
  }

  return payload.data;
}

async function getMondayBoard() {
  const cfg = resolveMondayConfig();
  if (!cfg.token || !cfg.boardId) {
    return { ok: false, configured: false, sourceFile: cfg.sourceFile };
  }

  const query = `
    query ($boardIds: [ID!]) {
      boards(ids: $boardIds) {
        id
        name
        url
        groups {
          id
          title
        }
        columns {
          id
          title
          type
        }
      }
    }
  `;

  const data = await mondayRequest(query, { boardIds: [String(cfg.boardId)] });
  const board = data?.boards?.[0] || null;
  return {
    ok: Boolean(board),
    configured: true,
    sourceFile: cfg.sourceFile,
    board
  };
}

function normalizeTaskText(value) {
  return String(value || '')
    .replace(/\r/g, '')
    .replace(/\n{3,}/g, '\n\n')
    .trim();
}

function normalizeTitle(value) {
  return normalizeTaskText(value)
    .replace(/\s+/g, ' ')
    .trim();
}

function inferDueDate(text) {
  const value = normalizeTaskText(text).toLowerCase();
  const now = new Date();
  const formatDate = (date) => date.toISOString().slice(0, 10);

  if (value.includes('today') || value.includes('היום')) return formatDate(now);
  if (value.includes('tomorrow') || value.includes('מחר')) {
    const date = new Date(now);
    date.setUTCDate(date.getUTCDate() + 1);
    return formatDate(date);
  }

  const isoMatch = value.match(/\b(20\d{2})[\/.-](\d{1,2})[\/.-](\d{1,2})\b/);
  if (isoMatch) {
    const year = isoMatch[1];
    const month = String(Number(isoMatch[2])).padStart(2, '0');
    const day = String(Number(isoMatch[3])).padStart(2, '0');
    return `${year}-${month}-${day}`;
  }

  const match = value.match(/\b(\d{1,2})[\/.-](\d{1,2})(?:[\/.-](\d{2,4}))?\b/);
  if (!match) return '';
  const day = String(Number(match[1])).padStart(2, '0');
  const month = String(Number(match[2])).padStart(2, '0');
  const year = match[3] ? String(match[3]).padStart(4, '20') : String(now.getUTCFullYear());
  return `${year}-${month}-${day}`;
}

function inferPriority(text) {
  const value = normalizeTaskText(text).toLowerCase();
  if (value.includes('urgent') || value.includes('asap') || value.includes('today') || value.includes('immediately') || value.includes('דחוף') || value.includes('היום') || value.includes('מיידי')) return 'high';
  if (value.includes('low') || value.includes('later') || value.includes('לא דחוף') || value.includes('כשתוכל') || value.includes('כשיהיה זמן')) return 'low';
  if (value.includes('soon') || value.includes('follow up') || value.includes('מעקב') || value.includes('בהמשך') || value.includes('כשאפשר')) return 'normal';
  return 'normal';
}

function inferCategory(text) {
  const value = normalizeTaskText(text).toLowerCase();
  if (value.includes('payment') || value.includes('invoice') || value.includes('bill') || value.includes('גביה') || value.includes('תשלום') || value.includes('חשבונית')) return 'payment';
  if (value.includes('supplier') || value.includes('vendor') || value.includes('ספק')) return 'supplier';
  if (value.includes('follow up') || value.includes('callback') || value.includes('call back') || value.includes('לחזור') || value.includes('מעקב')) return 'follow-up';
  if (value.includes('client') || value.includes('customer') || value.includes('לקוח')) return 'client';
  if (value.includes('build') || value.includes('develop') || value.includes('design') || value.includes('site') || value.includes('website') || value.includes('פיתוח') || value.includes('עיצוב') || value.includes('אתר')) return 'development';
  if (value.includes('server') || value.includes('deploy') || value.includes('bug') || value.includes('fix') || value.includes('שרת') || value.includes('תיקון') || value.includes('דיבאג')) return 'technical';
  return 'general';
}

function inferTaskType(text, structured = {}) {
  const value = normalizeTaskText(text).toLowerCase();
  if (value.includes('remind') || value.includes('reminder') || value.includes('תזכיר')) return 'reminder';
  if (value.includes('follow up') || value.includes('מעקב') || value.includes('לחזור')) return 'follow-up';
  if (structured.amount || value.includes('payment') || value.includes('תשלום') || value.includes('invoice') || value.includes('חשבונית')) return 'payment';
  if (structured.customer_name || structured.supplier_name || value.includes('order') || value.includes('הזמנה')) return 'workflow';
  return 'task';
}

function inferTitleFromText(text) {
  const lines = normalizeTaskText(text).split('\n').map(line => line.trim()).filter(Boolean);
  const meaningfulLine = lines.find(line => !/^(customer|supplier|amount|phone|next step|status|priority|category|לקוח|ספק|סכום|טלפון|השלב הבא|סטטוס|עדיפות|קטגוריה)\s*[:\-]/i.test(line));
  const candidate = meaningfulLine || lines[0] || normalizeTaskText(text);
  const sentence = candidate.split(/[.!?]/)[0] || candidate;
  return normalizeTitle(sentence).slice(0, 120);
}

function extractStructuredTaskFields(text, overrides = {}) {
  const value = normalizeTaskText(text);
  const amount = overrides.amount || extractAmount(value);
  const customerName = overrides.customer_name || overrides.customerName || extractNamedField(value, [
    /customer(?: name)?\s*[:\-]\s*([^\n.]+)/i,
    /לקוח(?:ה)?\s*[:\-]\s*([^\n.]+)/i,
    /customer\s+([a-zא-ת0-9 .'-]{2,})/i
  ], '');

  const supplierName = overrides.supplier_name || overrides.supplierName || extractNamedField(value, [
    /supplier(?: name)?\s*[:\-]\s*([^\n.]+)/i,
    /vendor(?: name)?\s*[:\-]\s*([^\n.]+)/i,
    /ספק\s*[:\-]\s*([^\n.]+)/i
  ], '');

  const phoneMatch = value.match(/\+?\d[\d\s().-]{7,}\d/);
  const whatsappNumber = normalizePhone(overrides.whatsapp_number || overrides.whatsappNumber || extractNamedField(value, [
    /whatsapp(?: number)?\s*[:\-]\s*(.+)/i,
    /phone(?: number)?\s*[:\-]\s*(.+)/i,
    /טלפון\s*[:\-]\s*(.+)/i
  ], phoneMatch?.[0] || ''));

  const nextStep = overrides.next_step || overrides.nextStep || extractNamedField(value, [
    /next step\s*[:\-]\s*([^\n]+)/i,
    /next action\s*[:\-]\s*([^\n]+)/i,
    /השלב הבא\s*[:\-]\s*([^\n]+)/i,
    /צעד הבא\s*[:\-]\s*([^\n]+)/i
  ], '');

  const tags = normalizeTags([
    ...(Array.isArray(overrides.tags) ? overrides.tags : []),
    customerName ? 'customer' : '',
    supplierName ? 'supplier' : '',
    whatsappNumber ? 'phone' : '',
    amount ? 'amount' : '',
    nextStep ? 'next-step' : '',
    inferCategory(value)
  ]);

  return {
    customer_name: customerName,
    supplier_name: supplierName,
    whatsapp_number: whatsappNumber,
    amount,
    next_step: nextStep,
    task_type: overrides.task_type || overrides.taskType || inferTaskType(value, { customer_name: customerName, supplier_name: supplierName, amount }),
    tags
  };
}

function inferSuggestedStatus(task) {
  if (task.status) return task.status;
  if (task.category === 'follow-up' || task.task_type === 'follow-up') return 'follow-up';
  return 'open';
}

function inferTaskFromText(text, overrides = {}) {
  const cleanText = normalizeTaskText(text).replace(/^task:\s*/i, '').trim();
  const structured = extractStructuredTaskFields(cleanText, overrides);
  const task = {
    title: normalizeTitle(overrides.title || inferTitleFromText(cleanText)).slice(0, 120),
    description: normalizeTaskText(overrides.description || cleanText),
    source_text: normalizeTaskText(overrides.source_text || overrides.sourceText || cleanText),
    due_date: overrides.due_date || overrides.dueDate || inferDueDate(cleanText),
    priority: overrides.priority || inferPriority(cleanText),
    category: overrides.category || inferCategory(cleanText),
    status: overrides.status || '',
    source: overrides.source || 'chat',
    task_type: structured.task_type,
    customer_name: structured.customer_name,
    supplier_name: structured.supplier_name,
    whatsapp_number: structured.whatsapp_number,
    amount: structured.amount,
    next_step: structured.next_step,
    tags: structured.tags,
    queue_enabled: typeof overrides.queue_enabled === 'boolean'
      ? overrides.queue_enabled
      : typeof overrides.queueEnabled === 'boolean'
        ? overrides.queueEnabled
        : undefined,
    queue_status: overrides.queue_status || overrides.queueStatus || '',
    queue_run_mode: overrides.queue_run_mode || overrides.queueRunMode || '',
    queue_run_after: overrides.queue_run_after || overrides.queueRunAfter || '',
    queue_brain: overrides.queue_brain || overrides.queueBrain || '',
    queue_plan: overrides.queue_plan || overrides.queuePlan || '',
    queue_result: overrides.queue_result || overrides.queueResult || '',
    queue_error: overrides.queue_error || overrides.queueError || ''
  };

  task.status = inferSuggestedStatus(task);
  return task;
}

function nextTaskId(tasks) {
  let maxNumber = 1000;
  for (const task of tasks) {
    const match = String(task.id || '').match(/^TASK-(\d+)$/i);
    if (match) maxNumber = Math.max(maxNumber, Number(match[1]));
  }
  return `${TASK_ID_PREFIX}${maxNumber + 1}`;
}

function ensureTaskIds(tasks) {
  let changed = false;
  let maxNumber = 1000;

  for (const task of tasks) {
    const match = String(task.id || '').match(/^TASK-(\d+)$/i);
    if (match) maxNumber = Math.max(maxNumber, Number(match[1]));
  }

  for (const task of tasks) {
    if (!task.id) {
      maxNumber += 1;
      task.id = `${TASK_ID_PREFIX}${maxNumber}`;
      changed = true;
    }
  }

  return { tasks, changed };
}

function normalizeTaskRecord(input = {}, base = {}, allTasks = []) {
  const incomingEntries = [];
  if ((!Array.isArray(base.conversation_history) || !base.conversation_history.length) && (base.description || base.source_text)) {
    incomingEntries.push({
      timestamp: base.last_message_at || base.updated_at || base.created_at || new Date().toISOString(),
      source: base.source || input.source || 'manual',
      chat_id: base.source_chat_id || '',
      contact: base.source_contact || '',
      body: base.description || base.source_text || ''
    });
  }

  if (typeof input.conversation_entry === 'object' && input.conversation_entry) {
    incomingEntries.push(input.conversation_entry);
  } else if (!Array.isArray(base.conversation_history) || !base.conversation_history.length) {
    incomingEntries.push({
      timestamp: input.last_message_at || input.updated_at || new Date().toISOString(),
      source: input.source || base.source || 'manual',
      chat_id: input.source_chat_id || input.sourceChatId || base.source_chat_id || '',
      contact: input.source_contact || input.sourceContact || base.source_contact || '',
      body: input.description || input.source_text || input.sourceText || base.description || base.source_text || ''
    });
  }

  const conversation_history = mergeConversationHistory(
    Array.isArray(base.conversation_history) ? base.conversation_history : [],
    incomingEntries
  );

  const record = {
    id: input.id || base.id || nextTaskId(allTasks),
    title: normalizeTitle(input.title || base.title || 'Untitled task'),
    description: normalizeTaskText(input.description || base.description || ''),
    source_text: normalizeTaskText(input.source_text || input.sourceText || base.source_text || ''),
    status: input.status || base.status || 'open',
    priority: input.priority || base.priority || 'normal',
    category: input.category || base.category || 'general',
    due_date: input.due_date || input.dueDate || base.due_date || '',
    source: input.source || base.source || 'manual',
    task_type: input.task_type || input.taskType || base.task_type || 'task',
    customer_name: normalizeTaskText(input.customer_name || input.customerName || base.customer_name || ''),
    supplier_name: normalizeTaskText(input.supplier_name || input.supplierName || base.supplier_name || ''),
    whatsapp_number: normalizePhone(input.whatsapp_number || input.whatsappNumber || base.whatsapp_number || ''),
    amount: normalizeTaskText(input.amount || base.amount || ''),
    next_step: normalizeTaskText(input.next_step || input.nextStep || base.next_step || ''),
    tags: normalizeTags(input.tags || base.tags || []),
    source_chat_id: normalizeTaskText(input.source_chat_id || input.sourceChatId || base.source_chat_id || ''),
    source_contact: normalizeTaskText(input.source_contact || input.sourceContact || base.source_contact || ''),
    conversation_history,
    last_message_at: conversation_history.length ? conversation_history[conversation_history.length - 1].timestamp : (input.last_message_at || base.last_message_at || ''),
    related_keys: normalizeTags(input.related_keys || input.relatedKeys || base.related_keys || []),
    monday_item_id: input.monday_item_id || input.mondayItemId || base.monday_item_id || '',
    monday_board_id: input.monday_board_id || input.mondayBoardId || base.monday_board_id || '',
    monday_group_id: input.monday_group_id || input.mondayGroupId || base.monday_group_id || '',
    monday_board_name: input.monday_board_name || input.mondayBoardName || base.monday_board_name || '',
    monday_url: input.monday_url || input.mondayUrl || base.monday_url || '',
    queue_enabled: typeof input.queue_enabled === 'boolean'
      ? input.queue_enabled
      : typeof input.queueEnabled === 'boolean'
        ? input.queueEnabled
        : typeof base.queue_enabled === 'boolean'
          ? base.queue_enabled
          : false,
    queue_status: normalizeTaskText(input.queue_status || input.queueStatus || base.queue_status || ''),
    queue_run_mode: normalizeTaskText(input.queue_run_mode || input.queueRunMode || base.queue_run_mode || ''),
    queue_run_after: normalizeTaskText(input.queue_run_after || input.queueRunAfter || base.queue_run_after || ''),
    queue_locked_at: normalizeTaskText(input.queue_locked_at || input.queueLockedAt || base.queue_locked_at || ''),
    queue_last_run_at: normalizeTaskText(input.queue_last_run_at || input.queueLastRunAt || base.queue_last_run_at || ''),
    queue_brain: normalizeTaskText(input.queue_brain || input.queueBrain || base.queue_brain || ''),
    queue_router_model: normalizeTaskText(input.queue_router_model || input.queueRouterModel || base.queue_router_model || ''),
    queue_worker_model: normalizeTaskText(input.queue_worker_model || input.queueWorkerModel || base.queue_worker_model || ''),
    queue_plan: normalizeTaskText(input.queue_plan || input.queuePlan || base.queue_plan || ''),
    queue_result: normalizeTaskText(input.queue_result || input.queueResult || base.queue_result || ''),
    queue_error: normalizeTaskText(input.queue_error || input.queueError || base.queue_error || ''),
    created_at: base.created_at || input.created_at || new Date().toISOString(),
    updated_at: new Date().toISOString()
  };

  record.related_keys = buildRelatedKeys(record);
  return record;
}

function readTasks(tasksFile) {
  const rawTasks = readJsonArray(tasksFile);
  const { tasks, changed } = ensureTaskIds(rawTasks);
  if (changed) writeJsonArray(tasksFile, tasks);
  return tasks;
}

function writeTasks(tasksFile, tasks) {
  writeJsonArray(tasksFile, tasks);
}

function findDuplicateTask(tasks, taskCandidate) {
  const normalizedTitle = normalizeComparableText(taskCandidate.title);
  const referencedTaskId = extractTaskIdReference(`${taskCandidate.title}\n${taskCandidate.description}\n${taskCandidate.source_text}`);
  const strongCandidateKeys = buildRelatedKeys(taskCandidate).filter(key => /^(phone:|customer:|supplier:)/.test(key));

  return tasks.find(task => {
    if (String(task.status || '').toLowerCase() === 'done') return false;
    if (referencedTaskId && task.id === referencedTaskId) return true;
    if (normalizeComparableText(task.title) === normalizedTitle) return true;
    if (taskCandidate.whatsapp_number && normalizePhone(task.whatsapp_number) === normalizePhone(taskCandidate.whatsapp_number)) return true;
    if (taskCandidate.customer_name && normalizeComparableText(task.customer_name) === normalizeComparableText(taskCandidate.customer_name) && task.category === taskCandidate.category) return true;

    if (!strongCandidateKeys.length) return false;
    const existingKeys = new Set(buildRelatedKeys(task));
    return strongCandidateKeys.some(key => existingKeys.has(key));
  }) || null;
}

function chooseGroup(board, task) {
  const groups = Array.isArray(board?.groups) ? board.groups : [];
  if (!groups.length) return '';

  const byCategory = {
    payment: ['payment', 'finance', 'גביה', 'תשלום'],
    supplier: ['supplier', 'vendors', 'ספק'],
    client: ['client', 'sales', 'לקוחות', 'לקוח'],
    'follow-up': ['follow', 'pending', 'מעקב'],
    development: ['dev', 'build', 'product', 'פיתוח', 'אתר'],
    technical: ['tech', 'ops', 'server', 'שרת']
  };

  const wanted = byCategory[task.category] || [];
  const matched = groups.find(group => wanted.some(keyword => group.title.toLowerCase().includes(keyword)));
  return matched?.id || groups[0].id;
}

function matchesColumnTitle(column, patterns = []) {
  const title = String(column?.title || '').toLowerCase();
  return patterns.some(pattern => title.includes(String(pattern).toLowerCase()));
}

function findBoardColumn(columns, patterns = [], allowedTypes = []) {
  return columns.find(column => {
    const typeOk = !allowedTypes.length || allowedTypes.includes(column.type);
    return typeOk && matchesColumnTitle(column, patterns);
  }) || null;
}

async function createMondayColumn(boardId, title, columnType = 'text') {
  const mutation = `
    mutation ($boardId: ID!, $title: String!, $columnType: ColumnType!) {
      create_column(board_id: $boardId, title: $title, column_type: $columnType) {
        id
        title
        type
      }
    }
  `;

  const data = await mondayRequest(mutation, {
    boardId: String(boardId),
    title,
    columnType
  });

  return data?.create_column || null;
}

async function ensureBoardColumns(board, task) {
  const columns = Array.isArray(board?.columns) ? [...board.columns] : [];
  const definitions = [
    { title: 'Priority', type: 'text', needed: true },
    { title: 'Category', type: 'text', needed: true },
    { title: 'Source', type: 'text', needed: true },
    { title: 'Task ID', type: 'text', needed: true },
    { title: 'Description', type: 'long_text', needed: true },
    { title: 'Task Type', type: 'text', needed: true },
    { title: 'Customer', type: 'text', needed: true },
    { title: 'Supplier', type: 'text', needed: true },
    { title: 'Phone', type: 'text', needed: true },
    { title: 'Amount', type: 'text', needed: true },
    { title: 'Next Step', type: 'long_text', needed: true },
    { title: 'Tags', type: 'text', needed: true },
    { title: 'Conversation History', type: 'long_text', needed: true },
    { title: 'Related Keys', type: 'long_text', needed: true },
    { title: 'Last Message At', type: 'text', needed: true },
    { title: 'Source Chat', type: 'text', needed: true },
    { title: 'Queue Status', type: 'text', needed: true },
    { title: 'Queue Mode', type: 'text', needed: true },
    { title: 'Brain', type: 'text', needed: true },
    { title: 'Run After', type: 'text', needed: true },
    { title: 'Queue Error', type: 'long_text', needed: true },
    { title: 'Queue Result', type: 'long_text', needed: true }
  ];

  for (const definition of definitions) {
    if (!definition.needed) continue;
    const existing = columns.find(column => String(column.title || '').toLowerCase() === definition.title.toLowerCase());
    if (existing) continue;
    try {
      const created = await createMondayColumn(board.id, definition.title, definition.type);
      if (created) columns.push(created);
    } catch {
      // Best effort: if column creation fails, task data still goes into the update body.
    }
  }

  return { ...board, columns };
}

function toMondayStatusLabel(value) {
  const normalized = String(value || '').trim().toLowerCase();
  if (!normalized) return 'Working on it';
  if (['done', 'completed', 'closed', 'resolved'].includes(normalized)) return 'Done';
  if (['blocked', 'stuck', 'error'].includes(normalized)) return 'Stuck';
  return 'Working on it';
}

function buildColumnValues(board, task) {
  const columns = Array.isArray(board?.columns) ? board.columns : [];
  const values = {};

  const setColumnValue = (column, rawValue) => {
    if (!column || rawValue === undefined || rawValue === null || rawValue === '') return;
    if (column.type === 'date') {
      values[column.id] = { date: String(rawValue) };
      return;
    }
    if (column.type === 'status') {
      values[column.id] = { label: toMondayStatusLabel(rawValue) };
      return;
    }
    const maxLength = column.type === 'long_text' ? 8000 : 1900;
    values[column.id] = String(rawValue).slice(0, maxLength);
  };

  const dateColumn = findBoardColumn(columns, ['date', 'due', 'deadline'], ['date']) || columns.find(column => column.type === 'date');
  const statusColumn = findBoardColumn(columns, ['status', 'state'], ['status']) || columns.find(column => column.type === 'status');
  const descriptionColumn = findBoardColumn(columns, ['description', 'details', 'summary', 'notes', 'תיאור', 'הערות'], ['text', 'long_text']);
  const priorityColumn = findBoardColumn(columns, ['priority', 'עדיפות'], ['text', 'long_text']);
  const categoryColumn = findBoardColumn(columns, ['category', 'קטגוריה'], ['text', 'long_text']);
  const sourceColumn = findBoardColumn(columns, ['source', 'מקור'], ['text', 'long_text']);
  const taskIdColumn = findBoardColumn(columns, ['task id', 'taskid', 'מזהה'], ['text', 'long_text']);
  const taskTypeColumn = findBoardColumn(columns, ['task type', 'type', 'סוג'], ['text', 'long_text']);
  const customerColumn = findBoardColumn(columns, ['customer', 'client', 'לקוח'], ['text', 'long_text']);
  const supplierColumn = findBoardColumn(columns, ['supplier', 'vendor', 'ספק'], ['text', 'long_text']);
  const phoneColumn = findBoardColumn(columns, ['phone', 'whatsapp', 'טלפון'], ['text', 'long_text']);
  const amountColumn = findBoardColumn(columns, ['amount', 'price', 'budget', 'סכום', 'מחיר'], ['text', 'long_text']);
  const nextStepColumn = findBoardColumn(columns, ['next step', 'next action', 'השלב הבא', 'צעד הבא'], ['text', 'long_text']);
  const tagsColumn = findBoardColumn(columns, ['tags', 'labels', 'תגיות'], ['text', 'long_text']);
  const historyColumn = findBoardColumn(columns, ['conversation history', 'history', 'שיחה', 'היסטוריה'], ['text', 'long_text']);
  const relatedKeysColumn = findBoardColumn(columns, ['related keys', 'keys', 'קישורים', 'מפתחות'], ['text', 'long_text']);
  const lastMessageAtColumn = findBoardColumn(columns, ['last message at', 'last message', 'updated at', 'הודעה אחרונה'], ['text', 'long_text']);
  const sourceChatColumn = findBoardColumn(columns, ['source chat', 'chat', 'צאט', 'צ׳אט'], ['text', 'long_text']);
  const queueStatusColumn = findBoardColumn(columns, ['queue status', 'execution status', 'תור'], ['text', 'long_text', 'status']);
  const queueModeColumn = findBoardColumn(columns, ['queue mode', 'run mode', 'mode', 'מצב'], ['text', 'long_text']);
  const brainColumn = findBoardColumn(columns, ['brain', 'worker', 'מוח'], ['text', 'long_text']);
  const runAfterColumn = findBoardColumn(columns, ['run after', 'start after', 'after', 'אחרי'], ['text', 'long_text']);
  const queueErrorColumn = findBoardColumn(columns, ['queue error', 'error', 'שגיאה'], ['text', 'long_text']);
  const queueResultColumn = findBoardColumn(columns, ['queue result', 'result', 'output', 'תוצאה'], ['text', 'long_text']);

  setColumnValue(dateColumn, task.due_date);
  setColumnValue(statusColumn, task.status || 'open');
  setColumnValue(descriptionColumn, task.description || task.source_text);
  setColumnValue(priorityColumn, task.priority);
  setColumnValue(categoryColumn, task.category);
  setColumnValue(sourceColumn, task.source);
  setColumnValue(taskIdColumn, task.id);
  setColumnValue(taskTypeColumn, task.task_type);
  setColumnValue(customerColumn, task.customer_name);
  setColumnValue(supplierColumn, task.supplier_name);
  setColumnValue(phoneColumn, task.whatsapp_number);
  setColumnValue(amountColumn, task.amount);
  setColumnValue(nextStepColumn, task.next_step);
  setColumnValue(tagsColumn, Array.isArray(task.tags) ? task.tags.join(', ') : '');
  setColumnValue(historyColumn, formatConversationHistory(task.conversation_history));
  setColumnValue(relatedKeysColumn, Array.isArray(task.related_keys) ? task.related_keys.join(', ') : '');
  setColumnValue(lastMessageAtColumn, task.last_message_at);
  setColumnValue(sourceChatColumn, task.source_chat_id || task.source_contact);
  setColumnValue(queueStatusColumn, task.queue_status || (task.queue_enabled ? 'queued' : ''));
  setColumnValue(queueModeColumn, task.queue_run_mode);
  setColumnValue(brainColumn, task.queue_brain);
  setColumnValue(runAfterColumn, task.queue_run_after);
  setColumnValue(queueErrorColumn, task.queue_error);
  setColumnValue(queueResultColumn, task.queue_result);

  return Object.keys(values).length ? values : null;
}

function buildMondayUpdateBody(task) {
  const lines = [
    `Task ID: ${task.id}`,
    `Priority: ${task.priority}`,
    `Category: ${task.category}`,
    `Status: ${task.status}`,
    `Source: ${task.source}`,
    `Type: ${task.task_type || 'task'}`
  ];

  if (task.due_date) lines.push(`Due: ${task.due_date}`);
  if (task.customer_name) lines.push(`Customer: ${task.customer_name}`);
  if (task.supplier_name) lines.push(`Supplier: ${task.supplier_name}`);
  if (task.whatsapp_number) lines.push(`Phone: ${task.whatsapp_number}`);
  if (task.amount) lines.push(`Amount: ${task.amount}`);
  if (task.next_step) lines.push(`Next step: ${task.next_step}`);
  if (Array.isArray(task.tags) && task.tags.length) lines.push(`Tags: ${task.tags.join(', ')}`);
  if (Array.isArray(task.related_keys) && task.related_keys.length) lines.push(`Related keys: ${task.related_keys.join(', ')}`);
  if (task.last_message_at) lines.push(`Last message at: ${task.last_message_at}`);
  if (task.source_chat_id || task.source_contact) lines.push(`Source chat: ${task.source_chat_id || task.source_contact}`);
  if (task.queue_enabled) {
    lines.push(`Queue status: ${task.queue_status || 'queued'}`);
    if (task.queue_run_mode) lines.push(`Queue mode: ${task.queue_run_mode}`);
    if (task.queue_brain) lines.push(`Brain: ${task.queue_brain}`);
    if (task.queue_run_after) lines.push(`Run after: ${task.queue_run_after}`);
    if (task.queue_last_run_at) lines.push(`Last run at: ${task.queue_last_run_at}`);
  }
  if (task.description) lines.push('', 'Description:', task.description);
  if (task.queue_plan) lines.push('', 'Queue plan:', task.queue_plan);
  if (task.queue_result) lines.push('', 'Queue result:', task.queue_result);
  if (task.queue_error) lines.push('', 'Queue error:', task.queue_error);

  const latestHistory = Array.isArray(task.conversation_history) && task.conversation_history.length
    ? task.conversation_history[task.conversation_history.length - 1]
    : null;
  if (latestHistory?.body) {
    lines.push('', 'Latest message:', `[${latestHistory.timestamp}] ${latestHistory.body}`);
  } else if (task.source_text && task.source_text !== task.description) {
    lines.push('', 'Source text:', task.source_text);
  }

  return lines.join('\n').trim();
}

async function ensureTaskBoardSchema(sampleTask = {}) {
  const boardInfo = await getMondayBoard();
  if (!boardInfo.configured) {
    return { ok: false, configured: false, reason: 'missing monday configuration', sourceFile: boardInfo.sourceFile };
  }
  if (!boardInfo.ok || !boardInfo.board) {
    return { ok: false, configured: true, reason: 'monday board not found', sourceFile: boardInfo.sourceFile };
  }

  const schemaTask = normalizeTaskRecord({
    title: 'Schema bootstrap',
    description: '',
    source: 'system',
    ...sampleTask
  }, {}, []);
  const board = await ensureBoardColumns(boardInfo.board, schemaTask);
  return {
    ok: true,
    configured: true,
    sourceFile: boardInfo.sourceFile,
    board
  };
}

async function createMondayItemUpdate(itemId, body) {
  if (!body) return null;
  const updateMutation = `
    mutation ($itemId: ID!, $body: String!) {
      create_update(item_id: $itemId, body: $body) {
        id
      }
    }
  `;
  const data = await mondayRequest(updateMutation, {
    itemId: String(itemId),
    body
  });
  return data?.create_update || null;
}

async function syncTaskToMonday(task) {
  const schema = await ensureTaskBoardSchema(task);
  if (!schema.ok || !schema.board) {
    return { skipped: true, reason: schema.reason || 'monday board not found' };
  }

  const board = schema.board;
  const groupId = chooseGroup(board, task);
  const columnValues = buildColumnValues(board, task);
  const updateBody = buildMondayUpdateBody(task);

  if (task.monday_item_id) {
    if (columnValues) {
      const updateColumnsMutation = `
        mutation ($boardId: ID!, $itemId: ID!, $columnValues: JSON!) {
          change_multiple_column_values(board_id: $boardId, item_id: $itemId, column_values: $columnValues) {
            id
          }
        }
      `;
      await mondayRequest(updateColumnsMutation, {
        boardId: String(board.id),
        itemId: String(task.monday_item_id),
        columnValues: JSON.stringify(columnValues)
      });
    }
    await createMondayItemUpdate(task.monday_item_id, updateBody);
    return {
      ok: true,
      itemId: String(task.monday_item_id),
      boardId: String(board.id),
      boardName: board.name,
      groupId: groupId || '',
      boardUrl: board.url || ''
    };
  }

  const createMutation = `
    mutation ($boardId: ID!, $groupId: String, $itemName: String!, $columnValues: JSON) {
      create_item(board_id: $boardId, group_id: $groupId, item_name: $itemName, column_values: $columnValues) {
        id
      }
    }
  `;

  const createData = await mondayRequest(createMutation, {
    boardId: String(board.id),
    groupId: groupId || null,
    itemName: task.title,
    columnValues: columnValues ? JSON.stringify(columnValues) : null
  });

  const itemId = createData?.create_item?.id;
  if (!itemId) throw new Error('monday did not return item id');
  await createMondayItemUpdate(itemId, updateBody);

  return {
    ok: true,
    itemId: String(itemId),
    boardId: String(board.id),
    boardName: board.name,
    groupId: groupId || '',
    boardUrl: board.url || ''
  };
}

async function createTaskFromText(tasksFile, text, overrides = {}) {
  const tasks = readTasks(tasksFile);
  const inferred = inferTaskFromText(text, overrides);
  const incomingConversationEntry = overrides.conversation_entry || {
    timestamp: overrides.timestamp || new Date().toISOString(),
    source: overrides.source || 'chat',
    chat_id: overrides.source_chat_id || overrides.sourceChatId || '',
    contact: overrides.source_contact || overrides.sourceContact || '',
    body: normalizeTaskText(overrides.description || overrides.source_text || overrides.sourceText || text)
  };

  const duplicate = findDuplicateTask(tasks, inferred);
  if (duplicate) {
    const index = tasks.findIndex(task => task.id === duplicate.id);
    const mergedInput = {
      ...duplicate,
      ...inferred,
      title: duplicate.title || inferred.title,
      description: inferred.description || duplicate.description,
      source_text: inferred.source_text || duplicate.source_text,
      customer_name: inferred.customer_name || duplicate.customer_name,
      supplier_name: inferred.supplier_name || duplicate.supplier_name,
      whatsapp_number: inferred.whatsapp_number || duplicate.whatsapp_number,
      amount: inferred.amount || duplicate.amount,
      next_step: inferred.next_step || duplicate.next_step,
      tags: normalizeTags([...(duplicate.tags || []), ...(inferred.tags || [])]),
      source_chat_id: overrides.source_chat_id || overrides.sourceChatId || duplicate.source_chat_id,
      source_contact: overrides.source_contact || overrides.sourceContact || duplicate.source_contact,
      conversation_entry: incomingConversationEntry
    };

    tasks[index] = normalizeTaskRecord(mergedInput, duplicate, tasks);
    writeTasks(tasksFile, tasks);

    let monday = null;
    try {
      monday = await syncTaskToMonday(tasks[index]);
      if (monday?.ok) {
        tasks[index].monday_item_id = monday.itemId;
        tasks[index].monday_board_id = monday.boardId;
        tasks[index].monday_board_name = monday.boardName;
        tasks[index].monday_group_id = monday.groupId;
        tasks[index].monday_url = monday.boardUrl;
        tasks[index].updated_at = new Date().toISOString();
        writeTasks(tasksFile, tasks);
      }
    } catch (error) {
      monday = { ok: false, error: error.message };
    }

    return { ok: true, deduped: true, task: tasks[index], monday };
  }

  const task = normalizeTaskRecord({
    ...inferred,
    source_chat_id: overrides.source_chat_id || overrides.sourceChatId || '',
    source_contact: overrides.source_contact || overrides.sourceContact || '',
    conversation_entry: incomingConversationEntry
  }, {}, tasks);
  tasks.unshift(task);
  writeTasks(tasksFile, tasks);

  let monday = null;
  try {
    monday = await syncTaskToMonday(task);
    if (monday?.ok) {
      task.monday_item_id = monday.itemId;
      task.monday_board_id = monday.boardId;
      task.monday_board_name = monday.boardName;
      task.monday_group_id = monday.groupId;
      task.monday_url = monday.boardUrl;
      task.updated_at = new Date().toISOString();
      writeTasks(tasksFile, tasks);
    }
  } catch (error) {
    monday = { ok: false, error: error.message };
  }

  return { ok: true, deduped: false, task, monday };
}

async function syncExistingTaskToMonday(tasksFile, taskId) {
  const tasks = readTasks(tasksFile);
  const index = tasks.findIndex(task => task.id === taskId);
  if (index === -1) return { ok: false, error: 'task not found' };

  const monday = await syncTaskToMonday(tasks[index]);
  if (monday?.ok) {
    tasks[index].monday_item_id = monday.itemId;
    tasks[index].monday_board_id = monday.boardId;
    tasks[index].monday_board_name = monday.boardName;
    tasks[index].monday_group_id = monday.groupId;
    tasks[index].monday_url = monday.boardUrl;
    tasks[index].updated_at = new Date().toISOString();
    writeTasks(tasksFile, tasks);
  }

  return { ok: true, task: tasks[index], monday };
}

module.exports = {
  readTasks,
  writeTasks,
  createTaskFromText,
  syncExistingTaskToMonday,
  getMondayBoard,
  ensureTaskBoardSchema,
  inferTaskFromText,
  normalizeTaskRecord
};
