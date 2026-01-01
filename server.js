const express = require('express');
const multer = require('multer');
const path = require('path');
const fs = require('fs');
const { OpenAI } = require('openai');
const sqlite3 = require('sqlite3').verbose();
require('dotenv').config();

const app = express();
const PORT = process.env.PORT || 3000;

// Initialize OpenAI
const openai = new OpenAI({
  apiKey: process.env.OPENAI_API_KEY,
});

// Available models
const MODELS = ['gpt-4-turbo', 'gpt-4o', 'gpt-4o-mini', 'gpt-3.5-turbo'];

// Store active translation jobs
const jobs = new Map();

// Configure multer for file uploads
const upload = multer({
  dest: 'uploads/',
  limits: { fileSize: 50 * 1024 * 1024 } // 50MB limit
});

app.use(express.static('public'));
app.use(express.json());

// Get available models
app.get('/api/models', (req, res) => {
  res.json(MODELS);
});

// Start translation job
app.post('/api/translate', upload.single('file'), async (req, res) => {
  try {
    if (!req.file) {
      return res.status(400).json({ error: 'No file uploaded' });
    }

    const { prompt, model } = req.body;
    if (!prompt) {
      return res.status(400).json({ error: 'Prompt is required' });
    }

    const jobId = Date.now().toString();
    const inputPath = req.file.path;
    const outputPath = path.join('uploads', `${jobId}_output.txt`);
    const dbPath = path.join('uploads', `${jobId}.db`);

    // Read the file
    const text = fs.readFileSync(inputPath, 'utf8');

    // Initialize job
    jobs.set(jobId, {
      status: 'processing',
      total: 0,
      completed: 0,
      failed: 0,
      outputPath,
      inputPath,
      dbPath,
      error: null
    });

    // Start translation in background
    processTranslation(jobId, text, prompt, model || 'gpt-4-turbo', outputPath, dbPath);

    res.json({ jobId });
  } catch (error) {
    res.status(500).json({ error: error.message });
  }
});

// Get job status
app.get('/api/status/:jobId', (req, res) => {
  const job = jobs.get(req.params.jobId);
  if (!job) {
    return res.status(404).json({ error: 'Job not found' });
  }
  res.json({
    status: job.status,
    total: job.total,
    completed: job.completed,
    failed: job.failed,
    error: job.error
  });
});

// Download result
app.get('/api/download/:jobId', (req, res) => {
  const job = jobs.get(req.params.jobId);
  if (!job) {
    return res.status(404).json({ error: 'Job not found' });
  }
  if (job.status !== 'complete') {
    return res.status(400).json({ error: 'Translation not complete' });
  }
  res.download(job.outputPath, 'translated.txt');
});

// Smart chunking - finds best break points in priority order:
// 1. Paragraph breaks (double newline)
// 2. Sentence endings (. ! ?)
// 3. Commas
// 4. Spaces
function splitTextIntoChunks(text, chunkSize = 4000) {
  const chunks = [];
  let startPos = 0;

  while (startPos < text.length) {
    // If remaining text fits in one chunk, take it all
    if (startPos + chunkSize >= text.length) {
      chunks.push(text.substring(startPos));
      break;
    }

    const searchStart = startPos + Math.floor(chunkSize * 0.5); // Don't break too early
    const searchEnd = startPos + chunkSize;
    const searchRegion = text.substring(searchStart, searchEnd);

    let breakOffset = -1;

    // Priority 1: Paragraph break (double newline)
    const paragraphMatch = searchRegion.lastIndexOf('\n\n');
    if (paragraphMatch !== -1) {
      breakOffset = paragraphMatch + 2; // After the double newline
    }

    // Priority 2: Sentence ending (. ! ? followed by space or newline)
    if (breakOffset === -1) {
      for (let i = searchRegion.length - 1; i >= 0; i--) {
        const char = searchRegion[i];
        const prevChar = i > 0 ? searchRegion[i - 1] : '';
        if ((prevChar === '.' || prevChar === '!' || prevChar === '?') &&
            (char === ' ' || char === '\n')) {
          breakOffset = i;
          break;
        }
      }
    }

    // Priority 3: Comma followed by space
    if (breakOffset === -1) {
      for (let i = searchRegion.length - 1; i >= 0; i--) {
        if (searchRegion[i] === ' ' && i > 0 && searchRegion[i - 1] === ',') {
          breakOffset = i;
          break;
        }
      }
    }

    // Priority 4: Any space
    if (breakOffset === -1) {
      const lastSpace = searchRegion.lastIndexOf(' ');
      if (lastSpace !== -1) {
        breakOffset = lastSpace + 1;
      }
    }

    // Calculate actual break position
    let breakPos;
    if (breakOffset !== -1) {
      breakPos = searchStart + breakOffset;
    } else {
      // No good break point found, hard cut at chunk size
      breakPos = searchEnd;
    }

    chunks.push(text.substring(startPos, breakPos));
    startPos = breakPos;
  }

  return chunks;
}

// Translate a single chunk
async function translateChunk(text, prompt, model) {
  const response = await openai.chat.completions.create({
    model: model,
    messages: [
      {
        role: "system",
        content: `${prompt}\n\nPreserve the original formatting and paragraph breaks. Only output the translation, no explanations.`
      },
      {
        role: "user",
        content: text
      }
    ],
    temperature: 0.3
  });

  return response.choices[0].message.content.trim();
}

// Process translation job
async function processTranslation(jobId, text, prompt, model, outputPath, dbPath) {
  const job = jobs.get(jobId);

  try {
    const chunks = splitTextIntoChunks(text);
    job.total = chunks.length;

    const translations = new Array(chunks.length);
    const maxConcurrent = 5;

    for (let i = 0; i < chunks.length; i += maxConcurrent) {
      const batch = chunks.slice(i, i + maxConcurrent);
      const batchPromises = batch.map(async (chunk, batchIndex) => {
        const chunkIndex = i + batchIndex;
        try {
          const translation = await translateChunk(chunk, prompt, model);
          translations[chunkIndex] = translation;
          job.completed++;
        } catch (error) {
          if (error.status === 429) {
            // Rate limit - wait and retry
            await new Promise(resolve => setTimeout(resolve, 20000));
            try {
              const translation = await translateChunk(chunk, prompt, model);
              translations[chunkIndex] = translation;
              job.completed++;
            } catch (retryError) {
              translations[chunkIndex] = `[TRANSLATION ERROR: ${retryError.message}]`;
              job.failed++;
            }
          } else {
            translations[chunkIndex] = `[TRANSLATION ERROR: ${error.message}]`;
            job.failed++;
          }
        }
      });

      await Promise.all(batchPromises);

      // Small delay between batches
      if (i + maxConcurrent < chunks.length) {
        await new Promise(resolve => setTimeout(resolve, 1000));
      }
    }

    // Write output - trim each chunk and join with double newline for consistent paragraph breaks
    const outputText = translations.map(t => t.trim()).join('\n\n');
    fs.writeFileSync(outputPath, outputText, 'utf8');

    job.status = 'complete';

    // Cleanup input file
    fs.unlinkSync(job.inputPath);

  } catch (error) {
    job.status = 'error';
    job.error = error.message;
  }
}

app.listen(PORT, () => {
  console.log(`Easy Translator running at http://localhost:${PORT}`);
});
