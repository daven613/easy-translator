# Easy Translator - Specification

> This document defines the current implementation and serves as the source of truth for development. Update this spec first, then update the code to match.

## Product Overview

A tool for translating large text files using OpenAI's GPT models with smart chunking and resume support.

## Versions

| Version | File | Status |
|---------|------|--------|
| Web (Primary) | `translator.html` | Active |
| CLI | `translate.js` | Active |
| Server | `server.js` | Deprecated |

---

## Web Version Spec (`translator.html`)

### Requirements
- Single HTML file, no external dependencies
- Runs entirely in browser (no server required)
- Hostable on GitHub Pages or opened locally

### Supported Models

| Model | Reasoning Effort | Notes |
|-------|-----------------|-------|
| gpt-5-nano | `minimal` | Fast & cheap |
| gpt-5-mini | `minimal` | Balanced |
| gpt-5.2 | `none` | Most capable |

### API Configuration

**Endpoint:** `https://api.openai.com/v1/responses`

**Request Format:**
```json
{
  "model": "<selected-model>",
  "instructions": "<prompt>\n\nPreserve the original formatting and paragraph breaks. Only output the translation, no explanations.",
  "input": "<chunk-text>",
  "reasoning": { "effort": "<minimal|none>" }
}
```

**Response Parsing:**
```javascript
const messageOutput = data.output.find(o => o.type === 'message');
const text = messageOutput.content[0].text;
```

### Storage

| Storage | Key | Purpose |
|---------|-----|---------|
| localStorage | `translator_apiKey` | API key |
| localStorage | `translator_model` | Selected model |
| localStorage | `translator_chunkSize` | Chunk size |
| localStorage | `translator_prompt` | Custom prompt |
| IndexedDB | `TranslatorDB` | Translation chunks & status |

### Default Settings

| Setting | Default Value |
|---------|---------------|
| Chunk Size | 4000 characters |
| Model | gpt-5-nano |
| Prompt | "Translate this text from Spanish to English in a professional manner." |

### UI Components

1. **Settings Card**
   - API key input (password field with show/hide)
   - Model selector dropdown
   - Chunk size input
   - Prompt textarea

2. **Input Card**
   - File upload or paste text
   - Translate button
   - Resume button (shown when pending translations exist)

3. **Progress Card** (shown during translation)
   - Progress bar with percentage
   - Status text (current chunk)

4. **Output Card** (shown after completion)
   - Translated text display
   - Download button
   - Copy button

5. **Premium CTA Card**
   - Tally.so popup button for email collection
   - Form ID: `KY50Dg`

### Resume Logic

1. On translate start: Store all chunks in IndexedDB with `status: 'pending'`
2. On chunk complete: Update to `status: 'success'`
3. On page load: Check for pending translations, show Resume button if found
4. On resume: Skip completed chunks, continue from first pending

---

## Smart Chunking Algorithm

**Goal:** Break text at natural boundaries, target ~4000 chars per chunk

**Break Point Priority:**
1. Paragraph break (`\n\n`)
2. Sentence end (`. ` or `! ` or `? `)
3. Comma + space (`, `)
4. Any space (` `)

**Search Region:** Last 50% of chunk size (to avoid tiny chunks)

**Fallback:** Hard cut at chunk size if no break point found

---

## CLI Version Spec (`translate.js`)

### Dependencies
```json
{
  "dotenv": "^16.4.7",
  "openai": "^4.86.2",
  "sqlite3": "^5.1.7"
}
```

### Usage
```bash
node translate.js <input-file> <output-file> [source-lang] [target-lang]
```

### Environment Variables (`.env`)

| Variable | Default | Description |
|----------|---------|-------------|
| OPENAI_API_KEY | (required) | API key |
| OPENAI_MODEL | gpt-4-turbo | Model to use |
| CHUNK_SIZE | 4000 | Characters per chunk |
| MAX_CONCURRENT | 5 | Parallel API calls |
| TEMPERATURE | 0.3 | Response randomness |

### Database Schema (SQLite)
```sql
CREATE TABLE translations (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  sequence_number INTEGER NOT NULL,
  source_text TEXT NOT NULL,
  translated_text TEXT,
  source_lang TEXT,
  target_lang TEXT,
  status TEXT DEFAULT 'pending',
  timestamp DATETIME DEFAULT CURRENT_TIMESTAMP,
  error_message TEXT,
  chunk_size INTEGER
)
```

---

## Performance Specs

| Metric | Target |
|--------|--------|
| Time per chunk | < 2 seconds |
| Reasoning tokens | 0 |
| Max chunk size | 4000 chars |

---

## Security Requirements

- API key stored locally only (never transmitted except to OpenAI)
- `.env` file must be gitignored
- No server-side credential storage in web version

---

## Deployment

### GitHub Pages
1. Push `translator.html` to repo
2. Enable Pages in Settings (main branch, root folder)
3. URL: `https://<username>.github.io/easy-translator/translator.html`

---

## Future Enhancements (Not Implemented)

- [ ] Batch file processing
- [ ] Additional models
- [ ] Cloud sync for translations
- [ ] Translation memory
- [ ] Glossary support
