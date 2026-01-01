# Easy Translator

Translate large files using OpenAI with automatic chunking and resume support.

## Features

- Translates files of any size by splitting into chunks
- Resumes interrupted translations automatically
- Supports any language pair
- Concurrent API requests for speed
- SQLite database tracks progress

## Quick Start

1. Install dependencies:
   ```bash
   npm install
   ```

2. Create `.env` file with your OpenAI API key:
   ```
   OPENAI_API_KEY=your-api-key-here
   ```

3. Run translation:
   ```bash
   node translate.js input.txt output.txt
   ```

## Usage

```
node translate.js <input-file> <output-file> [source-lang] [target-lang]
```

### Examples

```bash
# Auto-detect language, translate to English
node translate.js document.txt translated.txt

# Specify source and target languages
node translate.js book.txt book_english.txt Hebrew English

# Translate to Spanish
node translate.js article.txt article_es.txt auto Spanish
```

## Configuration

Set these in your `.env` file:

| Variable | Default | Description |
|----------|---------|-------------|
| `OPENAI_API_KEY` | (required) | Your OpenAI API key |
| `OPENAI_MODEL` | gpt-4-turbo | Model to use |
| `CHUNK_SIZE` | 4000 | Characters per chunk |
| `MAX_CONCURRENT` | 5 | Parallel API requests |
| `TEMPERATURE` | 0.3 | Translation creativity |

## Resume Support

If translation is interrupted, just run the same command again. Progress is saved in a `.db` file next to your input file.

## License

MIT
