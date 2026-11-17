// Pure logic: no DOM, no network. Tested in test/lib.test.mjs
export const uid = () => Math.random().toString(36).slice(2, 10) + Date.now().toString(36).slice(-4);
export const BLOCK = 25, BREAK = 5;

export const pad = (n) => String(n).padStart(2, "0");
export const dstr = (d) => `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}`;
export const parseD = (s) => { const [y, m, d] = s.split("-").map(Number); return new Date(y, m - 1, d); };
export const addDays = (d, n) => { const x = new Date(d); x.setDate(x.getDate() + n); return x; };
export const toMin = (t) => { const [h, m] = t.split(":").map(Number); return h * 60 + m; };
export const fromMin = (m) => `${pad(Math.floor(m / 60))}:${pad(m % 60)}`;

// ---------- text -> sections ----------
const isHeading = (l) => {
  const t = l.trim();
  if (t.length < 4 || t.length > 80) return false;
  if (/[.,;:]$/.test(t)) return false;
  if (!/^[A-Z0-9]/.test(t)) return false;
  const words = t.split(/\s+/);
  if (words.length > 10) return false;
  return /^(chapter|unit|section|topic|lesson|part)\b/i.test(t) || /^\d+(\.\d+)*[ .)]\s*\S/.test(t) || t === t.toUpperCase() || words.filter((w) => /^[A-Z]/.test(w)).length >= Math.ceil(words.length * 0.7);
};

export function splitSections(pageTexts, maxChars = 3500) {
  const out = [];
  let cur = null;
  const push = () => { if (cur && cur.text.trim().length > 80) out.push(cur); cur = null; };
  pageTexts.forEach((pt, i) => {
    const lines = pt.split("\n").map((l) => l.trim()).filter(Boolean);
    for (const line of lines) {
      if (isHeading(line) && (!cur || cur.text.length > 200 || cur.text.length === 0)) {
        if (cur && cur.text.length === 0) { cur.title = line; continue; }
        push();
        cur = { id: uid(), title: line, text: "", page: i + 1 };
        continue;
      }
      if (!cur) cur = { id: uid(), title: `Pages ${i + 1}+`, text: "", page: i + 1 };
      cur.text += line + " ";
      if (cur.text.length > maxChars) { const t = cur.title.replace(/ \(cont\.\)$/, ""); push(); cur = { id: uid(), title: t + " (cont.)", text: "", page: i + 1 }; }
    }
  });
  push();
  if (!out.length) {
    const all = pageTexts.join(" ").trim();
    if (all.length > 40) out.push({ id: uid(), title: "Document", text: all.slice(0, maxChars * 3), page: 1 });
  }
  return out;
}

