import assert from "node:assert/strict";
import { splitSections, makeCards, makeQuiz, buildPlan, gradeCard, freeSegments, topicStats, validateImport, searchSections, dstr, addDays } from "../public/lib.js";

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
