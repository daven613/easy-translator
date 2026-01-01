#!/usr/bin/env node
const fs = require('fs');
const path = require('path');
const { OpenAI } = require('openai');
const sqlite3 = require('sqlite3').verbose();
require('dotenv').config();

// Initialize the OpenAI client
const openai = new OpenAI({
  apiKey: process.env.OPENAI_API_KEY,
});

// Default configuration
const CONFIG = {
  model: process.env.OPENAI_MODEL || 'gpt-4-turbo',
  chunkSize: parseInt(process.env.CHUNK_SIZE) || 4000,
  maxConcurrent: parseInt(process.env.MAX_CONCURRENT) || 5,
  temperature: parseFloat(process.env.TEMPERATURE) || 0.3,
};

/**
 * Initialize the SQLite database
 */
function initializeDatabase(dbPath) {
  return new Promise((resolve, reject) => {
    const db = new sqlite3.Database(dbPath, (err) => {
      if (err) {
        reject(err);
        return;
      }

      db.run(`
        CREATE TABLE IF NOT EXISTS translations (
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
      `, (err) => {
        if (err) {
          reject(err);
          return;
        }
        resolve(db);
      });
    });
  });
}

/**
 * Split text into chunks, preserving paragraph and sentence boundaries
 */
function splitTextIntoChunks(text, chunkSize) {
  const chunks = [];
  let startPos = 0;

  while (startPos < text.length) {
    let maxEndPos = Math.min(startPos + chunkSize, text.length);

    if (maxEndPos < text.length) {
      // Try to find break points in order of preference

      // 1. Double newline (paragraph break)
      let breakPos = -1;
      for (let i = maxEndPos; i > startPos + (chunkSize / 2); i--) {
        if (text[i] === '\n' && text[i-1] === '\n') {
          breakPos = i + 1;
          break;
        }
      }

      if (breakPos !== -1) {
        maxEndPos = breakPos;
      } else {
        // 2. Sentence ending (.!?)
        for (let i = maxEndPos; i > Math.max(startPos, maxEndPos - 500); i--) {
          if ((text[i-1] === '.' || text[i-1] === '!' || text[i-1] === '?') &&
              (text[i] === ' ' || text[i] === '\n')) {
            maxEndPos = i;
            break;
          }
        }
      }

      // 3. Last resort: space
      if (maxEndPos === Math.min(startPos + chunkSize, text.length)) {
        let spacePos = text.lastIndexOf(' ', maxEndPos);
        if (spacePos !== -1 && spacePos > startPos) {
          maxEndPos = spacePos + 1;
        }
      }
    }

    const chunk = text.substring(startPos, maxEndPos);
    chunks.push(chunk);
    startPos = maxEndPos;
  }

  return chunks;
}

/**
 * Store chunks in the database
 */
function storeChunksInDatabase(db, chunks, sourceLang, targetLang, chunkSize) {
  return new Promise((resolve, reject) => {
    db.run('BEGIN TRANSACTION', (err) => {
      if (err) {
        reject(err);
        return;
      }

      db.run('DELETE FROM translations', (err) => {
        if (err) {
          db.run('ROLLBACK', () => reject(err));
          return;
        }

        const stmt = db.prepare(`
          INSERT INTO translations (sequence_number, source_text, source_lang, target_lang, chunk_size)
          VALUES (?, ?, ?, ?, ?)
        `);

        for (let i = 0; i < chunks.length; i++) {
          stmt.run(i, chunks[i], sourceLang, targetLang, chunkSize);
        }

        stmt.finalize();

        db.run('COMMIT', (err) => {
          if (err) {
            reject(err);
            return;
          }
          resolve();
        });
      });
    });
  });
}

/**
 * Translate a single chunk
 */
async function translateChunk(text, chunkIndex, sourceLang, targetLang) {
  console.log(`  Translating chunk ${chunkIndex + 1} (${text.length} chars)...`);

  const langInstruction = sourceLang === 'auto'
    ? `Translate the following text to ${targetLang}`
    : `Translate the following ${sourceLang} text to ${targetLang}`;

  try {
    const response = await openai.chat.completions.create({
      model: CONFIG.model,
      messages: [
        {
          role: "system",
          content: `You are a professional translator. ${langInstruction}. Preserve the original meaning, tone, and formatting. Maintain paragraph breaks. Only output the translation, no explanations.`
        },
        {
          role: "user",
          content: text
        }
      ],
      temperature: CONFIG.temperature
    });

    return response.choices[0].message.content.trim();
  } catch (error) {
    if (error.status === 429) {
      console.log('  Rate limit hit, waiting 20 seconds...');
      await new Promise(resolve => setTimeout(resolve, 20000));
      return translateChunk(text, chunkIndex, sourceLang, targetLang);
    }
    throw error;
  }
}

