#!/usr/bin/env node
const fs = require('fs');
const path = require('path');

function loadEnv(file) {
  if (!fs.existsSync(file)) return;
  for (const raw of fs.readFileSync(file, 'utf8').split(/\r?\n/)) {
    const line = raw.trim();
    if (!line || line.startsWith('#') || !line.includes('=')) continue;
    const idx = line.indexOf('=');
    const key = line.slice(0, idx).trim();
    const value = line.slice(idx + 1).trim().replace(/^['"]|['"]$/g, '');
    if (key && process.env[key] === undefined) process.env[key] = value;
  }
}

loadEnv('/root/mysite/.env');

const { askWebsiteCoder } = require('./kimi-coder');

async function main() {
  const prompt = process.argv.slice(2).join(' ').trim();
  if (!prompt) {
    console.error(JSON.stringify({ ok: false, error: 'Usage: node kimi-plan.js <prompt>' }));
    process.exit(1);
  }

  const result = await askWebsiteCoder({
    prompt,
    mode: 'recommendations',
    language: 'en',
    stack: 'html-css-js'
  });

  process.stdout.write(typeof result.text === 'string' ? result.text : JSON.stringify(result, null, 2));
}

main().catch((error) => {
  console.error(JSON.stringify({ ok: false, error: error.message || String(error) }));
  process.exit(1);
});
