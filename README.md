# Uniquiz + AI-generated questions

## What changed
- `public/Uniquiz.html` — your original quiz app, plus two new blocks on the
  course picker screen:
  - **Generate a Quiz with AI** — type any topic, pick a question count.
  - **Upload Course Material** — upload a PDF or text file (lecture notes,
    syllabus, textbook chapter) and the AI writes questions based only on
    what's in that document.
- `server.js` — Express server with two endpoints:
  - `POST /api/generate-quiz` — topic-based generation.
  - `POST /api/generate-quiz-from-file` — sends the uploaded PDF directly to
    Claude (which reads PDFs natively — no separate text-extraction step
    needed) or the raw text for `.txt`/`.md` files, and returns questions
    grounded in that content.
  Your API key stays server-side in both cases.

## Setup
1. Install Node.js 18+ if you don't have it.
2. In this folder, run:
   ```
   npm install
   ```
3. Copy the env template and add your real key:
   ```
   cp .env.example .env
   ```
   Get a key at https://console.anthropic.com (Settings → API Keys).
4. Start the server:
   ```
   npm start
   ```
5. Open http://localhost:3000

## Deploying it for real
Any Node host works (Render, Railway, Fly.io, a VPS, etc.). Just set the
`ANTHROPIC_API_KEY` environment variable in that host's dashboard — don't
commit your `.env` file or put the key in the HTML/JS, since anything in the
browser is publicly visible.

## Notes
- AI-generated courses are labeled "AI" in the picker and live only in
  memory for that session — refreshing the page clears them. If you want
  generated quizzes to persist, they'd need to be saved to a database or
  `localStorage` after generation; happy to add that if useful.
- File upload currently supports PDF and plain text (`.txt`, `.md`). Word
  docs (`.docx`) aren't handled yet — I can add that with a text-extraction
  step (via `mammoth`) if you need it.
- Uploaded files are processed in memory and never written to disk or stored.
- Cost: each generation is one API call. File-based generation costs a bit
  more than topic-based since the whole document is sent as input.
