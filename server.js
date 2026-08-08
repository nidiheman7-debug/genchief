import express from "express";
import path from "path";
import { fileURLToPath } from "url";
import dotenv from "dotenv";
import multer from "multer";
import { GoogleGenerativeAI } from "@google/generative-ai";
import admin from "firebase-admin";

dotenv.config();

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const app = express();
const PORT = process.env.PORT || 3000;
const GEMINI_API_KEY = process.env.GEMINI_API_KEY;
const PAYSTACK_SECRET_KEY = process.env.PAYSTACK_SECRET_KEY;

// ── Monetization config — change these two numbers whenever you like ──
const FREE_DAILY_GENERATIONS = 5;
const CREDIT_PACK = { credits: 20, amountKobo: 20000, label: "20 extra generations — ₦200" }; // amountKobo is in kobo (₦200 = 20000 kobo)

// ── Firebase Admin SDK — verifies who's signed in and reads/writes their usage record ──
// Set FIREBASE_SERVICE_ACCOUNT as an env var on Render containing the full JSON
// from Firebase console > Project settings > Service accounts > Generate new private key
// (paste the whole JSON file's contents as a single-line string).
let firestore = null;
try {
  if (process.env.FIREBASE_SERVICE_ACCOUNT) {
    const serviceAccount = JSON.parse(process.env.FIREBASE_SERVICE_ACCOUNT);
    admin.initializeApp({ credential: admin.credential.cert(serviceAccount) });
    firestore = admin.firestore();
  } else {
    console.warn("FIREBASE_SERVICE_ACCOUNT not set — sign-in-gated generation and payments are disabled.");
  }
} catch (e) {
  console.warn("Firebase Admin init failed — sign-in-gated generation and payments are disabled.", e);
}

// Verifies the Firebase ID token sent from the frontend and attaches req.uid
async function requireAuth(req, res, next) {
  try {
    if (!firestore) {
      return res.status(500).json({ error: "Server auth isn't configured yet." });
    }
    const authHeader = req.headers.authorization || "";
    const idToken = authHeader.startsWith("Bearer ") ? authHeader.slice(7) : null;
    if (!idToken) {
      return res.status(401).json({ error: "Please sign in to generate a quiz." });
    }
    const decoded = await admin.auth().verifyIdToken(idToken);
    req.uid = decoded.uid;
    req.userEmail = decoded.email || null;
    next();
  } catch (err) {
    console.error("Auth verification failed:", err);
    res.status(401).json({ error: "Your sign-in has expired — please sign in again." });
  }
}

// Reads (and resets if it's a new day) a user's usage record, without consuming anything yet
async function getUsage(uid) {
  const ref = firestore.collection("usage").doc(uid);
  const snap = await ref.get();
  const today = new Date().toISOString().slice(0, 10); // YYYY-MM-DD

  let data = snap.exists ? snap.data() : { freeUsedToday: 0, freeResetDate: today, credits: 0 };
  if (data.freeResetDate !== today) {
    data = { ...data, freeUsedToday: 0, freeResetDate: today };
  }
  return { ref, data };
}

// Checks whether the user can generate right now, and if so, consumes one unit
// (free daily allowance first, then paid credits). Returns { allowed, remainingFree, credits }.
async function consumeGeneration(uid) {
  const { ref, data } = await getUsage(uid);

  if (data.freeUsedToday < FREE_DAILY_GENERATIONS) {
    const updated = { ...data, freeUsedToday: data.freeUsedToday + 1 };
    await ref.set(updated, { merge: true });
    return { allowed: true, remainingFree: FREE_DAILY_GENERATIONS - updated.freeUsedToday, credits: updated.credits };
  }

  if (data.credits > 0) {
    const updated = { ...data, credits: data.credits - 1 };
    await ref.set(updated, { merge: true });
    return { allowed: true, remainingFree: 0, credits: updated.credits };
  }

  await ref.set(data, { merge: true }); // persist reset even if we're not consuming
  return { allowed: false, remainingFree: 0, credits: data.credits };
}

