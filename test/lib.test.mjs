import assert from "node:assert/strict";
import { splitSections, makeCards, makeQuiz, buildPlan, gradeCard, freeSegments, topicStats, validateImport, searchSections, dstr, addDays, makeClozeCards, makeQuizFromNotes, editCard, deleteCard, dueQueue, queueStats, rescheduleMissed, docSearch, backupStatus, BACKUP_VERSION, sourceLabel } from "../public/lib.js";

const text = [
  "Photosynthesis Basics\nPhotosynthesis is the process by which plants convert light energy into chemical energy stored in glucose. Chlorophyll is the green pigment that absorbs light mostly in the red and blue wavelengths. The light reactions take place in the thylakoid membranes of the chloroplast. The Calvin cycle uses 3 molecules of carbon dioxide to build sugars in the stroma.",
  "Cell Respiration\nRespiration is the process of releasing energy from glucose inside mitochondria of the cell. Glycolysis occurs in the cytoplasm and produces 2 molecules of pyruvate from each glucose. The Krebs cycle takes place in the mitochondrial matrix and generates carrier molecules. Oxygen is the final electron acceptor in the electron transport chain. Fermentation happens when oxygen is absent from the cell environment."
];
const secs = splitSections(text);
assert.ok(secs.length >= 2, "sections " + secs.length);
const cards = secs.flatMap((s) => makeCards(s, "bio"));
assert.ok(cards.length >= 5, "cards " + cards.length);
assert.ok(cards.some((c) => c.kind === "def"));
const quiz = makeQuiz(cards, 8);
assert.ok(quiz.length >= 3);
for (const q of quiz) { assert.ok(q.options[q.answer] !== undefined); assert.equal(new Set(q.options).size, q.options.length); }

const g = gradeCard(cards[0], 4); assert.equal(g.interval, 1);
const g2 = gradeCard(g, 0); assert.equal(g2.lapses, 1);

const segs = freeSegments(new Date(2026, 10, 16), "16:00", "21:00", [{ days: [1], start: "17:00", end: "18:00" }]);
assert.deepEqual(segs, [[960, 1020], [1080, 1260]]);

const now = new Date(2026, 10, 14, 8, 0);
const st = { subjects: [{ id: "bio", name: "Biology", testDate: dstr(addDays(now, 10)) }], dailyMinutes: 90, winStart: "16:00", winEnd: "21:00", busy: [{ days: [0, 1, 2, 3, 4, 5, 6], start: "18:00", end: "19:00" }] };
const plan = buildPlan(st, { bio: secs }, now);
assert.equal(plan.days.length, 11);
for (const d of plan.days) { assert.ok(d.blocks.length <= 3); for (const b of d.blocks) assert.ok(!(b.start < "19:00" && b.end > "18:00"), "overlaps busy " + b.start); }
assert.ok(plan.days[0].blocks.some((b) => b.type === "learn"));
assert.equal(plan.days.at(-1).blocks[0].type, "test");
const ids = plan.days.flatMap((d) => d.blocks.map((b) => b.id)); assert.equal(new Set(ids).size, ids.length);

const stats = topicStats([{ topicId: "a", topic: "A", correct: false }, { topicId: "a", topic: "A", correct: false }, { topicId: "b", topic: "B", correct: true }, { topicId: "b", topic: "B", correct: true }], []);
assert.equal(stats[0].topicId, "a");
assert.ok(searchSections("where does glycolysis occur", secs).length);
assert.throws(() => validateImport({}));
validateImport({ app: "study-deck", state: { subjects: [] }, docs: [] });
console.log("all tests passed");

// six-item upgrade coverage
const cloze = makeClozeCards(secs[0], "bio");
assert.ok(cloze.length >= 1, "cloze " + cloze.length);
assert.ok(cloze[0].q.includes("_____"));
const qn = makeQuizFromNotes(secs, 6);
assert.ok(qn.length >= 1, "notes quiz " + qn.length);
for (const q of qn) assert.ok(q.explain.includes("From your notes"));
const ed = editCard(cards[0], { q: "  New Q  ", a: "New A" });
assert.equal(ed.q, "New Q"); assert.equal(ed.a, "New A"); assert.equal(ed.edited, true);
assert.equal(deleteCard(ed).deleted, true);
const nowTs = Date.now();
const cOld = { id: "a", q: "q", a: "a", due: nowTs - 2 * 86400000, reps: 2, lapses: 0 };
const cNew = { id: "b", q: "q", a: "a", due: 0, reps: 0, lapses: 0 };
const cFuture = { id: "c", q: "q", a: "a", due: nowTs + 86400000, reps: 3, lapses: 0 };
assert.equal(dueQueue([cFuture, cNew, cOld]).length, 2);
assert.equal(queueStats([cOld, cNew, cFuture]).due, 2);
assert.equal(queueStats([cOld, cNew, cFuture]).overdue, 2, "both old and zero due count as overdue"); // due:0 is epoch, also overdue
const missed = rescheduleMissed([{ date: "2026-11-10", blocks: [{ id: "m1", date: "2026-11-10", start: "16:00", end: "16:25", subjectId: "bio", subject: "Biology", type: "learn", label: "Learn X" }] }], {}, { subjects: [{ id: "bio", name: "Biology", testDate: "2026-11-20" }], dailyMinutes: 90, winStart: "16:00", winEnd: "21:00", busy: [] }, new Date(2026, 10, 15, 8, 0));
assert.equal(missed.length, 1); assert.ok(missed[0].carried || missed[0].unscheduled); if (!missed[0].unscheduled) assert.ok(missed[0].date > "2026-11-15", "carried " + missed[0].date);
const hits = docSearch("glycolysis", secs);
assert.ok(hits.length >= 1 && hits[0].hits.length >= 1);
assert.ok(backupStatus({ lastExportAt: 0, lastImportAt: 0, docsWithPdf: 0, docsTotal: 2 }).text.includes("Never backed up"));
assert.ok(backupStatus({ lastExportAt: Date.now(), lastImportAt: 0, docsWithPdf: 1, docsTotal: 2 }).tone === "ok");
assert.equal(BACKUP_VERSION, 2);
assert.throws(() => validateImport({ app: "study-deck", state: { subjects: [] }, docs: [], version: 2 }));
assert.ok(sourceLabel({ src: { title: "Sec 1", page: 3 }, topic: "T" }).includes("Sec 1"));
console.log("upgrade tests passed");
