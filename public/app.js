import { uid, BLOCK, dstr, parseD, splitSections, makeCards, makeQuiz, gradeCard, dueCards, topicStats, buildPlan, searchSections, validateImport } from "/lib.js";

// ---------- IndexedDB ----------
const STORES = ["kv", "docs", "cards", "attempts"];
const dbp = new Promise((res, rej) => {
  const r = indexedDB.open("study-deck", 1);
  r.onupgradeneeded = () => { for (const s of STORES) r.result.createObjectStore(s, { keyPath: s === "kv" ? "k" : "id" }); };
  r.onsuccess = () => res(r.result); r.onerror = () => rej(r.error);
});
const tx = async (s, mode, fn) => { const db = await dbp; return new Promise((res, rej) => { const t = db.transaction(s, mode); const out = fn(t.objectStore(s)); t.oncomplete = () => res(out && out.result !== undefined ? out.result : out); t.onerror = () => rej(t.error); }); };
const all = (s) => tx(s, "readonly", (o) => o.getAll());
const put = (s, v) => tx(s, "readwrite", (o) => o.put(v));
const del = (s, id) => tx(s, "readwrite", (o) => o.delete(id));
const clear = (s) => tx(s, "readwrite", (o) => o.clear());

const DEF = { subjects: [], dailyMinutes: 90, winStart: "16:00", winEnd: "21:00", busy: [], weak: {}, done: {} };
let st = { ...DEF }, docs = [], cards = [], attempts = [], plan = null, tab = "today", ai = { ready: false };
const $ = (s) => document.querySelector(s);
const esc = (s) => String(s).replace(/[&<>"]/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;" }[c]));
const saveSt = () => put("kv", { k: "state", v: st });
const subName = (id) => (st.subjects.find((s) => s.id === id) || {}).name || "?";
const secsBySub = () => { const m = {}; for (const d of docs) (m[d.subjectId] ||= []).push(...d.sections); return m; };
const allSecs = () => docs.flatMap((d) => d.sections.map((s) => ({ ...s, subjectId: d.subjectId })));
const secById = (id) => allSecs().find((s) => s.id === id);
const replan = () => { plan = buildPlan(st, secsBySub(), new Date(), st.done); };

async function load() {
  const kv = (await all("kv")).find((x) => x.k === "state");
  st = { ...DEF, ...(kv ? kv.v : {}) };
  docs = await all("docs"); cards = await all("cards"); attempts = await all("attempts");
  replan();
}

// ---------- AI (server function, key never in browser) ----------
async function callAI(body) {
  const r = await fetch("/api/ai", { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify(body) });
  const j = await r.json().catch(() => ({}));
  if (!r.ok) throw new Error(j.message || j.error || "AI error");
  return j;
}
async function checkAI() {
  try { const j = await callAI({ task: "status" }); ai.ready = !!j.ready; } catch { ai.ready = false; }
  const b = $("#aiBadge"); b.textContent = ai.ready ? "AI: on" : "AI: off (optional)"; b.className = "badge" + (ai.ready ? " on" : "");
}

// ---------- views ----------
const TABS = [["today", "Today"], ["plan", "Plan"], ["library", "Library"], ["cards", "Cards"], ["quiz", "Quiz"], ["ask", "Ask"], ["progress", "Progress"], ["setup", "Setup"]];
function nav() {
  $("#nav").innerHTML = TABS.map(([k, n]) => `<button data-t="${k}" class="${tab === k ? "on" : ""}">${n}</button>`).join("");
  $("#nav").onclick = (e) => { const t = e.target.closest("button"); if (t) { tab = t.dataset.t; render(); } };
}
function render() { nav(); const v = $("#view"); v.innerHTML = ""; (views[tab] || views.today)(v); window.scrollTo(0, 0); }
const sectionsOf = (blocks) => ["Morning", "Afternoon", "Evening"].map((p) => [p, blocks.filter((b) => b.part === p)]).filter(([, b]) => b.length);