// Files are kept in memory only (never written to disk) and capped at 20MB
const upload = multer({ 
  storage: multer.memoryStorage(), 
  limits: { fileSize: 20 * 1024 * 1024 } 
});

// Enable CORS so your GitHub Pages site can talk to this backend
app.use((req, res, next) => {
  res.setHeader("Access-Control-Allow-Origin", "*");
  res.setHeader("Access-Control-Allow-Methods", "GET, POST, OPTIONS");
  res.setHeader("Access-Control-Allow-Headers", "Content-Type, Authorization");
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
    "explanation": "Brief explanation of the correct answer",
    "hint": "A short clue that nudges the student toward the answer WITHOUT stating or directly implying which option is correct"
  }
]
For "tf" (True/False) questions, set type to "tf" and options strictly to ["True", "False"].
Mix "mcq" and "tf" types. Keep questions accurate, unambiguous, and appropriately challenging.
Every question must include a "hint" field — keep hints to one short sentence, and never let the hint give away the answer outright.
Never use LaTeX or math markup (no $, $$, \(, \[, or similar delimiters). Write all math in plain text using standard characters — e.g. "x^2 + 3x - 4 = 0", "sqrt(16)", "5/8", "3.14", not LaTeX commands or dollar-sign wrappers.`;

// ── 1. Generate Quiz from Topic ──
app.post("/api/generate-quiz", requireAuth, async (req, res) => {
  try {
    if (!GEMINI_API_KEY) {
      return res.status(500).json({ error: "Server is missing GEMINI_API_KEY in .env file." });
    }

    const usage = await consumeGeneration(req.uid);
    if (!usage.allowed) {
      return res.status(402).json({
        error: "You've used today's free generations. Buy more to keep going.",
        code: "OUT_OF_GENERATIONS",
      });
    }

    const { topic, count = 8 } = req.body || {};
    if (!topic || typeof topic !== "string" || !topic.trim()) {
      return res.status(400).json({ error: "A 'topic' string is required." });
    }

    const numQuestions = Math.min(Math.max(parseInt(count, 10) || 8, 1), 25);

    const model = genAI.getGenerativeModel({
      model: "gemini-3.6-flash",
      systemInstruction: QUESTION_SYSTEM_PROMPT,
      generationConfig: { responseMimeType: "application/json" },
    });

    const userPrompt = `Generate ${numQuestions} quiz questions about: ${topic.trim()}`;
    const result = await model.generateContent(userPrompt);
    const textResponse = result.response.text();
    const questions = JSON.parse(textResponse);

    res.json({ questions, remainingFree: usage.remainingFree, credits: usage.credits });
  } catch (err) {
    console.error("Gemini Topic API Error:", err);
    res.status(500).json({ error: "Failed to generate quiz. Check server logs." });
  }
});

// ── 2. Generate Quiz from Uploaded File (PDF or Plain Text) ──
app.post("/api/generate-quiz-from-file", requireAuth, upload.single("file"), async (req, res) => {
  try {
    if (!GEMINI_API_KEY) {
      return res.status(500).json({ error: "Server is missing GEMINI_API_KEY in .env file." });
    }
    if (!req.file) {
      return res.status(400).json({ error: "No file was uploaded." });
    }

    const usage = await consumeGeneration(req.uid);
    if (!usage.allowed) {
      return res.status(402).json({
        error: "You've used today's free generations. Buy more to keep going.",
        code: "OUT_OF_GENERATIONS",
      });
    }

    const count = req.body?.count;
    const numQuestions = Math.min(Math.max(parseInt(count, 10) || 10, 1), 25);

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

    res.json({ questions, filename: req.file.originalname, remainingFree: usage.remainingFree, credits: usage.credits });
  } catch (err) {
    console.error("Gemini File API Error:", err);
    if (err.code === "LIMIT_FILE_SIZE") {
      return res.status(400).json({ error: "File is too large (20MB max)." });
    }
    res.status(500).json({ error: "Failed to process document and generate quiz." });
  }
});

// ── 3. Check current usage (free remaining + paid credits) without consuming anything ──
app.get("/api/usage", requireAuth, async (req, res) => {
  try {
    const { data } = await getUsage(req.uid);
    res.json({
      remainingFree: Math.max(0, FREE_DAILY_GENERATIONS - data.freeUsedToday),
      dailyFreeLimit: FREE_DAILY_GENERATIONS,
      credits: data.credits || 0,
      creditPack: CREDIT_PACK,
    });
  } catch (err) {
    console.error("Usage check error:", err);
    res.status(500).json({ error: "Couldn't check your usage right now." });
  }
});

// ── 4. Start a Paystack payment for a credit pack ──
app.post("/api/paystack/initialize", requireAuth, async (req, res) => {
  try {
    if (!PAYSTACK_SECRET_KEY) {
      return res.status(500).json({ error: "Payments aren't set up yet on the server." });
    }
    const email = req.userEmail || `${req.uid}@omegaprep.user`;
    const reference = `omegaprep_${req.uid}_${Date.now()}`;
    const origin = `${req.protocol}://${req.get("host")}`;

    const psRes = await fetch("https://api.paystack.co/transaction/initialize", {
      method: "POST",
      headers: {
        Authorization: `Bearer ${PAYSTACK_SECRET_KEY}`,
        "Content-Type": "application/json",
      },
      body: JSON.stringify({
        email,
        amount: CREDIT_PACK.amountKobo,
        reference,
        callback_url: `${origin}/?paystackReturn=1`,
        metadata: { uid: req.uid, credits: CREDIT_PACK.credits },
      }),
    });
    const psData = await psRes.json();
    if (!psData.status) {
      return res.status(500).json({ error: psData.message || "Couldn't start payment." });
    }

    res.json({
      authorizationUrl: psData.data.authorization_url,
      accessCode: psData.data.access_code,
      reference,
    });
  } catch (err) {
    console.error("Paystack initialize error:", err);
    res.status(500).json({ error: "Couldn't start payment. Try again." });
  }
});