/**
 * Process pending translations
 */
async function processTranslations(db, maxConcurrent) {
  return new Promise((resolve, reject) => {
    db.all(`
      SELECT id, sequence_number, source_text, source_lang, target_lang
      FROM translations
      WHERE status = 'pending'
      ORDER BY sequence_number
    `, async (err, rows) => {
      if (err) {
        reject(err);
        return;
      }

      console.log(`\nProcessing ${rows.length} chunks...\n`);

      for (let i = 0; i < rows.length; i += maxConcurrent) {
        const batch = rows.slice(i, i + maxConcurrent);

        const promises = batch.map(async (row) => {
          try {
            const translation = await translateChunk(
              row.source_text,
              row.sequence_number,
              row.source_lang,
              row.target_lang
            );

            return new Promise((resolve, reject) => {
              db.run(`
                UPDATE translations
                SET translated_text = ?, status = 'success', timestamp = CURRENT_TIMESTAMP
                WHERE id = ?
              `, [translation, row.id], (err) => {
                if (err) reject(err);
                else resolve();
              });
            });
          } catch (error) {
            return new Promise((resolve) => {
              db.run(`
                UPDATE translations
                SET status = 'failure', error_message = ?, timestamp = CURRENT_TIMESTAMP
                WHERE id = ?
              `, [error.message || 'Unknown error', row.id], () => resolve());
            });
          }
        });

        await Promise.all(promises);

        if (i + maxConcurrent < rows.length) {
          await new Promise(resolve => setTimeout(resolve, 1000));
        }
      }

      resolve();
    });
  });
}

/**
 * Generate output file from database
 */
async function generateOutput(db, outputFilePath) {
  return new Promise((resolve, reject) => {
    db.all(`
      SELECT sequence_number, translated_text, status
      FROM translations
      ORDER BY sequence_number
    `, (err, rows) => {
      if (err) {
        reject(err);
        return;
      }

      const stats = { total: rows.length, success: 0, failure: 0 };
      const translatedChunks = new Array(rows.length);

      for (const row of rows) {
        if (row.status === 'success') {
          translatedChunks[row.sequence_number] = row.translated_text;
          stats.success++;
        } else {
          translatedChunks[row.sequence_number] = `[TRANSLATION ERROR IN CHUNK ${row.sequence_number + 1}]`;
          stats.failure++;
        }
      }

      // Check for gaps
      for (let i = 0; i < translatedChunks.length; i++) {
        if (translatedChunks[i] === undefined) {
          translatedChunks[i] = `[MISSING CHUNK ${i + 1}]`;
          stats.failure++;
        }
      }

      const outputDir = path.dirname(outputFilePath);
      if (outputDir && !fs.existsSync(outputDir)) {
        fs.mkdirSync(outputDir, { recursive: true });
      }

      const translatedText = translatedChunks.join('\n\n');
      fs.writeFileSync(outputFilePath, translatedText, 'utf8');

      resolve(stats);
    });
  });
}

/**
 * Get translation statistics
 */
async function getTranslationStats(db) {
  return new Promise((resolve, reject) => {
    db.get(`
      SELECT
        COUNT(*) as total,
        SUM(CASE WHEN status = 'success' THEN 1 ELSE 0 END) as success,
        SUM(CASE WHEN status = 'failure' THEN 1 ELSE 0 END) as failure,
        SUM(CASE WHEN status = 'pending' THEN 1 ELSE 0 END) as pending
      FROM translations
    `, (err, row) => {
      if (err) reject(err);
      else resolve(row || { total: 0, success: 0, failure: 0, pending: 0 });
    });
  });
}

/**
 * Main translation function
 */
