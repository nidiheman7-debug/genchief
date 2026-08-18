import express from "express";
import path from "path";
import { fileURLToPath } from "url";
import dotenv from "dotenv";
import multer from "multer";
import { GoogleGenAI } from "@google/genai";
import admin from "firebase-admin";

dotenv.config();

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const app = express();
const PORT = process.env.PORT || 3000;
const GEMINI_API_KEY = process.env.GEMINI_API_KEY;
const PAYSTACK_SECRET_KEY = process.env.PAYSTACK_SECRET_KEY;

// ── Monetization config — change these two numbers whenever you like ──
const FREE_DAILY_GENERATIONS = 3;
const CREDIT_PACK = { credits: 10, amountKobo: 20000, label: "10 extra generations — ₦200" }; // amountKobo is in kobo (₦200 = 20000 kobo)

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
// (free daily allowance first, then paid credits). Returns { allowed, remainingFree, credits, usedType }.
async function consumeGeneration(uid) {
  const { ref, data } = await getUsage(uid);

  if (data.freeUsedToday < FREE_DAILY_GENERATIONS) {
    const updated = { ...data, freeUsedToday: data.freeUsedToday + 1 };
    await ref.set(updated, { merge: true });
    return { allowed: true, remainingFree: FREE_DAILY_GENERATIONS - updated.freeUsedToday, credits: updated.credits, usedType: "free" };
  }

  if (data.credits > 0) {
    const updated = { ...data, credits: data.credits - 1 };
    await ref.set(updated, { merge: true });
    return { allowed: true, remainingFree: 0, credits: updated.credits, usedType: "credit" };
  }

  await ref.set(data, { merge: true }); // persist reset even if we're not consuming
  return { allowed: false, remainingFree: 0, credits: data.credits, usedType: null };
}