// ── 5. Verify a Paystack payment and credit the user's account ──
// Idempotent: a reference already marked processed won't be credited twice,
// even if the frontend calls this more than once for the same payment.
app.post("/api/paystack/verify", requireAuth, async (req, res) => {
  try {
    if (!PAYSTACK_SECRET_KEY) {
      return res.status(500).json({ error: "Payments aren't set up yet on the server." });
    }
    const { reference } = req.body || {};
    if (!reference) {
      return res.status(400).json({ error: "Missing payment reference." });
    }

    const paymentRef = firestore.collection("processedPayments").doc(reference);
    const alreadyProcessed = await paymentRef.get();
    if (alreadyProcessed.exists) {
      const { data } = await getUsage(req.uid);
      return res.json({ credited: false, alreadyProcessed: true, credits: data.credits || 0 });
    }

    const psRes = await fetch(`https://api.paystack.co/transaction/verify/${encodeURIComponent(reference)}`, {
      headers: { Authorization: `Bearer ${PAYSTACK_SECRET_KEY}` },
    });
    const psData = await psRes.json();

    if (!psData.status || psData.data?.status !== "success") {
      return res.status(402).json({ error: "Payment was not successful." });
    }

    const usageRef = firestore.collection("usage").doc(req.uid);
    await firestore.runTransaction(async (tx) => {
      const snap = await tx.get(usageRef);
      const current = snap.exists ? snap.data() : { freeUsedToday: 0, freeResetDate: new Date().toISOString().slice(0, 10), credits: 0 };
      tx.set(usageRef, { ...current, credits: (current.credits || 0) + CREDIT_PACK.credits }, { merge: true });
      tx.set(paymentRef, { uid: req.uid, reference, credits: CREDIT_PACK.credits, processedAt: new Date().toISOString() });
    });

    const { data } = await getUsage(req.uid);
    res.json({ credited: true, credits: data.credits || 0 });
  } catch (err) {
    console.error("Paystack verify error:", err);
    res.status(500).json({ error: "Couldn't verify payment. Contact support if you were charged." });
  }
});

app.listen(PORT, () => {
  console.log(`Omega Prep server running on port ${PORT}`);
});
        
  