async function translateFile(inputFilePath, outputFilePath, sourceLang, targetLang, options = {}) {
  const dbPath = options.dbPath || inputFilePath.replace(/\.[^.]+$/, '') + '.db';
  const chunkSize = options.chunkSize || CONFIG.chunkSize;
  const maxConcurrent = options.maxConcurrent || CONFIG.maxConcurrent;
  const clearDatabase = options.clearDatabase || false;

  console.log('\n========================================');
  console.log('  Easy Translator');
  console.log('========================================\n');
  console.log(`Input:  ${inputFilePath}`);
  console.log(`Output: ${outputFilePath}`);
  console.log(`Languages: ${sourceLang} -> ${targetLang}`);
  console.log(`Model: ${CONFIG.model}`);
  console.log(`Chunk size: ${chunkSize} chars`);
  console.log(`Concurrent requests: ${maxConcurrent}`);

  try {
    const text = fs.readFileSync(inputFilePath, 'utf8');
    console.log(`\nFile size: ${text.length.toLocaleString()} characters`);

    const db = await initializeDatabase(dbPath);
    const stats = await getTranslationStats(db);

    if (stats.total > 0 && !clearDatabase) {
      console.log(`\nFound existing progress: ${stats.success}/${stats.total} completed`);

      if (stats.pending > 0 || stats.failure > 0) {
        console.log(`Resuming: ${stats.pending} pending, ${stats.failure} failed`);
        await processTranslations(db, maxConcurrent);
      }
    } else {
      const chunks = splitTextIntoChunks(text, chunkSize);
      console.log(`Split into ${chunks.length} chunks`);

      await storeChunksInDatabase(db, chunks, sourceLang, targetLang, chunkSize);
      await processTranslations(db, maxConcurrent);
    }

    console.log('\nGenerating output file...');
    const finalStats = await generateOutput(db, outputFilePath);

    db.close();

    console.log('\n========================================');
    console.log('  Translation Complete!');
    console.log('========================================');
    console.log(`Successful: ${finalStats.success}/${finalStats.total} chunks`);
    if (finalStats.failure > 0) {
      console.log(`Failed: ${finalStats.failure} chunks`);
    }
    console.log(`Output saved to: ${outputFilePath}`);
    console.log(`Database saved to: ${dbPath} (for resume)\n`);

    return { status: 'success', stats: finalStats, outputPath: outputFilePath, dbPath };
  } catch (error) {
    console.error('\nError:', error.message);
    throw error;
  }
}

/**
 * Show usage help
 */
function showHelp() {
  console.log(`
Easy Translator - Translate large files using OpenAI

USAGE:
  node translate.js <input-file> <output-file> [source-lang] [target-lang]

ARGUMENTS:
  input-file    Path to the file to translate
  output-file   Path for the translated output
  source-lang   Source language (default: auto)
  target-lang   Target language (default: English)

EXAMPLES:
  node translate.js document.txt translated.txt
  node translate.js book.txt book_english.txt Hebrew English
  node translate.js article.txt article_es.txt auto Spanish

ENVIRONMENT VARIABLES (in .env file):
  OPENAI_API_KEY    Your OpenAI API key (required)
  OPENAI_MODEL      Model to use (default: gpt-4-turbo)
  CHUNK_SIZE        Characters per chunk (default: 4000)
  MAX_CONCURRENT    Concurrent API calls (default: 5)
  TEMPERATURE       Translation temperature (default: 0.3)

RESUME:
  If translation is interrupted, just run the same command again.
  Progress is saved in a .db file alongside your input file.
`);
}

// CLI
async function main() {
  const args = process.argv.slice(2);

  if (args.length === 0 || args[0] === '--help' || args[0] === '-h') {
    showHelp();
    return;
  }

  if (args.length < 2) {
    console.error('Error: Please provide input and output file paths');
    console.log('Run with --help for usage information');
    process.exit(1);
  }

  if (!process.env.OPENAI_API_KEY) {
    console.error('Error: OPENAI_API_KEY not found');
    console.log('\nCreate a .env file with:');
    console.log('OPENAI_API_KEY=your-api-key-here');
    process.exit(1);
  }

  const inputFile = args[0];
  const outputFile = args[1];
  const sourceLang = args[2] || 'auto';
  const targetLang = args[3] || 'English';

  if (!fs.existsSync(inputFile)) {
    console.error(`Error: Input file not found: ${inputFile}`);
    process.exit(1);
  }

  try {
    await translateFile(inputFile, outputFile, sourceLang, targetLang);
  } catch (error) {
    console.error('Translation failed:', error.message);
    process.exit(1);
  }
}

if (require.main === module) {
  main();
} else {
  module.exports = { translateFile, splitTextIntoChunks, CONFIG };
}
