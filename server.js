// server.js
// Minimal backend that keeps your Anthropic API key on the server and
// exposes a single endpoint the frontend can call to generate quiz questions.
//
// Setup:
//   1. npm install
//   2. cp .env.example .env   and paste in your real API key
//   3. npm start
//   4. open http://localhost:3000

import express from "express";
import path from "path";
import { fileURLToPath } from "url";
import dotenv from "dotenv";
import multer from "multer";

dotenv.config();

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const app = express();
const PORT = process.env.PORT || 3000;
const ANTHROPIC_API_KEY = process.env.ANTHROPIC_API_KEY;

// Files are kept in memory only (never written to disk) and capped at 20MB,
// matching the Claude API's per-file PDF limit.
const upload = multer({ storage: multer.memoryStorage(), limits: { fileSize: 20 * 1024 * 1024 } });

app.use(express.json());
app.use(express.static(path.join(__dirname, "public")));

const QUESTION_SYSTEM_PROMPT = `You generate university-level quiz questions.
Respond with ONLY a raw JSON array (no markdown fences, no commentary, no preamble).
Each element must match exactly this shape:
{
  "type": "mcq" | "tf",
  "text": "the question",
  "options": ["array of option strings; 4 for mcq, exactly [\\"True\\",\\"False\\"] for tf"],
  "correct": <integer index into options of the correct answer>,
  "explanation": "one or two sentence explanation of the correct answer"
}
Mix "mcq" and "tf" types. Keep questions accurate, unambiguous, and appropriately challenging.`;

function extractQuestionsFromResponse(data) {
  const textBlock = (data.content || []).find((b) => b.type === "text");
  if (!textBlock) throw new Error("No text content returned by the model.");
  const cleaned = textBlock.text.replace(/```json|```/g, "").trim();
  const questions = JSON.parse(cleaned);
  if (!Array.isArray(questions) || questions.length === 0) {
    throw new Error("Model returned an empty or invalid question set.");
  }
  return questions;
}

app.post("/api/generate-quiz", async (req, res) => {
  try {
    if (!ANTHROPIC_API_KEY) {
      return res.status(500).json({ error: "Server is missing ANTHROPIC_API_KEY. Add it to your .env file." });
    }

    const { topic, count = 8 } = req.body || {};
    if (!topic || typeof topic !== "string" || !topic.trim()) {
      return res.status(400).json({ error: "A 'topic' string is required." });
    }
    const numQuestions = Math.min(Math.max(parseInt(count, 10) || 8, 1), 20);
    const userPrompt = `Generate ${numQuestions} quiz questions about: ${topic.trim()}`;

    const response = await fetch("https://api.anthropic.com/v1/messages", {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        "x-api-key": ANTHROPIC_API_KEY,
        "anthropic-version": "2023-06-01",
      },
      body: JSON.stringify({
        model: "claude-sonnet-5",
        max_tokens: 4000,
        system: QUESTION_SYSTEM_PROMPT,
        messages: [{ role: "user", content: userPrompt }],
      }),
    });

    if (!response.ok) {
      const errText = await response.text();
      console.error("Anthropic API error:", response.status, errText);
      return res.status(502).json({ error: "The AI provider returned an error. Check server logs." });
    }

    const data = await response.json();
    let questions;
    try {
      questions = extractQuestionsFromResponse(data);
    } catch (e) {
      console.error("Failed to parse model output:", e.message);
      return res.status(502).json({ error: "Model did not return a valid question set. Try again." });
    }

    res.json({ questions });
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: "Unexpected server error." });
  }
});

// ── Generate questions from an uploaded file (PDF or plain text) ──
app.post("/api/generate-quiz-from-file", upload.single("file"), async (req, res) => {
  try {
    if (!ANTHROPIC_API_KEY) {
      return res.status(500).json({ error: "Server is missing ANTHROPIC_API_KEY. Add it to your .env file." });
    }
    if (!req.file) {
      return res.status(400).json({ error: "No file was uploaded." });
    }

    const count = req.body?.count;
    const numQuestions = Math.min(Math.max(parseInt(count, 10) || 10, 1), 20);
    const mimeType = req.file.mimetype;
    const isPdf = mimeType === "application/pdf";
    const isText = mimeType.startsWith("text/") || mimeType === "application/octet-stream";

    if (!isPdf && !isText) {
      return res.status(400).json({
        error: "Only PDF or plain text files (.pdf, .txt, .md) are supported right now.",
      });
    }

    const instruction = `This document is course material. Read it and generate ${numQuestions} quiz questions
that test understanding of the curriculum covered in the document — concepts, definitions, facts,
and reasoning it contains. Base every question strictly on content actually present in the document.`;

    let userContent;
    if (isPdf) {
      const base64 = req.file.buffer.toString("base64");
      userContent = [
        { type: "document", source: { type: "base64", media_type: "application/pdf", data: base64 } },
        { type: "text", text: instruction },
      ];
    } else {
      const fileText = req.file.buffer.toString("utf-8").slice(0, 100000); // guard against huge files
      userContent = [{ type: "text", text: `${instruction}\n\nDOCUMENT CONTENT:\n"""\n${fileText}\n"""` }];
    }

    const response = await fetch("https://api.anthropic.com/v1/messages", {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        "x-api-key": ANTHROPIC_API_KEY,
        "anthropic-version": "2023-06-01",
      },
      body: JSON.stringify({
        model: "claude-sonnet-5",
        max_tokens: 4000,
        system: QUESTION_SYSTEM_PROMPT,
        messages: [{ role: "user", content: userContent }],
      }),
    });

    if (!response.ok) {
      const errText = await response.text();
      console.error("Anthropic API error:", response.status, errText);
      return res.status(502).json({ error: "The AI provider returned an error. Check server logs." });
    }

    const data = await response.json();
    let questions;
    try {
      questions = extractQuestionsFromResponse(data);
    } catch (e) {
      console.error("Failed to parse model output:", e.message);
      return res.status(502).json({ error: "Model did not return a valid question set. Try again." });
    }

    res.json({ questions, filename: req.file.originalname });
  } catch (err) {
    console.error(err);
    if (err.code === "LIMIT_FILE_SIZE") {
      return res.status(400).json({ error: "File is too large (20MB max)." });
    }
    res.status(500).json({ error: "Unexpected server error." });
  }
});

app.listen(PORT, () => {
  console.log(`Uniquiz AI server running at http://localhost:${PORT}`);
});