// ---------- cards and quizzes (no AI) ----------
export const sentences = (text) => text.replace(/\s+/g, " ").split(/(?<=[.!?])\s+(?=[A-Z0-9"(])/).map((s) => s.trim()).filter((s) => s.length > 30 && s.length < 320);
const shuffle = (arr, rnd = Math.random) => { const a = [...arr]; for (let i = a.length - 1; i > 0; i--) { const j = Math.floor(rnd() * (i + 1)); [a[i], a[j]] = [a[j], a[i]]; } return a; };
const STOP = new Set("the a an and or of to in on for with that this these those is are was were be been by as at from it its which who whom their there than then also can may will would should could into such not have has had more most other some any each".split(" "));
export const keywords = (s) => (s.match(/[A-Za-z][A-Za-z-]{3,}/g) || []).filter((w) => !STOP.has(w.toLowerCase()));

export function makeCards(section, subjectId, max = 12) {
  const cards = [];
  const defRe = /^(?:An?\s+|The\s+)?([A-Z][\w\s-]{2,50}?)\s+(is defined as|is called|refers to|means|is|are)\s+(.{15,260})$/;
  for (const s of sentences(section.text)) {
    if (cards.length >= max) break;
    const m = s.match(defRe);
    if (m && m[1].split(" ").length <= 6) {
      cards.push(newCard(subjectId, section, `What ${m[2] === "are" ? "are" : "is"} ${m[1].trim()}?`, s, "def"));
      continue;
    }
    const kws = keywords(s).sort((a, b) => b.length - a.length);
    const nums = s.match(/\b\d[\d,.]*\b/);
    const target = nums && nums[0].length > 1 ? nums[0] : kws[0];
    if (target && s.length > 45) {
      cards.push(newCard(subjectId, section, s.replace(target, "_____"), target, "cloze", s));
    }
  }
  return cards;
}
function newCard(subjectId, section, q, a, kind, ctx) {
  const src = section.docId || section.docName ? { docId: section.docId || null, docName: section.docName || null, sectionId: section.id, title: section.title, page: section.page || null } : { docId: null, docName: null, sectionId: section.id, title: section.title, page: section.page || null };
  return { id: uid(), subjectId, topicId: section.id, topic: section.title, q, a, kind, ctx: ctx || a, src, ease: 2.5, interval: 0, due: 0, reps: 0, lapses: 0, created: Date.now(), edited: false, deleted: false };
}

export function makeCloze(sentence) {
  const clean = sentence.replace(/\s+/g, " ").trim();
  const kws = keywords(clean).sort((a, b) => b.length - a.length);
  const nums = clean.match(/\b\d[\d,.]*\b/);
  const target = nums && nums[0].length > 1 ? nums[0] : kws[0];
  if (!target || clean.length <= 45) return null;
  return { q: clean.replace(target, "_____"), a: target, sentence: clean };
}

export function makeClozeCards(section, subjectId, max = 12) {
  const out = [];
  for (const s of sentences(section.text)) {
    if (out.length >= max) break;
    const cz = makeCloze(s);
    if (cz) out.push(newCard(subjectId, section, cz.q, cz.a, "cloze", cz.sentence));
  }
  return out;
}

export function makeQuizFromNotes(sections, n = 10, rnd = Math.random) {
  const items = [];
  for (const sec of sections) {
    for (const s of sentences(sec.text)) {
      const cz = makeCloze(s);
      if (cz) items.push({ ...cz, sec });
    }
  }
  const pool = shuffle(items, rnd).slice(0, n);
  const answers = [...new Set(items.map((x) => x.a))];
  const qs = [];
  for (const it of pool) {
    const wrong = shuffle(answers.filter((x) => x !== it.a), rnd).slice(0, 3);
    if (wrong.length < 2) continue;
    const opts = shuffle([it.a, ...wrong], rnd);
    qs.push({ id: uid(), topicId: it.sec.id, topic: it.sec.title, subjectId: it.sec.subjectId || null, q: it.q, options: opts, answer: opts.indexOf(it.a), explain: `From your notes (${it.sec.title}): ${it.sentence}` });
  }
  return qs;
}

export function editCard(card, { q, a } = {}) {
  const c = { ...card, edited: true };
  if (typeof q === "string" && q.trim()) c.q = q.trim();
  if (typeof a === "string" && a.trim()) c.a = a.trim();
  if (c.kind === "cloze" && typeof q === "string" && q.trim()) c.ctx = q.trim();
  return c;
}

export function deleteCard(card) { return { ...card, deleted: true }; }

export function dueQueue(cards, now = Date.now()) {
  return cards.filter((c) => !c.deleted && c.due <= now).sort((x, y) => x.due - y.due || y.lapses - x.lapses || x.id.localeCompare(y.id));
}

export function queueStats(cards, now = Date.now()) {
  const live = cards.filter((c) => !c.deleted);
  const due = live.filter((c) => c.due <= now);
  return { total: live.length, due: due.length, overdue: due.filter((c) => c.due < now - 86400000).length, newCards: live.filter((c) => c.reps === 0 && c.due <= now).length, learning: live.filter((c) => c.reps > 0 && c.due <= now).length, future: live.length - due.length };
}

export function gradeCard(card, quality, now = Date.now()) {
  // quality: 0 again, 3 hard, 4 good, 5 easy
  const c = { ...card };
  if (quality < 3) { c.lapses++; c.reps = 0; c.interval = 0; c.due = now + 10 * 60 * 1000; }
  else {
    c.reps++;
    c.interval = c.reps === 1 ? 1 : c.reps === 2 ? 3 : Math.round(c.interval * c.ease);
    c.due = now + c.interval * 86400000;
  }
  c.ease = Math.max(1.3, c.ease + 0.1 - (5 - quality) * (0.08 + (5 - quality) * 0.02));
  return c;
}
export const dueCards = (cards, now = Date.now()) => dueQueue(cards, now);

export function sourceLabel(card) {
  const s = card && (card.src || {});
  const bits = [s.docName, s.title, s.page ? `p.${s.page}` : null].filter(Boolean);
  return bits.length ? `From: ${bits.join(" · ")}` : card && card.topic ? `From: ${card.topic}` : "From: your notes";
}

export function makeQuiz(cards, n = 10, rnd = Math.random) {
  const cloze = cards.filter((c) => c.kind === "cloze");
  const defs = cards.filter((c) => c.kind === "def");
  const pool = shuffle(cards.filter((c) => c.kind === "cloze" || c.kind === "def"), rnd).slice(0, n);
  const answers = [...new Set(cloze.map((c) => c.a))];
  const defAnswers = [...new Set(defs.map((c) => c.a))];
  const qs = [];
  for (const c of pool) {
    const same = c.kind === "cloze" ? answers : defAnswers;
    const wrong = shuffle(same.filter((x) => x !== c.a), rnd).slice(0, 3);
    if (wrong.length < 2) continue;
    const opts = shuffle([c.a, ...wrong], rnd);
    qs.push({ id: c.id, topicId: c.topicId, topic: c.topic, subjectId: c.subjectId, q: c.q, options: opts, answer: opts.indexOf(c.a), explain: `${c.kind === "cloze" ? "From your notes: " : "Your notes say: "}${c.ctx}` });
  }
  return qs;
}

// ---------- topic stats ----------
export function topicStats(attempts, cards) {
  const m = new Map();
  const get = (id, name, subjectId) => { if (!m.has(id)) m.set(id, { topicId: id, topic: name, subjectId, right: 0, wrong: 0 }); return m.get(id); };
  for (const a of attempts) { const t = get(a.topicId, a.topic, a.subjectId); a.correct ? t.right++ : t.wrong++; }
  for (const c of cards) if (c.lapses) get(c.topicId, c.topic, c.subjectId).wrong += c.lapses;
  return [...m.values()].map((t) => ({ ...t, n: t.right + t.wrong, acc: t.right / Math.max(1, t.right + t.wrong) }))
    .filter((t) => t.n >= 2).sort((a, b) => a.acc - b.acc || b.n - a.n);
}

// ---------- plan ----------
export function freeSegments(dayDate, winStart, winEnd, busy, nowMin = 0) {
  const dow = dayDate.getDay();
  let segs = [[Math.max(toMin(winStart), nowMin), toMin(winEnd)]];
  for (const b of busy) {
    if (!b.days.includes(dow)) continue;
    const bs = toMin(b.start), be = toMin(b.end);
    segs = segs.flatMap(([s, e]) => (be <= s || bs >= e ? [[s, e]] : [[s, Math.min(e, bs)], [Math.max(s, be), e]])).filter(([s, e]) => e - s > 0);
  }
  return segs.filter(([s, e]) => e - s >= BLOCK);
}

export function daySlots(dayDate, st, nowMin = 0) {
  const segs = freeSegments(dayDate, st.winStart, st.winEnd, st.busy, nowMin);
  const slots = [];
  for (const [s, e] of segs) for (let t = s; t + BLOCK <= e; t += BLOCK + BREAK) slots.push([t, t + BLOCK]);
  return slots.slice(0, Math.max(1, Math.floor(st.dailyMinutes / BLOCK)));
}

export function buildPlan(st, sectionsBySubject, now = new Date(), prevDone = {}) {
  const today = parseD(dstr(now));
  const nowMin = now.getHours() * 60 + now.getMinutes() + 5;
  const subs = st.subjects.filter((s) => s.testDate && parseD(s.testDate) >= today);
  const ptr = Object.fromEntries(subs.map((s) => [s.id, 0]));
  const warnings = [];
  const days = [];
  const last = subs.length ? new Date(Math.max(...subs.map((s) => parseD(s.testDate)))) : today;
  const weak = st.weak || {};
  for (let d = new Date(today); d <= last; d = addDays(d, 1)) {
    const key = dstr(d);
    const slots = daySlots(d, st, key === dstr(now) ? nowMin : 0);
    const active = subs.filter((s) => parseD(s.testDate) >= d);
    const blocks = [];
    if (!slots.length || !active.length) { days.push({ date: key, blocks, free: slots.length }); continue; }
    const w = active.map((s) => {
      const left = Math.max(1, Math.round((parseD(s.testDate) - d) / 86400000) + 1);
      const secs = (sectionsBySubject[s.id] || []).length;
      return { s, left, weight: 1 / left + (secs - ptr[s.id]) / (left * 6) + 0.05 };
    });
    const tot = w.reduce((a, x) => a + x.weight, 0);
    const alloc = w.map((x) => Math.max(1, Math.round((x.weight / tot) * slots.length)));
    while (alloc.reduce((a, b) => a + b, 0) > slots.length) { const i = alloc.indexOf(Math.max(...alloc)); if (alloc[i] <= 1) break; alloc[i]--; }
    let si = 0;
    w.forEach((x, wi) => {
      const secs = sectionsBySubject[x.s.id] || [];
      for (let k = 0; k < alloc[wi] && si < slots.length; k++, si++) {
        const [a, b] = slots[si];
        let type, sec = null, label;
        const learned = secs.slice(0, ptr[x.s.id]);
        if (x.left === 1) { type = "test"; label = "Practice test, then fix mistakes"; }
        else if (x.left === 2 && k === 0) { type = "review"; label = "Review weak topics and cards"; }
        else if (ptr[x.s.id] < secs.length && x.left > 2 && k % 3 === 0) { sec = secs[ptr[x.s.id]++]; type = "learn"; label = `Learn: ${sec.title}`; }
        else if (learned.length && k % 3 === 1) { type = "practice"; sec = learned[learned.length - 1]; label = `Quiz: ${sec.title}`; }
        else if (learned.length) {
          const wk = learned.find((s) => weak[s.id]) || learned[Math.floor((d.getDate() + k) % learned.length)];
          type = "review"; sec = wk; label = `Review: ${wk.title}`;
        } else if (secs.length && ptr[x.s.id] < secs.length) { sec = secs[ptr[x.s.id]++]; type = "learn"; label = `Learn: ${sec.title}`; }
        else { type = "setup"; label = "Add a PDF for this subject"; }
        const id = `${key}|${x.s.id}|${k}`;
        blocks.push({ id, date: key, start: fromMin(a), end: fromMin(b), subjectId: x.s.id, subject: x.s.name, type, label, topicId: sec ? sec.id : null, part: a < 12 * 60 ? "Morning" : a < 17 * 60 ? "Afternoon" : "Evening", done: !!prevDone[id] });
      }
    });
    blocks.sort((p, q) => p.start.localeCompare(q.start));
    days.push({ date: key, blocks, free: slots.length });
  }
  for (const s of subs) {
    const secs = (sectionsBySubject[s.id] || []).length;
    if (secs && ptr[s.id] < secs) warnings.push(`${s.name}: only ${ptr[s.id]} of ${secs} sections fit before ${s.testDate}. Add daily minutes or free time.`);
    if (!secs) warnings.push(`${s.name}: no PDF yet, plan has placeholders.`);
  }
  return { days, warnings, builtAt: now.toISOString() };
}

// ---------- reschedule missed blocks (adaptive planner) ----------
export function overlappedByBusy(startMin, endMin, dayDate, st) {
  const dow = dayDate.getDay();
  return (st.busy || []).some((b) => b.days.includes(dow) && toMin(b.start) < endMin && toMin(b.end) > startMin);
}
export function rescheduleMissed(plannedBlocks, doneMap, st, now = new Date()) {
  const today = dstr(now);
  const missed = [];
  for (const d of plannedBlocks) if (d.date < today) for (const b of d.blocks) if (!doneMap[b.id]) missed.push(b);
  const taken = new Set();
  const placed = [];
  for (const b of missed) {
    let done = false;
    for (let off = 1; off <= 14 && !done; off++) {
      const date = addDays(now, off);
      const key = dstr(date);
      const sub = st.subjects.find((s) => s.id === b.subjectId);
      if (sub && sub.testDate && key > sub.testDate) break;
      for (const [s, e] of daySlots(date, st, 0)) {
        const slot = `${key}|${s}`;
        if (taken.has(slot)) continue;
        if (overlappedByBusy(s, e, date, st)) continue;
        taken.add(slot);
        placed.push({ ...b, id: `${b.id}~${key}`, date: key, start: fromMin(s), end: fromMin(e), carried: true, label: `${b.label} (carried over)` });
        done = true; break;
      }
    }
    if (!done) placed.push({ ...b, id: `${b.id}~unscheduled`, date: null, unscheduled: true, label: `${b.label} (could not fit: no free window before its test date)` });
  }
  return placed;
}

// ---------- doc search / guide ----------
export function docSearch(query, sections, perSection = 4) {
  const q = query.trim().toLowerCase();
  if (!q) return [];
  return sections
    .map((sec) => {
      const text = sec.text;
      const lower = text.toLowerCase();
      const hits = [];
      let from = 0;
      while (hits.length < perSection) {
        const at = lower.indexOf(q, from);
        if (at < 0) break;
        const start = Math.max(0, at - 80);
        const end = Math.min(text.length, at + q.length + 120);
        hits.push({ start, end, snippet: text.slice(start, end), matchAt: at - start, matchLen: q.length });
        from = at + q.length;
      }
      return hits.length ? { section: sec, hits } : null;
    })
    .filter(Boolean);
}
export const highlightText = (t, q) => esc(t).replace(new RegExp(q.replace(/[.*+?^${}()|[\]\\]/g, "\\$&"), "gi"), (m) => `<mark>${m}</mark>`);
export function searchSections(query, sections, k = 3) {
  const qk = new Set(keywords(query).map((w) => w.toLowerCase()));
  if (!qk.size) return [];
  const scored = [];
  for (const sec of sections) for (const s of sentences(sec.text)) {
    const hit = keywords(s).filter((w) => qk.has(w.toLowerCase())).length;
    if (hit) scored.push({ score: hit, sentence: s, title: sec.title });
  }
  return scored.sort((a, b) => b.score - a.score).slice(0, k * 2);
}

// ---------- export / import ----------
export const BACKUP_VERSION = 2;
export function validateImport(obj) {
  if (!obj || typeof obj !== "object" || obj.app !== "study-deck") throw new Error("Not a Study Deck backup file");
  if (!obj.state || typeof obj.state !== "object") throw new Error("Backup is missing settings");
  if (!Array.isArray(obj.docs)) throw new Error("Backup is missing documents");
  if (!Array.isArray(obj.state.subjects)) throw new Error("Backup is missing subjects");
  const cards = obj.cards || [];
  if (!Array.isArray(cards)) throw new Error("Backup cards are invalid");
  if (!cards.every((c) => c && typeof c.q === "string" && typeof c.a === "string")) throw new Error("A card in this backup is missing its question or answer");
  if (obj.version && obj.version > BACKUP_VERSION) throw new Error("This backup is from a newer app version. Update the app first.");
  if (obj.version >= 2 && !Array.isArray(obj.pdfs)) throw new Error("Backup has no PDF shelf");
  return obj;
}
export function backupStatus({ lastExportAt, lastImportAt, docsWithPdf, docsTotal, pending }) {
  if (pending) return { tone: "warn", text: "Backup in progress, hold on a moment." };
  if (!lastExportAt && !lastImportAt) return { tone: "warn", text: `Never backed up on this device yet. ${docsTotal} PDF(s) held locally, ${docsWithPdf} with original file kept.` };
  const when = Math.max(lastExportAt || 0, lastImportAt || 0);
  const days = Math.floor((Date.now() - when) / 86400000);
  const tone = days >= 7 ? "warn" : "ok";
  return { tone, text: `Last backup ${days === 0 ? "today" : days === 1 ? "yesterday" : `${days} days ago`} (${docsWithPdf}/${docsTotal} PDF originals included).` };
}
