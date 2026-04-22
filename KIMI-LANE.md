# Kimi website coder lane

This lane is intentionally isolated from the main OpenClaw/Telegram routing.

## What it owns
- Website recommendations
- Design direction
- UI structure
- Front-end code suggestions

## What it does NOT own
- Telegram routing
- Personal/business routing
- GitHub credentials
- Vercel credentials
- Deploy orchestration
- Main assistant model

## Auth
Primary provider credentials:
- `KIMI_API_KEY`
- `MOONSHOT_API_KEY`

Optional smart fallback credential:
- `OPENAI_API_KEY`

Example template:
- `/root/mysite/.env.kimi.example`

Runtime loading:
- `/root/mysite/start-server.sh` now auto-loads `/root/mysite/.env` before starting the app.

## Config file
- `/root/mysite/data/kimi_coder_config.json`

Safe editable fields:
- `enabled`
- `model`
- `baseUrl`
- `fallbackEnabled`
- `fallbackProvider`
- `fallbackModel`
- `fallbackBaseUrl`
- `defaultMode`
- `defaultLanguage`
- `defaultStack`

## API
### Status
`GET /api/website-coder/status`

### Read config
`GET /api/website-coder/config`

### Update config
`POST /api/website-coder/config`

Example body:
```json
{
  "model": "moonshot-v1-8k",
  "defaultMode": "recommendations",
  "defaultLanguage": "en",
  "defaultStack": "html-css-js"
}
```

### Ask the isolated website coder
`POST /api/website-coder/ask`

Example body:
```json
{
  "mode": "recommendations",
  "language": "en",
  "stack": "html-css-js",
  "prompt": "Build me a premium website for a construction company. First give me 3 recommendations for pages, layout, and visual style."
}
```

## Recommended ownership split
- Kimi writes/designs first
- OpenAI can act as smart fallback for the isolated lane
- Main system connects GitHub/Vercel and handles deployment