function blockHTML(b) {
  return `<label class="blk ${b.done ? "done" : ""}"><input type="checkbox" data-b="${b.id}" ${b.done ? "checked" : ""}><div class="t"><span class="tag ${b.type}">${b.type}</span>${esc(b.subject)}: ${esc(b.label)}<div class="mut">${b.start} to ${b.end} (${BLOCK} min)</div></div></label>`;
}
function bindChecks(root) {
  root.querySelectorAll("input[data-b]").forEach((c) => c.onchange = async () => { st.done[c.dataset.b] = c.checked; if (!c.checked) delete st.done[c.dataset.b]; await saveSt(); replan(); render(); });
}
const dayHTML = (d) => d.blocks.length ? sectionsOf(d.blocks).map(([p, bl]) => `<h2>${p}</h2><div class="card">${bl.map(blockHTML).join("")}<div class="mut">5 min break after each block</div></div>`).join("") : `<div class="card mut">Nothing scheduled${d.free ? "" : " (no free time in your window)"}.</div>`;

const views = {
  today(v) {
    if (!st.subjects.length) { v.innerHTML = `<div class="card"><h2>Welcome</h2><p>Start in Setup: add a subject with its test date, your daily minutes and busy times. Then add a PDF in Library. Everything works offline and stays on this device.</p><button class="b" id="go">Open Setup</button></div>`; $("#go").onclick = () => { tab = "setup"; render(); }; return; }
    const key = dstr(new Date()); const d = plan.days.find((x) => x.date === key);
    const due = dueCards(cards).length;
    const tests = st.subjects.filter((s) => s.testDate).map((s) => { const n = Math.round((parseD(s.testDate) - parseD(key)) / 86400000); return `${esc(s.name)}: ${n < 0 ? "passed" : n === 0 ? "TODAY" : n + " days"}`; });
    v.innerHTML = `<div class="card"><b>Countdown</b><div class="mut">${tests.join(" | ")}</div></div>${plan.warnings.map((w) => `<div class="warn">${esc(w)}</div>`).join("")}<div class="card row"><div>Cards due: <b>${due}</b></div><button class="b alt" id="rev">Review cards</button></div><h2 style="margin-bottom:0">Today</h2>${d ? dayHTML(d) : '<div class="card mut">No study days left. Add a future test date in Setup.</div>'}`;
    $("#rev").onclick = () => { tab = "cards"; render(); }; bindChecks(v);
  },
  plan(v) {
    v.innerHTML = `<div class="row"><button class="b alt" id="rp">Rebuild plan</button></div>` + plan.warnings.map((w) => `<div class="warn">${esc(w)}</div>`).join("") + plan.days.map((d) => `<h2>${parseD(d.date).toDateString()}</h2>${dayHTML(d)}`).join("");
    $("#rp").onclick = () => { replan(); render(); }; bindChecks(v);
  },
  library(v) {
    if (!st.subjects.length) { v.innerHTML = `<div class="card">Add a subject in Setup first.</div>`; return; }
    v.innerHTML = `<div class="card"><h2>Import PDF</h2><select id="sub">${st.subjects.map((s) => `<option value="${s.id}">${esc(s.name)}</option>`).join("")}</select><input type="file" id="pdf" accept="application/pdf" multiple><div id="prog" class="mut">PDFs are read in your browser and stored on this device only. Scanned (image) PDFs have no text and cannot be read without AI.</div></div>
    ${docs.map((d) => `<div class="card"><b>${esc(d.name)}</b> <span class="mut">${esc(subName(d.subjectId))}, ${d.pages} pages, ${d.sections.length} sections</span><div class="mut">${d.sections.slice(0, 6).map((s) => esc(s.title)).join(" | ")}</div><button class="b alt" data-gen="${d.id}">Make cards</button>${ai.ready ? `<button class="b alt" data-aigen="${d.id}">AI cards</button>` : ""}<button class="b bad" data-del="${d.id}">Delete</button></div>`).join("") || '<div class="card mut">No PDFs yet.</div>'}`;
    $("#pdf").onchange = async (e) => { for (const f of e.target.files) await importPdf(f, $("#sub").value); render(); };
    v.querySelectorAll("[data-gen]").forEach((b) => b.onclick = async () => { const d = docs.find((x) => x.id === b.dataset.gen); const n = await genCards(d); b.textContent = `+${n} cards`; });
    v.querySelectorAll("[data-aigen]").forEach((b) => b.onclick = async () => { const d = docs.find((x) => x.id === b.dataset.aigen); b.textContent = "working..."; try { const n = await aiCards(d); b.textContent = `+${n} AI cards`; } catch (e) { b.textContent = e.message; } });
    v.querySelectorAll("[data-del]").forEach((b) => b.onclick = async () => { if (!confirm("Delete this PDF and its cards?")) return; const d = docs.find((x) => x.id === b.dataset.del); for (const c of cards.filter((c) => d.sections.some((s) => s.id === c.topicId))) await del("cards", c.id); await del("docs", d.id); await load(); render(); });
  },
  cards(v) {
    const due = dueCards(cards);
    if (!cards.length) { v.innerHTML = `<div class="card">No cards yet. Import a PDF in Library and tap Make cards.</div>`; return; }
    if (!due.length) { v.innerHTML = `<div class="card">All caught up. ${cards.length} cards total.</div>`; return; }
    const c = due[0]; let shown = false;
    const draw = () => {
      v.innerHTML = `<div class="mut">${due.length} due | ${esc(c.topic)}</div><div class="card"><h2>${esc(c.q)}</h2>${shown ? `<p>${esc(c.a)}</p><div class="row"><button class="b bad" data-q="0">Again</button><button class="b alt" data-q="3">Hard</button><button class="b" data-q="4">Good</button><button class="b alt" data-q="5">Easy</button></div>` : `<button class="b" id="show">Show answer</button>`}</div>`;
      if (!shown) $("#show").onclick = () => { shown = true; draw(); };
      else v.querySelectorAll("[data-q]").forEach((b) => b.onclick = async () => { const q = +b.dataset.q; const n = gradeCard(c, q); await put("cards", n); Object.assign(c, n); cards[cards.findIndex((x) => x.id === c.id)] = n; if (q === 0) st.weak[c.topicId] = true; await saveSt(); render(); });
    };
    draw();
  },
  quiz(v) {
    v.innerHTML = `<div class="card"><h2>Practice test</h2><select id="qs"><option value="">All subjects</option>${st.subjects.map((s) => `<option value="${s.id}">${esc(s.name)}</option>`).join("")}</select><select id="qn"><option>5</option><option selected>10</option><option>20</option></select><button class="b" id="start">Start</button>${ai.ready ? '<button class="b alt" id="aiq">AI quiz</button>' : ""}<div id="qerr" class="warn"></div></div><div id="qbox"></div>`;
    const pick = () => cards.filter((c) => !$("#qs").value || c.subjectId === $("#qs").value);
    $("#start").onclick = () => { const q = makeQuiz(pick(), +$("#qn").value); if (q.length < 2) { $("#qerr").textContent = "Not enough cards. Make cards from a PDF first (need several definitions or facts)."; return; } runQuiz(q); };
    if (ai.ready) $("#aiq").onclick = async () => { const sid = $("#qs").value; const txt = allSecs().filter((s) => !sid || s.subjectId === sid).map((s) => s.text).join("\n").slice(0, 28000); if (!txt) { $("#qerr").textContent = "No PDF text yet."; return; } $("#aiq").textContent = "working..."; try { const j = await callAI({ task: "quiz", text: txt }); runQuiz(j.data.map((x) => ({ id: uid(), topicId: sid || "ai", topic: "AI quiz", subjectId: sid, q: x.q, options: x.options, answer: x.answer, explain: x.explain }))); } catch (e) { $("#qerr").textContent = e.message; } $("#aiq").textContent = "AI quiz"; };
  },
  ask(v) {
    v.innerHTML = `<div class="card"><h2>Explain / look up</h2><textarea id="q" rows="2" placeholder="e.g. where does glycolysis occur?"></textarea><button class="b" id="find">Search my notes</button>${ai.ready ? '<button class="b alt" id="exp">Explain with AI</button>' : ""}<div id="out"></div></div>
    <div class="card"><h2>Check my written answer</h2><textarea id="ans" rows="3" placeholder="Type your answer (or attach a photo of it)"></textarea><input type="file" id="img" accept="image/*" capture="environment"><button class="b alt" id="chk" ${ai.ready ? "" : "disabled"}>Check answer</button>${ai.ready ? "" : '<div class="warn">Photo scan and answer checking: pending Gemini. Turns on after the API key is added in Vercel. Everything else works without it.</div>'}<div id="out2"></div></div>`;
    const ctx = () => allSecs().slice(0, 40).map((s) => s.text).join("\n").slice(0, 28000);
    $("#find").onclick = () => { const r = searchSections($("#q").value, allSecs()); $("#out").innerHTML = r.length ? r.map((x) => `<div class="card"><div class="mut">${esc(x.title)}</div>${esc(x.sentence)}</div>`).join("") : '<div class="mut">Nothing found in your PDFs.</div>'; };
    if (ai.ready) {
      $("#exp").onclick = async () => { const q = $("#q").value; const hits = searchSections(q, allSecs()).map((x) => x.sentence).join(" "); $("#out").textContent = "thinking..."; try { const j = await callAI({ task: "explain", text: hits || ctx().slice(0, 8000), question: q }); $("#out").innerHTML = `<div class="card" style="white-space:pre-wrap">${esc(j.text)}</div>`; } catch (e) { $("#out").textContent = e.message; } };
      $("#chk").onclick = async () => { const q = $("#q").value || "the question"; const f = $("#img").files[0]; let image, mime; if (f) { image = await shrink(f); mime = "image/jpeg"; } $("#out2").textContent = "checking..."; try { const j = await callAI({ task: "check", text: (image ? "" : "Student answer: " + $("#ans").value + "\n") + searchSections(q, allSecs()).map((x) => x.sentence).join(" "), question: q, image, mime }); $("#out2").innerHTML = `<div class="card" style="white-space:pre-wrap">${esc(j.text)}</div>`; } catch (e) { $("#out2").textContent = e.message; } };
    }
  },
  progress(v) {
    const ts = topicStats(attempts, cards); const done = Object.keys(st.done).length; const total = plan.days.reduce((a, d) => a + d.blocks.length, 0);
    v.innerHTML = `<div class="card"><b>Plan progress</b><div class="bar"><i style="width:${total ? Math.round((done / total) * 100) : 0}%"></i></div><div class="mut">${done} of ${total} blocks done | ${cards.length} cards | ${attempts.length} quiz answers</div></div><h2>Weak topics</h2>${ts.filter((t) => t.acc < 0.7).map((t) => `<div class="card">${esc(t.topic)} <span class="mut">${esc(subName(t.subjectId))}</span><div class="bar"><i style="width:${Math.round(t.acc * 100)}%;background:var(--bad)"></i></div><div class="mut">${Math.round(t.acc * 100)}% over ${t.n} answers</div></div>`).join("") || '<div class="card mut">No weak topics yet. Take quizzes and review cards to see them.</div>'}`;
  },
  setup(v) {
    v.innerHTML = `<div class="card"><h2>Subjects and test dates</h2>${st.subjects.map((s) => `<div class="row"><input data-sn="${s.id}" value="${esc(s.name)}"><input type="date" data-sd="${s.id}" value="${s.testDate || ""}"><button class="b bad" data-sx="${s.id}" style="flex:none">x</button></div>`).join("")}<div class="row"><input id="nn" placeholder="New subject"><input type="date" id="nd"><button class="b" id="addS" style="flex:none">Add</button></div></div>
    <div class="card"><h2>Daily time</h2><div class="row"><label>Minutes per day<input type="number" id="dm" min="25" step="5" value="${st.dailyMinutes}"></label><label>From<input type="time" id="ws" value="${st.winStart}"></label><label>Until<input type="time" id="we" value="${st.winEnd}"></label></div><div class="mut">Blocks are ${BLOCK} min with 5 min breaks.</div></div>
    <div class="card"><h2>Busy times</h2>${st.busy.map((b, i) => `<div class="row"><span>${esc(b.label || "Busy")} ${b.start}-${b.end} (${b.days.map((d) => "SMTWTFS"[d]).join("")})</span><button class="b bad" data-bx="${i}" style="flex:none">x</button></div>`).join("")}<input id="bl" placeholder="Activity (school, football...)"><div class="days">${["Sun", "Mon", "Tue", "Wed", "Thu", "Fri", "Sat"].map((n, i) => `<label><input type="checkbox" class="bd" value="${i}">${n}</label>`).join("")}</div><div class="row"><input type="time" id="bs" value="08:00"><input type="time" id="be" value="15:00"><button class="b" id="addB" style="flex:none">Add</button></div></div>
    <div class="card"><h2>Backup</h2><button class="b" id="exp">Export JSON</button><input type="file" id="imp" accept="application/json"><div class="mut">Includes settings, extracted text, cards and progress. Original PDF files are not included.</div><button class="b bad" id="wipe">Erase all data</button></div>
    <div class="card"><h2>AI</h2><div class="mut">${ai.ready ? "Gemini is on (key is set on the server)." : "Off. Add GEMINI_API_KEY in your Vercel project settings (Environment Variables), then redeploy. Never paste it into this app."}</div></div>`;
    const commit = async () => { await saveSt(); replan(); };
    v.querySelectorAll("[data-sn]").forEach((i) => i.onchange = async () => { st.subjects.find((s) => s.id === i.dataset.sn).name = i.value; await commit(); });
    v.querySelectorAll("[data-sd]").forEach((i) => i.onchange = async () => { st.subjects.find((s) => s.id === i.dataset.sd).testDate = i.value; await commit(); });
    v.querySelectorAll("[data-sx]").forEach((b) => b.onclick = async () => { st.subjects = st.subjects.filter((s) => s.id !== b.dataset.sx); await commit(); render(); });
    $("#addS").onclick = async () => { if (!$("#nn").value.trim()) return; st.subjects.push({ id: uid(), name: $("#nn").value.trim(), testDate: $("#nd").value }); await commit(); render(); };
    $("#dm").onchange = async () => { st.dailyMinutes = Math.max(25, +$("#dm").value || 90); await commit(); };
    $("#ws").onchange = async () => { st.winStart = $("#ws").value; await commit(); };
    $("#we").onchange = async () => { st.winEnd = $("#we").value; await commit(); };
    $("#addB").onclick = async () => { const days = [...v.querySelectorAll(".bd:checked")].map((c) => +c.value); if (!days.length || $("#bs").value >= $("#be").value) return alert("Pick days and a valid start/end"); st.busy.push({ label: $("#bl").value, days, start: $("#bs").value, end: $("#be").value }); await commit(); render(); };
    v.querySelectorAll("[data-bx]").forEach((b) => b.onclick = async () => { st.busy.splice(+b.dataset.bx, 1); await commit(); render(); });
    $("#exp").onclick = exportJSON;
    $("#imp").onchange = (e) => importJSON(e.target.files[0]);
    $("#wipe").onclick = async () => { if (!confirm("Erase everything on this device?")) return; for (const s of STORES) await clear(s); await load(); render(); };
  },
};