// Gives back a unit that was consumed by consumeGeneration() when the actual
// generation afterward failed (e.g. Gemini quota/rate-limit errors) — a user
// should never lose a free generation or a paid credit for a request that
// produced nothing.
async function refundGeneration(uid, usedType) {
  if (!usedType) return;
  try {
    const ref = firestore.collection("usage").doc(uid);
    const snap = await ref.get();
    if (!snap.exists) return;
    const data = snap.data();
    if (usedType === "free") {
      await ref.set({ ...data, freeUsedToday: Math.max(0, (data.freeUsedToday || 0) - 1) }, { merge: true });
    } else if (usedType === "credit") {
      await ref.set({ ...data, credits: (data.credits || 0) + 1 }, { merge: true });
    }
  } catch (err) {
    console.error("Failed to refund a generation unit for", uid, err);
  }
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

// Initialize the Gemini client (new @google/genai SDK)
const ai = new GoogleGenAI({ apiKey: GEMINI_API_KEY });

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
Never use LaTeX or math markup (no $, $$, \(, \[, or similar delimiters). Write all math using real, readable symbols the way a textbook or exam paper would print it, not programming-style notation:
- Exponents: use actual superscript characters, e.g. "x² + 3x - 4 = 0", "2ⁿ", "x³" — never a caret like "x^2".
- Roots: use the actual √ symbol, e.g. "√16" — never the word "sqrt".
- Simple fractions and derivatives: a plain slash is fine, e.g. "dy/dx", "5/8".
- Multiplication: use × or juxtaposition, not *.
- Subscripts: always use actual subscript characters, e.g. C₆H₁₂O₆, aₙ, x₁, and x₂. Never use hyphens (-) or underscores (_) for subscripts.
Never use LaTeX commands, dollar-sign wrappers, or caret/asterisk notation for anything a real math symbol exists for.`;

// Gemini tends to put the correct option in the same slot (usually index 0)
// almost every time, regardless of prompting. Rather than rely on the model,
// shuffle each question's options ourselves and remap "correct" to match, so
// the right answer lands in a random position every generation.
function shuffleQuestionOptions(questions) {
  if (!Array.isArray(questions)) return questions;
  return questions.map((q) => {
    if (!q || !Array.isArray(q.options) || q.options.length < 2) return q;
    const correctIdx = typeof q.correct === "number" ? q.correct : parseInt(q.correct, 10);
    const correctValue = q.options[correctIdx];

    const indices = q.options.map((_, i) => i);
    for (let i = indices.length - 1; i > 0; i--) {
      const j = Math.floor(Math.random() * (i + 1));
      [indices[i], indices[j]] = [indices[j], indices[i]];
    }
    const shuffledOptions = indices.map((i) => q.options[i]);
    const newCorrect = shuffledOptions.indexOf(correctValue);

    return {
      ...q,
      options: shuffledOptions,
      correct: newCorrect !== -1 ? newCorrect : correctIdx,
    };
  });
}

// ── 1. Generate Quiz from Topic ──
app.post("/api/generate-quiz", requireAuth, async (req, res) => {
  try {
    if (!GEMINI_API_KEY) {
      return res.status(500).json({ error: "Server is missing GEMINI_API_KEY in .env file." });
    }

    const { topic, count = 8 } = req.body || {};
    if (!topic || typeof topic !== "string" || !topic.trim()) {
      return res.status(400).json({ error: "A 'topic' string is required." });
    }

    const usage = await consumeGeneration(req.uid);
    if (!usage.allowed) {
      return res.status(402).json({
        error: "You've used today's free generations. Buy more to keep going.",
        code: "OUT_OF_GENERATIONS",
      });
    }

    const numQuestions = Math.min(Math.max(parseInt(count, 10) || 8, 1), 25);

    try {
      const userPrompt = `Generate ${numQuestions} quiz questions about: ${topic.trim()}`;
      const response = await ai.models.generateContent({
        model: "gemini-3.6-flash",
        contents: userPrompt,
        config: {
          systemInstruction: QUESTION_SYSTEM_PROMPT,
          responseMimeType: "application/json",
        },
      });
      const questions = shuffleQuestionOptions(JSON.parse(response.text));

      res.json({ questions, remainingFree: usage.remainingFree, credits: usage.credits });
    } catch (genErr) {
      // The unit was already consumed above — give it back since nothing was generated.
      await refundGeneration(req.uid, usage.usedType);
      throw genErr;
    }
  } catch (err) {
    console.error("Gemini Topic API Error:", err);
    const isQuotaError = /429|quota|rate.?limit/i.test(err.message || "");
    res.status(isQuotaError ? 503 : 500).json({
      error: isQuotaError
        ? "We're experiencing high demand right now — your generation wasn't used, please try again in a minute."
        : "Failed to generate quiz. Check server logs.",
    });
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

    const usage = await consumeGeneration(req.uid);
    if (!usage.allowed) {
      return res.status(402).json({
        error: "You've used today's free generations. Buy more to keep going.",
        code: "OUT_OF_GENERATIONS",
      });
    }

    const count = req.body?.count;
    const numQuestions = Math.min(Math.max(parseInt(count, 10) || 10, 1), 25);

    const instruction = `This document is course material. Read it and generate ${numQuestions} quiz questions
that test understanding of the curriculum covered in the document — concepts, definitions, facts,
and reasoning it contains. Base every question strictly on content actually present in the document.

If the document contains worked numerical examples, solved problems, or formulas applied to
specific values (e.g. "Example 1", "Example 2" style calculations), you MUST include a good
proportion of "mcq" questions that are themselves numerical problems: give a scenario with
concrete numbers (reusing the values from the document's examples, or plausible new values that
use the same formula/method), and require the student to compute a numeric answer. All four
options must be numeric values in the correct unit, including plausible distractors (e.g. results
from a common mistake such as forgetting to convert units, using the wrong formula variable, or a
sign/rounding error) — do not skip past these numerical/calculation questions in favor of only
definitions and concepts.`;

    let contents = [];

    if (isPdf) {
      // Send PDF buffer directly as base64 inlineData
      contents.push({ text: instruction });
      contents.push({
        inlineData: {
          mimeType: "application/pdf",
          data: req.file.buffer.toString("base64"),
        },
      });
    } else {
      const fileText = req.file.buffer.toString("utf-8").slice(0, 100000);
      contents.push({ text: `${instruction}\n\nDOCUMENT CONTENT:\n"""\n${fileText}\n"""` });
    }

    try {
      const response = await ai.models.generateContent({
        model: "gemini-3.6-flash",
        contents,
        config: {
          systemInstruction: QUESTION_SYSTEM_PROMPT,
          responseMimeType: "application/json",
        },
      });
      const questions = shuffleQuestionOptions(JSON.parse(response.text));

      res.json({ questions, filename: req.file.originalname, remainingFree: usage.remainingFree, credits: usage.credits });
    } catch (genErr) {
      // The unit was already consumed above — give it back since nothing was generated.
      await refundGeneration(req.uid, usage.usedType);
      throw genErr;
    }
  } catch (err) {
    console.error("Gemini File API Error:", err);
    if (err.code === "LIMIT_FILE_SIZE") {
      return res.status(400).json({ error: "File is too large (20MB max)." });
    }
    const isQuotaError = /429|quota|rate.?limit/i.test(err.message || "");
    res.status(isQuotaError ? 503 : 500).json({
      error: isQuotaError
        ? "We're experiencing high demand right now — your generation wasn't used, please try again in a minute."
        : "Failed to process document and generate quiz.",
    });
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

// ── 6. Share a quiz — persists an AI-generated quiz so a link can load the exact same questions ──
app.post("/api/share-quiz", requireAuth, async (req, res) => {
  try {
    if (!firestore) return res.status(500).json({ error: "Sharing isn't set up yet." });
    const { name, questions } = req.body || {};
    if (!name || !Array.isArray(questions) || !questions.length) {
      return res.status(400).json({ error: "A quiz name and questions are required." });
    }
    const shareId = Math.random().toString(36).slice(2, 10);
    await firestore.collection("sharedQuizzes").doc(shareId).set({
      name,
      questions,
      createdBy: req.uid,
      createdAt: new Date().toISOString(),
    });
    res.json({ shareId });
  } catch (err) {
    console.error("Share quiz error:", err);
    res.status(500).json({ error: "Couldn't create a shareable link. Try again." });
  }
});

// ── 7. Fetch a shared quiz by ID — public, no sign-in required, so anyone with the link can take it ──
app.get("/api/shared-quiz/:id", async (req, res) => {
  try {
    if (!firestore) return res.status(500).json({ error: "Sharing isn't set up yet." });
    const snap = await firestore.collection("sharedQuizzes").doc(req.params.id).get();
    if (!snap.exists) {
      return res.status(404).json({ error: "This shared quiz link is invalid or has expired." });
    }
    const data = snap.data();
    res.json({ name: data.name, questions: data.questions });
  } catch (err) {
    console.error("Fetch shared quiz error:", err);
    res.status(500).json({ error: "Couldn't load this quiz." });
  }
});

// ── 8. Save a completed quiz so it can be revisited later ("Quizzes You've Done") ──
// ── Leaderboard: ISO week helper — each week is its own Firestore subcollection,
// so "resetting" is automatic (a new week just starts with an empty collection). ──
// ── Leaderboard: anonymous, deterministic pseudonym per user — never their
// real name or email, but always the same for them so they recognize their
// own row week to week. ──
const LB_ADJECTIVES = ["Clever","Swift","Bright","Quiet","Bold","Sharp","Calm","Eager","Wise","Brave","Nimble","Keen","Steady","Curious","Focused","Sunny","Lucky","Mighty","Gentle","Rapid"];
const LB_NOUNS = ["Falcon","Panda","Tiger","Eagle","Otter","Wolf","Fox","Owl","Lion","Hawk","Bear","Dolphin","Cheetah","Raven","Lynx","Puma","Heron","Badger","Sparrow","Orca"];

function anonymousName(uid) {
  let hash = 0;
  for (let i = 0; i < uid.length; i++) {
    hash = (hash * 31 + uid.charCodeAt(i)) >>> 0;
  }
  const adj = LB_ADJECTIVES[hash % LB_ADJECTIVES.length];
  const noun = LB_NOUNS[(hash >> 8) % LB_NOUNS.length];
  const num = (hash % 90) + 10; // 10–99
  return `${adj} ${noun} ${num}`;
}

// Returns the name to show on the leaderboard for this user — their own
// chosen nickname if they've set one, otherwise the anonymous generated one.
async function getDisplayName(uid) {
  try {
    const snap = await firestore.collection("usage").doc(uid).get();
    const custom = snap.exists ? (snap.data().leaderboardName || "").trim() : "";
    return custom || anonymousName(uid);
  } catch (e) {
    return anonymousName(uid);
  }
}

// Keeps a valid nickname reasonably clean: letters, numbers, spaces, a few
// basic punctuation marks, 2–20 characters.
function sanitizeLeaderboardName(raw) {
  const trimmed = (raw || "").trim().slice(0, 20);
  const cleaned = trimmed.replace(/[^a-zA-Z0-9 _.'-]/g, "");
  return cleaned.trim();
}

function getWeekId(date = new Date()) {
  const d = new Date(Date.UTC(date.getFullYear(), date.getMonth(), date.getDate()));
  const dayNum = d.getUTCDay() || 7;
  d.setUTCDate(d.getUTCDate() + 4 - dayNum);
  const yearStart = new Date(Date.UTC(d.getUTCFullYear(), 0, 1));
  const weekNo = Math.ceil((((d - yearStart) / 86400000) + 1) / 7);
  return `${d.getUTCFullYear()}-W${String(weekNo).padStart(2, "0")}`;
}

app.post("/api/completed-quiz", requireAuth, async (req, res) => {
  try {
    if (!firestore) return res.status(500).json({ error: "This feature isn't set up yet." });
    const { name, questions, score, total, pct } = req.body || {};
    if (!name || !Array.isArray(questions) || !questions.length) {
      return res.status(400).json({ error: "A quiz name and questions are required." });
    }
    await firestore.collection("completedQuizzes").doc(req.uid).collection("items").add({
      name,
      questions,
      score: score ?? null,
      total: total ?? questions.length,
      pct: pct ?? null,
      completedAt: new Date().toISOString(),
    });

    // Award 3 points per correctly answered question toward this week's leaderboard.
    const POINTS_PER_CORRECT = 3;
    if (typeof score === "number" && score > 0) {
      const weekId = getWeekId();
      const displayName = await getDisplayName(req.uid);
      const boardRef = firestore.collection("leaderboard").doc(weekId).collection("scores").doc(req.uid);
      await firestore.runTransaction(async (tx) => {
        const snap = await tx.get(boardRef);
        const current = snap.exists ? snap.data().points || 0 : 0;
        tx.set(boardRef, { displayName, points: current + (score * POINTS_PER_CORRECT), updatedAt: new Date().toISOString() }, { merge: true });
      });
    }

    res.json({ saved: true });
  } catch (err) {
    console.error("Save completed quiz error:", err);
    res.status(500).json({ error: "Couldn't save this quiz. Try again." });
  }
});

// ── Leaderboard: top scorers for the current week, plus the signed-in user's own rank ──
// ── Read/set a custom leaderboard nickname (optional — falls back to the
// anonymous generated one if never set or cleared). ──
app.get("/api/leaderboard-name", requireAuth, async (req, res) => {
  try {
    if (!firestore) return res.status(500).json({ error: "This feature isn't set up yet." });
    const snap = await firestore.collection("usage").doc(req.uid).get();
    const custom = snap.exists ? (snap.data().leaderboardName || "") : "";
    res.json({ customName: custom, generatedName: anonymousName(req.uid) });
  } catch (err) {
    console.error("Get leaderboard name error:", err);
    res.status(500).json({ error: "Couldn't load your nickname." });
  }
});

app.post("/api/leaderboard-name", requireAuth, async (req, res) => {
  try {
    if (!firestore) return res.status(500).json({ error: "This feature isn't set up yet." });
    const clean = sanitizeLeaderboardName((req.body || {}).name);
    if (clean && clean.length < 2) {
      return res.status(400).json({ error: "Nickname must be at least 2 characters." });
    }

    const usageRef = firestore.collection("usage").doc(req.uid);
    await usageRef.set({ leaderboardName: clean }, { merge: true });

    // Update this week's leaderboard entry immediately, if one already exists,
    // so the change is reflected right away instead of waiting for the next quiz.
    const weekId = getWeekId();
    const boardRef = firestore.collection("leaderboard").doc(weekId).collection("scores").doc(req.uid);
    const boardSnap = await boardRef.get();
    if (boardSnap.exists) {
      await boardRef.set({ displayName: clean || anonymousName(req.uid) }, { merge: true });
    }

    res.json({ displayName: clean || anonymousName(req.uid) });
  } catch (err) {
    console.error("Set leaderboard name error:", err);
    res.status(500).json({ error: "Couldn't save your nickname. Try again." });
  }
});

app.get("/api/leaderboard", requireAuth, async (req, res) => {
  try {
    if (!firestore) return res.status(500).json({ error: "This feature isn't set up yet." });
    const weekId = getWeekId();
    const snap = await firestore
      .collection("leaderboard")
      .doc(weekId)
      .collection("scores")
      .orderBy("points", "desc")
      .limit(20)
      .get();

    const top = snap.docs.map((doc, i) => ({ rank: i + 1, uid: doc.id, ...doc.data() }));

    let me = top.find((r) => r.uid === req.uid) || null;
    if (!me) {
      const mySnap = await firestore.collection("leaderboard").doc(weekId).collection("scores").doc(req.uid).get();
      if (mySnap.exists) {
        // Not in the top 20 — figure out actual rank by counting how many people score higher.
        const higherSnap = await firestore
          .collection("leaderboard")
          .doc(weekId)
          .collection("scores")
          .where("points", ">", mySnap.data().points)
          .get();
        me = { rank: higherSnap.size + 1, uid: req.uid, ...mySnap.data() };
      }
    }

    res.json({ weekId, top, me });
  } catch (err) {
    console.error("Leaderboard fetch error:", err);
    res.status(500).json({ error: "Couldn't load the leaderboard right now." });
  }
});

// ── 9. Fetch a signed-in user's completed quizzes, most recent first ──
app.get("/api/completed-quizzes", requireAuth, async (req, res) => {
  try {
    if (!firestore) return res.status(500).json({ error: "This feature isn't set up yet." });
    const snap = await firestore
      .collection("completedQuizzes")
      .doc(req.uid)
      .collection("items")
      .orderBy("completedAt", "desc")
      .limit(50)
      .get();
    const items = snap.docs.map((doc) => ({ id: doc.id, ...doc.data() }));
    res.json({ items });
  } catch (err) {
    console.error("Fetch completed quizzes error:", err);
    res.status(500).json({ error: "Couldn't load your completed quizzes." });
  }
});

// ── 10. Delete a saved completed quiz ──
app.delete("/api/completed-quiz/:id", requireAuth, async (req, res) => {
  try {
    if (!firestore) return res.status(500).json({ error: "This feature isn't set up yet." });
    await firestore
      .collection("completedQuizzes")
      .doc(req.uid)
      .collection("items")
      .doc(req.params.id)
      .delete();
    res.json({ deleted: true });
  } catch (err) {
    console.error("Delete completed quiz error:", err);
    res.status(500).json({ error: "Couldn't remove this quiz. Try again." });
  }
});

app.listen(PORT, () => {
  console.log(`Omega Prep server running on port ${PORT}`);
});
        
  
