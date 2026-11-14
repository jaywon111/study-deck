// Vercel serverless function. GEMINI_API_KEY lives only in Vercel env vars.
const MODEL = process.env.GEMINI_MODEL || "gemini-2.5-flash";
const hits = new Map();
const PROMPTS = {
  cards: (t) => `From the study notes below, write up to 12 high-quality flashcards. Return ONLY JSON: [{"q":"...","a":"..."}].\n\nNOTES:\n${t}`,
  quiz: (t) => `From the study notes below, write 8 multiple-choice questions with 4 options each. Return ONLY JSON: [{"q":"...","options":["..","..","..",".."],"answer":0,"explain":"..."}].\n\nNOTES:\n${t}`,
  explain: (t, q) => `Explain simply and accurately for a student. Use the notes if relevant. Question: ${q}\n\nNOTES:\n${t}`,
  check: (t, q) => `A student wrote an answer (image or text) to this question: "${q}". Reference notes:\n${t}\n\nGive: a score out of 10, what is correct, what is missing or wrong, and a model answer. Be concise.`,
};
export default async function handler(req, res) {
  res.setHeader("Cache-Control", "no-store");
  if (req.method !== "POST") return res.status(405).json({ error: "POST only" });
  const origin = req.headers.origin;
  if (origin && new URL(origin).host !== req.headers.host) return res.status(403).json({ error: "bad origin" });
  const key = process.env.GEMINI_API_KEY;
  let body = req.body;
  if (typeof body === "string") { try { body = JSON.parse(body); } catch { body = {}; } }
  body = body || {};
  if (body.task === "status") return res.json({ ready: !!key, model: MODEL });
  if (!key) return res.status(503).json({ error: "no_key", message: "AI is not enabled yet. Add GEMINI_API_KEY in Vercel." });
  const ip = String(req.headers["x-forwarded-for"] || "x").split(",")[0];
  const now = Date.now(), arr = (hits.get(ip) || []).filter((t) => now - t < 60000);
  if (arr.length >= 8) return res.status(429).json({ error: "slow down, try again in a minute" });
  arr.push(now); hits.set(ip, arr);
  const { task, text = "", question = "", image, mime } = body;
  if (!PROMPTS[task]) return res.status(400).json({ error: "unknown task" });
  if (String(text).length > 30000 || String(question).length > 2000 || (image && image.length > 4_000_000)) return res.status(413).json({ error: "input too large" });
  const parts = [{ text: PROMPTS[task](String(text), String(question)) }];
  if (image && task === "check") parts.push({ inline_data: { mime_type: mime || "image/jpeg", data: image } });
  const wantJson = task === "cards" || task === "quiz";
  try {
    const r = await fetch(`https://generativelanguage.googleapis.com/v1beta/models/${MODEL}:generateContent`, {
      method: "POST",
      headers: { "Content-Type": "application/json", "x-goog-api-key": key },
      body: JSON.stringify({ contents: [{ parts }], generationConfig: wantJson ? { responseMimeType: "application/json" } : {} }),
    });
    const j = await r.json();
    if (!r.ok) return res.status(r.status === 429 ? 429 : 502).json({ error: r.status === 429 ? "Gemini free quota hit, try later" : "Gemini error " + r.status });
    const out = j.candidates?.[0]?.content?.parts?.map((p) => p.text).join("") || "";
    if (wantJson) { try { return res.json({ data: JSON.parse(out) }); } catch { return res.status(502).json({ error: "bad AI output" }); } }
    return res.json({ text: out });
  } catch (e) { return res.status(502).json({ error: "AI request failed" }); }
}
