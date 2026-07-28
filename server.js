import express from "express";
import path from "path";
import { fileURLToPath } from "url";
import dotenv from "dotenv";
import multer from "multer";
import { GoogleGenerativeAI } from "@google/generative-ai";

dotenv.config();

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const app = express();
const PORT = process.env.PORT || 3000;
const GEMINI_API_KEY = process.env.GEMINI_API_KEY;

// Files are kept in memory only (never written to disk) and capped at 20MB
const upload = multer({ 
  storage: multer.memoryStorage(), 
  limits: { fileSize: 20 * 1024 * 1024 } 
});

// Enable CORS so your GitHub Pages site can talk to this backend
app.use((req, res, next) => {
  res.setHeader("Access-Control-Allow-Origin", "*");
  res.setHeader("Access-Control-Allow-Methods", "GET, POST, OPTIONS");
  res.setHeader("Access-Control-Allow-Headers", "Content-Type");
  if (req.method === "OPTIONS") {
    return res.sendStatus(200);
  }
  next();
});

app.use(express.json());
app.use(express.static(path.join(__dirname, "public")));

// Initialize Gemini Client
const genAI = new GoogleGenerativeAI(GEMINI_API_KEY);

const QUESTION_SYSTEM_PROMPT = `You generate university-level quiz questions.
Respond with ONLY a raw JSON array matching this exact structure:
[
  {
    "type": "mcq",
    "text": "the question text",
    "options": ["Option 1", "Option 2", "Option 3", "Option 4"],
    "correct": 0,
    "explanation": "Brief explanation of the correct answer"
  }
]
For "tf" (True/False) questions, set type to "tf" and options strictly to ["True", "False"].
Mix "mcq" and "tf" types. Keep questions accurate, unambiguous, and appropriately challenging.`;

// ── 1. Generate Quiz from Topic ──
app.post("/api/generate-quiz", async (req, res) => {
  try {
    if (!GEMINI_API_KEY) {
      return res.status(500).json({ error: "Server is missing GEMINI_API_KEY in .env file." });
    }

    const { topic, count = 8 } = req.body || {};
    if (!topic || typeof topic !== "string" || !topic.trim()) {
      return res.status(400).json({ error: "A 'topic' string is required." });
    }

    const numQuestions = Math.min(Math.max(parseInt(count, 10) || 8, 1), 30);

    const model = genAI.getGenerativeModel({
      model: "gemini-3.6-flash",
      systemInstruction: QUESTION_SYSTEM_PROMPT,
      generationConfig: { responseMimeType: "application/json" },
    });

    const userPrompt = `Generate ${numQuestions} quiz questions about: ${topic.trim()}`;
    const result = await model.generateContent(userPrompt);
    const textResponse = result.response.text();
    const questions = JSON.parse(textResponse);

    res.json({ questions });
  } catch (err) {
    console.error("Gemini Topic API Error:", err);
    res.status(500).json({ error: "Failed to generate quiz. Check server logs." });
  }
});

// ── 2. Generate Quiz from Uploaded File (PDF or Plain Text) ──
app.post("/api/generate-quiz-from-file", upload.single("file"), async (req, res) => {
  try {
    if (!GEMINI_API_KEY) {
      return res.status(500).json({ error: "Server is missing GEMINI_API_KEY in .env file." });
    }
    if (!req.file) {
      return res.status(400).json({ error: "No file was uploaded." });
    }

    const count = req.body?.count;
    const numQuestions = Math.min(Math.max(parseInt(count, 10) || 10, 1), 20);

    // Check both mimeType AND file extension (crucial for mobile uploads)
    const mimeType = req.file.mimetype;
    const originalName = req.file.originalname.toLowerCase();

    const isPdf = mimeType === "application/pdf" || mimeType === "application/x-pdf" || originalName.endsWith(".pdf");
    const isText = mimeType.startsWith("text/") || originalName.endsWith(".txt") || originalName.endsWith(".md");

    if (!isPdf && !isText) {
      return res.status(400).json({
        error: "Only PDF or plain text files (.pdf, .txt, .md) are supported.",
      });
    }

    const instruction = `This document is course material. Read it and generate ${numQuestions} quiz questions
that test understanding of the curriculum covered in the document — concepts, definitions, facts,
and reasoning it contains. Base every question strictly on content actually present in the document.`;

    const model = genAI.getGenerativeModel({
      model: "gemini-3.6-flash",
      systemInstruction: QUESTION_SYSTEM_PROMPT,
      generationConfig: { responseMimeType: "application/json" },
    });

    let promptContents = [];

    if (isPdf) {
      // Send PDF buffer directly as base64 inlineData
      promptContents.push({
        inlineData: {
          data: req.file.buffer.toString("base64"),
          mimeType: "application/pdf",
        },
      });
      promptContents.push(instruction);
    } else {
      const fileText = req.file.buffer.toString("utf-8").slice(0, 100000);
      promptContents.push(`${instruction}\n\nDOCUMENT CONTENT:\n"""\n${fileText}\n"""`);
    }

    const result = await model.generateContent(promptContents);
    const textResponse = result.response.text();
    const questions = JSON.parse(textResponse);

    res.json({ questions, filename: req.file.originalname });
  } catch (err) {
    console.error("Gemini File API Error:", err);
    if (err.code === "LIMIT_FILE_SIZE") {
      return res.status(400).json({ error: "File is too large (20MB max)." });
    }
    res.status(500).json({ error: "Failed to process document and generate quiz." });
  }
});

app.listen(PORT, () => {
  console.log(`Uniquiz Gemini server running on port ${PORT}`);
});
        
  