// ---------- actions ----------
async function importPdf(file, subjectId) {
  const prog = $("#prog");
  try {
    prog.textContent = `Reading ${file.name}...`;
    const pdfjs = await import("/vendor/pdf.min.mjs");
    pdfjs.GlobalWorkerOptions.workerSrc = "/vendor/pdf.worker.min.mjs";
    const buf = await file.arrayBuffer();
    const pdf = await pdfjs.getDocument({ data: buf.slice(0) }).promise;
    const pages = [];
    for (let i = 1; i <= pdf.numPages; i++) {
      const p = await pdf.getPage(i); const tc = await p.getTextContent(); let line = "", lastY = null, out = "";
      for (const it of tc.items) { if (lastY !== null && Math.abs(it.transform[5] - lastY) > 2) { out += line + "\n"; line = ""; } line += it.str + (it.hasEOL ? "" : " "); lastY = it.transform[5]; }
      pages.push(out + line); prog.textContent = `${file.name}: page ${i}/${pdf.numPages}`;
    }
    const sections = splitSections(pages);
    if (!sections.length) { prog.textContent = `${file.name}: no readable text (scanned PDF?).`; alert("No text found. This looks like a scanned PDF."); return; }
    const doc = { id: uid(), subjectId, name: file.name, pages: pdf.numPages, sections, blob: new Blob([buf], { type: "application/pdf" }), added: Date.now() };
    await put("docs", doc); docs.push(doc);
    await genCards(doc); replan();
  } catch (e) { prog.textContent = "Failed: " + e.message; alert("Could not read PDF: " + e.message); }
}
async function genCards(doc) {
  const have = new Set(cards.map((c) => c.q)); let n = 0;
  for (const s of doc.sections) for (const c of makeCards(s, doc.subjectId)) { if (have.has(c.q)) continue; have.add(c.q); await put("cards", c); cards.push(c); n++; }
  return n;
}
async function aiCards(doc) {
  const j = await callAI({ task: "cards", text: doc.sections.map((s) => s.text).join("\n").slice(0, 28000) });
  let n = 0; for (const x of j.data) { const c = { id: uid(), subjectId: doc.subjectId, topicId: doc.sections[0].id, topic: doc.sections[0].title, q: x.q, a: x.a, kind: "ai", ctx: x.a, ease: 2.5, interval: 0, due: 0, reps: 0, lapses: 0 }; await put("cards", c); cards.push(c); n++; }
  return n;
}
function runQuiz(qs) {
  let i = 0, score = 0; const box = $("#qbox");
  const show = () => {
    if (i >= qs.length) { box.innerHTML = `<div class="card"><h2>Score: ${score}/${qs.length}</h2><div class="mut">Wrong topics are now tracked under Progress.</div></div>`; return; }
    const q = qs[i];
    box.innerHTML = `<div class="card"><div class="mut">Question ${i + 1}/${qs.length}</div><h2>${esc(q.q)}</h2>${q.options.map((o, k) => `<button class="opt" data-k="${k}">${esc(o)}</button>`).join("")}<div id="ex"></div></div>`;
    box.querySelectorAll(".opt").forEach((b) => b.onclick = async () => {
      const k = +b.dataset.k, ok = k === q.answer; if (ok) score++;
      box.querySelectorAll(".opt").forEach((x) => { x.disabled = true; if (+x.dataset.k === q.answer) x.classList.add("ok"); });
      if (!ok) b.classList.add("no");
      const a = { id: uid(), topicId: q.topicId, topic: q.topic, subjectId: q.subjectId, correct: ok, at: Date.now() };
      await put("attempts", a); attempts.push(a); if (!ok) { st.weak[q.topicId] = true; await saveSt(); }
      $("#ex").innerHTML = `<p class="mut">${esc(q.explain || "")}</p><button class="b" id="nx">${i + 1 >= qs.length ? "Finish" : "Next"}</button>`; $("#nx").onclick = () => { i++; show(); };
    });
  };
  show();
}
function shrink(file) {
  return new Promise((res, rej) => { const img = new Image(); img.onload = () => { const s = Math.min(1, 1600 / Math.max(img.width, img.height)); const c = document.createElement("canvas"); c.width = img.width * s; c.height = img.height * s; c.getContext("2d").drawImage(img, 0, 0, c.width, c.height); res(c.toDataURL("image/jpeg", 0.8).split(",")[1]); }; img.onerror = rej; img.src = URL.createObjectURL(file); });
}
async function exportJSON() {
  const out = { app: "study-deck", version: 1, exported: new Date().toISOString(), state: st, docs: docs.map(({ blob, ...d }) => d), cards, attempts };
  const a = document.createElement("a"); a.href = URL.createObjectURL(new Blob([JSON.stringify(out)], { type: "application/json" })); a.download = `study-deck-${dstr(new Date())}.json`; a.click();
}
async function importJSON(f) {
  if (!f) return;
  try {
    const o = validateImport(JSON.parse(await f.text()));
    if (!confirm("This replaces all data on this device. Continue?")) return;
    for (const s of STORES) await clear(s);
    await put("kv", { k: "state", v: { ...DEF, ...o.state } });
    for (const d of o.docs) await put("docs", d);
    for (const c of o.cards || []) await put("cards", c);
    for (const a of o.attempts || []) await put("attempts", a);
    await load(); render();
  } catch (e) { alert("Import failed: " + e.message); }
}

if ("serviceWorker" in navigator) navigator.serviceWorker.register("/sw.js").catch(() => {});
if (navigator.storage && navigator.storage.persist) navigator.storage.persist().catch(() => {});
load().then(() => { render(); checkAI(); });
