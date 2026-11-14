# Study Deck: audit and spec (written before code)

Goal: personal, free, local-first, installable study planner PWA (one user, Nigeria). Gemini Notebook can't be embedded, so AI uses the Gemini API free tier via a server function. Everything else works with no key.

## Capability audit
- GitHub: gh CLI authed (repo, workflow scopes). Can create a NEW repo only. Existing repos untouched.
- Vercel: Composio connection active (personal scope). Can create project, deploy files, add env vars. Vercel CLI not logged in.
- Free only: Vercel Hobby, GitHub free, Gemini free tier.

## Scope
1. Setup: subjects + test dates, daily minutes, study window, busy activities.
2. PDFs: imported locally, text extracted in browser with vendored pdf.js, split into topic sections, stored in IndexedDB.
3. Plan: daily, around busy times, short blocks (25 min + 5 min break), Learn / Practice / Review sections, practice test on last day, tickable.
4. No-key tools: auto flashcards with spaced repetition, auto quiz and practice test with explanations quoting source, search-based explain.
5. Weak topics: accuracy per topic from quizzes and card lapses, feeds Review blocks.
6. AI (needs GEMINI_API_KEY server-side): better cards/quizzes, explanations, check written answer from photo or text. Marked pending without key.
7. PWA: manifest, icons, service worker, offline.
8. IndexedDB storage, JSON export/import.

## Security
Key only as Vercel env var GEMINI_API_KEY read in /api/ai. Never in client, repo, or chat. POST only, same-origin check, size cap, rate limit. Privacy note: free-tier Gemini content may be reviewed by Google.

## Limits
No offline OCR (photo check pending Gemini). Heuristic cards are weaker on slides. Image-only PDFs have no text until Gemini vision. Data lives on one device; use JSON export to back up.
