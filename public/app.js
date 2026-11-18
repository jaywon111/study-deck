import { uid, BLOCK, dstr, parseD, splitSections, makeCards, makeQuiz, gradeCard, dueCards, topicStats, buildPlan, searchSections, validateImport, makeClozeCards, makeQuizFromNotes, editCard, deleteCard, dueQueue, queueStats, sourceLabel, rescheduleMissed, backupStatus, BACKUP_VERSION, docSearch } from "/lib.js";

// ---------- IndexedDB ----------
const STORES = ["kv", "docs", "cards", "attempts", "sessions", "marks"];
const dbp = new Promise((res, rej) => {
  const r = indexedDB.open("study-deck", 3);
  r.onupgradeneeded = () => {
    for (const s of STORES) if (!r.result.objectStoreNames.contains(s)) r.result.createObjectStore(s, { keyPath: s === "kv" ? "k" : "id" });
  };
  r.onsuccess = () => res(r.result); r.onerror = () => rej(r.error);
});
const tx = async (s, mode, fn) => { const db = await dbp; return new Promise((res, rej) => { const t = db.transaction(s, mode); const out = fn(t.objectStore(s)); t.oncomplete = () => res(out && out.result !== undefined ? out.result : out); t.onerror = () => rej(t.error); }); };
const all = (s) => tx(s, "readonly", (o) => o.getAll());
const put = (s, v) => tx(s, "readwrite", (o) => o.put(v));
const del = (s, id) => tx(s, "readwrite", (o) => o.delete(id));
const clear = (s) => tx(s, "readwrite", (o) => o.clear());

const DEF = { subjects: [], dailyMinutes: 90, winStart: "16:00", winEnd: "21:00", busy: [], weak: {}, done: {}, lastExportAt: 0, lastImportAt: 0, snapAt: 0 };
let st = { ...DEF }, docs = [], cards = [], attempts = [], sessions = [], marks = [], plan = null, tab = "today", ai = { ready: false };
let carried = [], carriedDone = {}, sess = null, sessTimer = 0, guideSel = null;
const $ = (s) => document.querySelector(s);
const esc = (s) => String(s).replace(/[&<>"]/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;" }[c]));
const saveSt = () => put("kv", { k: "state", v: st });
const subName = (id) => (st.subjects.find((s) => s.id === id) || {}).name || "?";
const secsBySub = () => { const m = {}; for (const d of docs) (m[d.subjectId] ||= []).push(...d.sections); return m; };
const allSecs = () => docs.flatMap((d) => d.sections.map((s) => ({ ...s, subjectId: d.subjectId })));
const secById = (id) => allSecs().find((s) => s.id === id);
const replan = () => {
  plan = buildPlan(st, secsBySub(), new Date(), st.done);
  carried = rescheduleMissed(plan.days, st.done, st, new Date());
};
const b64 = async (blob) => new Promise((res) => { const r = new FileReader(); r.onload = () => res(String(r.result).split(",")[1]); r.readAsDataURL(blob); });
const blobFromB64 = (b64s, type) => Uint8Array.from(atob(b64s), (c) => c.charCodeAt(0));

async function load() {
  const kv = (await all("kv")).find((x) => x.k === "state");
  st = { ...DEF, ...(kv ? kv.v : {}) };
  docs = await all("docs"); cards = await all("cards"); attempts = await all("attempts");
  try { sessions = await all("sessions"); } catch {} try { marks = await all("marks"); } catch {}
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
const TABS = [["today", "Today", "🏠", "Home"], ["plan", "Plan", "🗓️", "Plan"], ["session", "Focus", "⏱️", "Focus session"], ["cards", "Cards", "🃏", "Cards"], ["quiz", "Quiz", "🧪", "Quiz"], ["library", "Library", "📚", "Library"], ["ask", "Ask", "💬", "Ask"], ["progress", "Progress", "📈", "Progress"], ["setup", "Setup", "⚙️", "Setup"]];

// The entire nav strip is a 3D rotatable carousel. Each tab is a card
// on a cylinder; drag to spin, tap a front card to go there.
const NAV_STEP = 360 / TABS.length;
// Card size is a plain constant pair (132 desktop / 200 mobile) and is read back
// from the CSS variable so the cylinder radius always matches the painted cards.
// Previously a JS vw formula disagreed with the CSS clamp, so on return the front
// card rendered at the CSS size while the cylinder used the JS size: inconsistent.
const NAV_CARD = { desktop: 132, mobile: 200 };
const navCardSize = () => (window.innerWidth || 390) <= 860 ? NAV_CARD.mobile : NAV_CARD.desktop;
const navRadius = () => {
  const size = navCardSize();
  return Math.max(140, Math.min(260, (TABS.length * (size * 0.58)) / Math.tan(Math.PI / TABS.length)));
};
const wheel = { angle: 0, target: 0, locked: false, raf: 0, moved: false };
// expanded is the carousel state. It defaults collapsed on page load so Today
// does not block scrolling; the Sections toggle expands it. Sizing stays
// consistent because NAV_CARD and the CSS radius are shared when expanded.
let expanded = false;
const norm360 = (n) => ((n % 360) + 360) % 360;

function ensureNavDOM() {
  const nav = $("#nav");
  if (!nav || nav.querySelector(".rot")) return nav;
  nav.classList.add("wheel-nav");
  nav.innerHTML =
    '<button type="button" class="wheel-toggle" aria-expanded="' + (expanded ? "true" : "false") + '" aria-controls="rotStage">' +
    '<span class="wt-label"><span class="wt-title">Sections</span><small class="wt-sub"></small></span>' +
    '<span class="wt-chev" aria-hidden="true">&#8593;</span></button>' +
    '<div class="rot-stage" id="rotStage"><div class="rot" role="listbox" aria-label="Study sections" aria-orientation="vertical">' +
    TABS.map(([k, n, i, label], idx) =>
      `<button type="button" role="option" class="rot-card" data-t="${k}" data-index="${idx}" aria-label="${n}, ${label}">` +
      `<span class="rot-num" aria-hidden="true">&#10022;</span><span class="rot-icon" aria-hidden="true">${i}</span><span class="rot-name">${n}</span><span class="rot-sub">${label}</span></button>`
    ).join("") +
    '</div></div>' +
    '<div class="rot-count" aria-hidden="true">eight sections</div>' +
    '<p class="rot-hint">&#9679; drag to spin &#9679;</p>';
  bindWheel(nav);
  syncNavState();
  return nav;
}


// ---- collapse / expand ----
function setExpanded(next, focusToggle) {
  expanded = !!next;
  syncNavState();
  if (expanded) {
    // restore the cylinder at the true angle for the current tab, then render
    const idx = TABS.findIndex(([k]) => k === tab);
    if (idx >= 0) { wheel.target = wheel.angle = idx * NAV_STEP; }
    animateWheel();
  }
  if (focusToggle) {
    const t = $("#nav") && $("#nav").querySelector(".wheel-toggle");
    if (t) t.focus({ preventScroll: true });
  }
}
function syncNavState() {
  const navEl = $("#nav");
  if (!navEl) return;
  navEl.classList.toggle("collapsed", !expanded);
  document.body.classList.toggle("nav-collapsed", !expanded);
  const t = navEl.querySelector(".wheel-toggle");
  if (t) {
    t.setAttribute("aria-expanded", expanded ? "true" : "false");
    const title = t.querySelector(".wt-title");
    const sub = t.querySelector(".wt-sub");
    const cur = (TABS.find((x) => x[0] === tab) || TABS[0])[1];
    if (title) title.textContent = expanded ? "Collapse sections" : "Sections";
    if (sub) sub.textContent = expanded ? ("drag to spin \u00b7 now on " + cur) : ("tap to expand \u00b7 on " + cur);
    const stage = navEl.querySelector("#rotStage");
    if (stage) stage.setAttribute("aria-hidden", expanded ? "false" : "true");
  }
}

function renderWheel(angle, instant) {
  const navEl = $("#nav");
  const rot = navEl && navEl.querySelector ? navEl.querySelector(".rot") : null;
  if (!rot) return;
  rot.style.transform = `translateZ(-${navRadius()}px) rotateX(-14deg) rotateY(${angle}deg)`;
  const cards = [...rot.querySelectorAll(".rot-card")];
  cards.forEach((card, idx) => {
    const face = idx * NAV_STEP;
    card.style.transform = `rotateY(${face}deg) translateZ(${navRadius()}px)`;
    const rel = norm360(angle + face);
    const dist = Math.min(Math.abs(rel), 360 - Math.abs(rel));
    const front = Math.abs(norm360(angle + face + 180) - 180) < 72; // front half of viewer
    const frontish = dist < 70;
    const active = card.dataset.t === tab;
    card.classList.toggle("front", front && !reducedMotionAny());
    card.classList.toggle("active", active);
    card.setAttribute("aria-selected", active ? "true" : "false");
    // show front and both immediate neighbours (dist <= 90deg), keep click/tap alive there
    const near = dist <= 90;
    card.style.visibility = near || active ? "visible" : "hidden";
    card.style.pointerEvents = near || active ? "auto" : "none";
    card.style.opacity = front || active ? "1" : "0.35";
    card.style.filter = front ? "none" : "saturate(.35)";
  });
  const c = (navEl && navEl.querySelector) ? navEl.querySelector(".rot-count") : null;
  if (c) {
    const idx = TABS.findIndex(([k]) => k === tab);
    c.textContent = `0${(idx < 0 ? 0 : idx) + 1} / 0${TABS.length}`;
  }
}
function reducedMotionAny() {
  return window.matchMedia && window.matchMedia("(prefers-reduced-motion: reduce)").matches;
}

function animateWheel() {
  cancelAnimationFrame(wheel.raf);
  if (reducedMotionAny()) { wheel.angle = wheel.target; renderWheel(wheel.angle, true); return; }
  const tick = () => {
    wheel.angle += (wheel.target - wheel.angle) * 0.12;
    if (Math.abs(wheel.target - wheel.angle) < 0.15) { wheel.angle = wheel.target; renderWheel(wheel.angle); return; }
    renderWheel(wheel.angle);
    wheel.raf = requestAnimationFrame(tick);
  };
  renderWheel(wheel.angle);
  wheel.raf = requestAnimationFrame(tick);
}

function spinToIndex(idx, silent) {
  const step = NAV_STEP;
  let delta = norm360(idx * step - wheel.target);
  if (delta > 180) delta -= 360;
  wheel.target += delta;
  if (silent) { wheel.angle = wheel.target; renderWheel(wheel.angle, true); }
  else animateWheel();
}

function bindWheel(nav) {
  const rot = nav.querySelector(".rot");
  const rotCards = [...rot.querySelectorAll(".rot-card")];
  const toggle = nav.querySelector(".wheel-toggle");
  if (toggle) {
    toggle.addEventListener("click", (e) => { e.preventDefault(); e.stopPropagation(); setExpanded(!expanded); });
    toggle.addEventListener("pointerdown", (e) => e.stopPropagation());
  }
  let dragging = false, startX = 0, startAngle = 0, lastX = 0, lastT = 0, velocity = 0, moved = false, snapping = false;
  const handle = nav.querySelector(".rot-stage") || rot;

  const onDown = (e) => {
    if (snapping) return;
    dragging = true; moved = false;
    cancelAnimationFrame(wheel.raf);
    startX = lastX = e.clientX; lastT = performance.now(); startAngle = wheel.target; velocity = 0;
    try { handle.setPointerCapture?.(e.pointerId); } catch {}
  };
  const onMove = (e) => {
    if (!dragging) return;
    const dx = e.clientX - startX;
    if (Math.abs(dx) > 6) moved = true;
    else return; // require a real horizontal drag before rotating, so tap/click passes through
    const now = performance.now();
    const inst = (e.clientX - lastX) / Math.max(1, now - lastT);
    velocity = 0.8 * velocity + 0.2 * inst;
    lastX = e.clientX; lastT = now;
    // natural surface drag: the visible surface follows the finger.
    // Drag right moves the right-hand item toward the front.
    // Card faces are placed at +face and rotation is applied as rotateY(angle),
    // so a positive angle is required for rightward motion.
    wheel.angle = wheel.target = startAngle + dx * 0.45;
    renderWheel(wheel.angle);
  };
  const onUp = (e) => {
    if (!dragging) return;
    dragging = false;
    if (e && e.pointerId !== undefined) { try { handle.releasePointerCapture?.(e.pointerId); } catch {} }
    if (!moved) {
      // tap: if a card was directly hit, navigate there; otherwise keep current
      const tapped = rotCards.find((c) => c.dataset._tapped);
      if (tapped && tapped.dataset.t !== tab) {
        const idx = +tapped.dataset.index;
        tab = tapped.dataset.t;
        snapping = true;
        spinToIndex(idx);
        render();
        setTimeout(() => { snapping = false; }, 450);
      }
      return;
    } // dragged: snap + navigate handled below
    // inertial flick if quick drag: velocity is px per ms, 0.45deg per px
    const flickDegMs = velocity * 0.45;
    if (Math.abs(flickDegMs) > 0.22) {
      // project a bit of extra angle from the throw, then snap
      const project = Math.max(-NAV_STEP * 1.6, Math.min(NAV_STEP * 1.6, flickDegMs * 220));
      wheel.target += project;
    }
    // snap to the nearest tab and navigate there. Positive angle increments
    // the index because angle + face = 0 at the front for positive index.
    const snapped = Math.round(wheel.target / NAV_STEP);
    const idx = ((snapped % TABS.length) + TABS.length) % TABS.length;
    snapping = true;
    spinToIndex(idx);
    if (TABS[idx] && TABS[idx][0] !== tab) { tab = TABS[idx][0]; render(); }
    setTimeout(() => { snapping = false; }, 450);
    setTimeout(() => { moved = false; }, 250);
  };
  handle.addEventListener("pointerdown", onDown);
  handle.addEventListener("pointermove", onMove, { passive: true });
  handle.addEventListener("pointerup", onUp);
  handle.addEventListener("pointercancel", onUp);
  handle.style.touchAction = "pan-y"; // allow vertical page scroll, horizontal drag goes to the wheel

  rotCards.forEach((card) => {
    const go = () => {
      if (moved || snapping) return;
      const idx = +card.dataset.index;
      if (card.dataset.t !== tab) {
        tab = card.dataset.t;
        spinToIndex(idx);
        render();
        renderWheel(wheel.angle, true);
      } else {
        render();
      }
    };
    card.addEventListener("click", (e) => { e.preventDefault(); go(); });
    card.addEventListener("pointerdown", (e) => {
      // direct hit on a card: register tap target; a drag will override in pointerup
      card.dataset._tapped = "1";
      setTimeout(() => { delete card.dataset._tapped; }, 600);
      // do not stopPropagation, so dragging starting on a card also rotates
    });
  });

  // drag is the primary control. keyboard: arrows left/right on the stage
  handle.tabIndex = 0;
  handle.setAttribute("aria-label", "Drag to rotate sections, or use arrow keys to spin");
  handle.addEventListener("keydown", (e) => {
    if (snapping) return;
    if (e.key === "ArrowRight" || e.key === "ArrowLeft") {
      e.preventDefault();
      if (moved) return;
      const dir = e.key === "ArrowRight" ? 1 : -1;
      const cur = TABS.findIndex(([k]) => k === tab);
      const idx = (cur + dir + TABS.length) % TABS.length;
      tab = TABS[idx][0];
      spinToIndex(idx);
      render();
      // after render, nav() re-creates DOM; focus the newly selected card
      const nav2 = $("#nav");
      nav2 && nav2.querySelector(`.rot-card[data-t="${tab}"]`)?.focus({ preventScroll: true });
    }
  });
  // keep the radius/size in sync with the viewport after rotation/resize
  window.addEventListener("resize", () => renderWheel(wheel.angle, true));
}

function initWheel() {
  const nav = ensureNavDOM();
  const cur = TABS.findIndex(([k]) => k === tab);
  const idx = cur < 0 ? 0 : cur;
  wheel.target = wheel.angle = idx * NAV_STEP;
  syncNavState();
  renderWheel(wheel.angle, true);
  // always render the cylinder so the front card is sized identically on every tab
  // when collapsed we deliberately leave the cylinder untouched: setting a
  // rotateY on a hidden stage was the source of the oversized front card on
  // the first expand after returning to Today.
}

function nav() {
  // preserve the user's collapsed/expanded choice when switching tabs; initial
  // load stays collapsed (expanded=false above) and Sections expands it.
  const navEl = ensureNavDOM();
  if (navEl && navEl.classList.contains("wheel-nav")) {
    syncNavState();
    // sync active state after tab change without rebuilding bindings
    const idx = TABS.findIndex(([k]) => k === tab);
    if (idx >= 0 && expanded) {
      // if angle does not match current tab, spin smoothly
      const targetAngle = idx * NAV_STEP;
      if (norm360(wheel.target - targetAngle) !== 0) spinToIndex(idx);
      else renderWheel(wheel.angle, true);
    }
  }
  const tn = $("#topnav");
  const pick = (e) => { const t = e.target.closest("button"); if (t) { tab = t.dataset.t; render(); } };
  if (tn) { tn.innerHTML = TABS.map(([k, n]) => `<button data-t="${k}" class="${tab === k ? "on" : ""}">${n}</button>`).join(""); tn.onclick = pick; }
  const cta = $("#ctaSetup");
  if (cta) cta.onclick = () => { tab = "setup"; render(); };
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
const carriedHTML = () => {
  const open = carried.filter((b) => !b.unscheduled && !carriedDone[b.id]);
  const stuck = carried.filter((b) => b.unscheduled);
  return `<section><h2>Carried over (missed blocks)</h2>${open.length ? `<div class="card" style="display:grid;gap:8px">${open.map((b) => `<div class="row"><label class="blk ${carriedDone[b.id] ? "done" : ""}" style="flex:1"><input type="checkbox" data-carried="${b.id}" ${carriedDone[b.id] ? "checked" : ""}><div class="t"><span class="tag ${b.type}">${b.type}</span>${esc(b.subject)}: ${esc(b.label)}<div class="mut">${parseD(b.date).toDateString()} ${b.start} to ${b.end}</div></div></label><button class="b alt" data-focus="${b.id}">Focus</button></div>`).join("")}</div>` : ""}${stuck.length ? `<div class="warn">${stuck.map((b) => `${esc(b.subject)}: ${esc(b.label)}`).join("<br>")}</div>` : ""}${!open.length && !stuck.length ? `<div class="card mut">Nothing missed. Missed blocks land here, rescheduled around your busy times and test dates.</div>` : ""}</section>`;
};
function bindCarried(root) {
  root.querySelectorAll("input[data-carried]").forEach((c) => c.onchange = async () => { carriedDone[c.dataset.carried] = c.checked; if (!c.checked) delete carriedDone[c.dataset.carried]; st.done[c.dataset.carried] = c.checked; if (!c.checked) delete st.done[c.dataset.carried]; await saveSt(); replan(); render(); });
  root.querySelectorAll("[data-focus]").forEach((b) => b.onclick = () => { tab = "session"; const blk = carried.find((x) => x.id === b.dataset.focus); startSession(blk ? blk.subjectId : "", blk); render(); });
}
const mmss = (s) => `${String(Math.floor(s / 60)).padStart(2, "0")}:${String(s % 60).padStart(2, "0")}`;
function startSession(subId, block, opts = {}) {
  const secs = allSecs().filter((s) => !subId || s.subjectId === subId);
  const due = dueQueue(cards.filter((c) => !subId || c.subjectId === subId)).slice(0, 12);
  const quizN = Math.max(1, Math.min(10, opts.quizN || 3));
  const quiz = [...makeQuiz(due.length ? due : cards.filter((c) => !subId || c.subjectId === subId), quizN), ...makeQuizFromNotes(secs, Math.max(0, quizN - 2))].slice(0, quizN);
  sess = { started: Date.now(), subjectId: subId || null, total: (opts.minutes || 25) * 60, left: (opts.minutes || 25) * 60, minutes: opts.minutes || 25, notes: block ? `${block.label}\n` : "", cards: due, shown: false, quiz, qi: 0, quizRight: 0, done: false, block: block || null };
  clearInterval(sessTimer);
  sessTimer = setInterval(() => { if (sess) { sess.left = Math.max(0, sess.left - 1); const t = $("#sestime"); if (t) t.textContent = mmss(sess.left); } }, 1000);
}
function drawSession(v) {
  const c = sess.cards[0];
  const q = sess.quiz[sess.qi];
  v.innerHTML = `<div class="card"><div class="row"><b>Focus: ${esc(subName(sess.subjectId))}</b><span id="sestime" style="font-weight:700;font-size:22px">${mmss(sess.left)}</span></div><div class="bar"><i style="width:${sess.total ? Math.round(sess.left / sess.total * 100) : 0}%"></i></div><div class="row"><button class="b alt" id="sepause">${sessTimer ? "Pause" : "Resume"}</button><button class="b" id="seend">Finish session</button></div></div>
  <div class="card"><h2>Session notes</h2><textarea id="senotes" rows="4" placeholder=" jot what you learned">${esc(sess.notes)}</textarea></div>
  ${c ? `<div class="card"><div class="mut">${sess.cards.length} cards in this session | ${esc(sourceLabel(c))}</div><h2>${esc(c.q)}</h2>${sess.shown ? `<p>${esc(c.a)}</p><div class="row"><button class="b bad" data-sq="0">Again</button><button class="b alt" data-sq="3">Hard</button><button class="b" data-sq="4">Good</button><button class="b alt" data-sq="5">Easy</button></div>` : `<button class="b" id="seshow">Show answer</button>`}</div>` : `<div class="card mut">No due cards. Quiz below still works from your notes.</div>`}
  ${q && !c ? `<div class="card"><div class="mut">Quick quiz ${sess.qi + 1}/${sess.quiz.length}</div><h2>${esc(q.q)}</h2>${q.options.map((o, k) => `<button class="opt" data-qk="${k}">${esc(o)}</button>`).join("")}<div id="seex"></div></div>` : ""}
  ${!c && !q ? `<div class="card"><b>Session complete</b><div class="mut">Cards reviewed, quiz ${sess.quizRight} right.</div></div>` : ""}`;
  $("#senotes").oninput = (e) => { sess.notes = e.target.value; };
  $("#sepause").onclick = () => { if (sessTimer) { clearInterval(sessTimer); sessTimer = 0; } else { sessTimer = setInterval(() => { if (sess) { sess.left = Math.max(0, sess.left - 1); const t = $("#sestime"); if (t) t.textContent = mmss(sess.left); } }, 1000); } drawSession(v); };
  $("#seend").onclick = async () => { clearInterval(sessTimer); const mins = Math.max(1, Math.round((sess.total - sess.left) / 60)); const rec = { id: uid(), subjectId: sess.subjectId, started: sess.started, minutes: mins, cards: sess.cards.length, quizRight: sess.quizRight, quizN: sess.quiz.length, notes: sess.notes }; await put("sessions", rec); sessions.push(rec); if (sess.block && sess.block.id) { st.done[sess.block.id] = true; await saveSt(); } sess = null; replan(); render(); };
  const sh = $("#seshow"); if (sh) sh.onclick = () => { sess.shown = true; drawSession(v); };
  v.querySelectorAll("[data-sq]").forEach((b) => b.onclick = async () => { const nd = gradeCard(c, +b.dataset.sq); await put("cards", nd); cards[cards.findIndex((x) => x.id === c.id)] = nd; sess.cards.shift(); sess.shown = false; await saveSt(); drawSession(v); });
  v.querySelectorAll("[data-qk]").forEach((b) => b.onclick = async () => { const ok = +b.dataset.qk === q.answer; if (ok) sess.quizRight++; const a = { id: uid(), topicId: q.topicId, topic: q.topic, subjectId: q.subjectId, correct: ok, at: Date.now() }; await put("attempts", a); attempts.push(a); $("#seex").innerHTML = `<p class="mut">${esc(q.explain || "")}</p><button class="b" id="seqn">${sess.qi + 1 >= sess.quiz.length ? "Finish" : "Next"}</button>`; $("#seqn").onclick = () => { sess.qi++; drawSession(v); }; });
}

const views = {
  today(v) {
    if (!st.subjects.length) { v.innerHTML = `<section class="hero">
      <p class="eyebrow" style="justify-content:center">Local first study planner</p>
      <h1>Turn PDFs into a <em>plan</em> that <span class="thin">actually</span> fits your week</h1>
      <p class="lede">Study Deck reads your PDFs on this device, builds a daily plan around your busy times, and turns notes into flashcards and quizzes. Everything works offline and stays on this device.</p>
      <div class="hero-cta"><button class="b" id="go">Get started in Setup</button><button class="b alt" id="goLib">How it works</button></div>
      <div class="fan-wrap"><div class="fan-hint">YOUR STUDY DECK, SPREAD OUT</div><div class="fan" aria-hidden="true">
        <div class="fcard white f1"><span class="fk">Daily plan</span><span class="ft">Small blocks,<br>every day</span><span class="fs">25 min focus / 5 min break</span></div>
        <div class="fcard peach f2"><span class="fk">Flashcards</span><span class="ft">Made from<br>your PDFs</span><span class="fs">Spaced repetition built in</span></div>
        <div class="fcard front"><span class="fk">Study Deck</span><span class="ft">PDFs in.<br>Plan out.</span><span class="fs">Offline &amp; private, on this device</span></div>
        <div class="fcard ink f3"><span class="fk">Quizzes</span><span class="ft">Practice<br>tests</span><span class="fs">Weak topics surface automatically</span></div>
        <div class="fcard cream f4"><span class="fk">AI optional</span><span class="ft">Gemini<br>helps</span><span class="fs">Explanations &amp; answer checks</span></div>
      </div></div>
      <div class="stats">
        <div class="stat"><b>25<i>min</i></b><span>focused blocks, 5 min breaks</span></div>
        <div class="stat"><b>100<i>%</i></b><span>offline, on-device storage</span></div>
        <div class="stat"><b>PDF</b><span>import in Library</span></div>
        <div class="stat"><b>AI</b><span>optional Gemini help</span></div>
      </div>
    </section>
    <section class="section"><div class="sec-head center"><p class="eyebrow" style="justify-content:center">How it works</p><h2>Three moves, then the plan runs itself</h2></div>
      <div class="layer-stack">
        <div class="lcard"><span class="l-tag t-butter">Set up</span><div><h3>Subjects first</h3><p>Add a subject with its test date, your daily minutes and busy times in Setup.</p></div><div class="pill-arrow">&#8594;</div></div>
        <div class="lcard"><span class="l-tag t-cobalt">Drop in</span><div><h3>Then a PDF</h3><p>Drop a PDF in Library. Text is extracted in your browser and stored on this device only.</p></div><div class="pill-arrow">&#8594;</div></div>
        <div class="lcard"><span class="l-tag t-vermilion">Plan out</span><div><h3>Then study the plan</h3><p>Short Learn, Practice and Review blocks, with a practice test on the last day. Tick them off as you go.</p></div><div class="pill-arrow">&#8594;</div></div>
      </div>
    </section>
    <section class="section"><div class="sec-head"><p class="eyebrow">What you get</p><h2>Built for exam season</h2></div>
      <div class="svc-rows">
        <div class="svc"><span class="mono m-cobalt" aria-hidden="true">P</span><div><h3>Daily plan</h3><p>Blocks scheduled around your busy times, not over them.</p></div><div class="pill-arrow">&#8594;</div></div>
        <div class="svc"><span class="mono m-butter" aria-hidden="true">R</span><div><h3>Flashcards &amp; quizzes</h3><p>Auto-made from your PDFs with spaced repetition. Weak topics surface in Progress.</p></div><div class="pill-arrow">&#8594;</div></div>
        <div class="svc"><span class="mono m-vermilion" aria-hidden="true">A</span><div><h3>Ask &amp; AI help</h3><p>Search your notes, or turn on Gemini for explanations and answer checking.</p></div><div class="pill-arrow">&#8594;</div></div>
      </div>
    </section>
    <section class="section"><div class="accent-panel"><p class="eyebrow">Why it stays local</p><h2>Your PDFs never leave this device</h2><p class="mut">No uploads, no account, no cloud copy. IndexedDB stores everything in this browser, on this phone or laptop, and keeps working in airplane mode.</p>
      <div class="accent-grid">
        <div class="accent-tile"><b>0</b><span>PDFs uploaded anywhere</span></div>
        <div class="accent-tile"><b>100%</b><span>of data stored on-device</span></div>
        <div class="accent-tile"><b>JSON</b><span>backup you can export anytime</span></div>
      </div></div>
    </section>`; $("#go").onclick = () => { tab = "setup"; render(); }; $("#goLib").onclick = () => { tab = "library"; render(); }; return; }
    const key = dstr(new Date()); const d = plan.days.find((x) => x.date === key);
    const due = dueCards(cards).length;
    const tests = st.subjects.filter((s) => s.testDate).map((s) => { const n = Math.round((parseD(s.testDate) - parseD(key)) / 86400000); return `${esc(s.name)}: ${n < 0 ? "passed" : n === 0 ? "TODAY" : n + " days"}`; });
    v.innerHTML = `<div class="card"><b>Countdown</b><div class="mut">${tests.join(" | ")}</div></div>${plan.warnings.map((w) => `<div class="warn">${esc(w)}</div>`).join("")}<div class="card row"><div>Cards due: <b>${due}</b></div><button class="b alt" id="rev">Review cards</button><button class="b" id="focusNow">Start focus</button></div><h2 style="margin-bottom:0">Today</h2>${d ? dayHTML(d) : '<div class="card mut">No study days left. Add a future test date in Setup.</div>'}${carriedHTML()}`;
    $("#rev").onclick = () => { tab = "cards"; render(); }; $("#focusNow").onclick = () => { tab = "session"; render(); }; bindChecks(v); bindCarried(v);
  },
  plan(v) {
    v.innerHTML = `<div class="row"><button class="b alt" id="rp">Rebuild plan</button></div>` + plan.warnings.map((w) => `<div class="warn">${esc(w)}</div>`).join("") + carriedHTML() + plan.days.map((d) => `<h2>${parseD(d.date).toDateString()}</h2>${dayHTML(d)}`).join("");
    $("#rp").onclick = () => { replan(); render(); }; bindChecks(v); bindCarried(v);
  },

  session(v) {
    if (sess) { drawSession(v); return; }
    const todayKey = dstr(new Date()); const todayBlk = (plan.days.find((x) => x.date === todayKey) || { blocks: [] }).blocks.find((b) => !b.done) || carried.find((b) => !b.unscheduled);
    v.innerHTML = `<div class="card"><h2>Focus session (offline)</h2><p class="mut">Timer, notes, due cards and a short quiz. Works with no AI and no network.</p>
    ${st.subjects.length ? `<label>Subject<select id="fesub"><option value="">Any due cards, else next planned</option>${st.subjects.map((s) => `<option value="${s.id}" ${todayBlk && todayBlk.subjectId === s.id ? "selected" : ""}>${esc(s.name)}</option>`).join("")}</select></label><div class="row"><label>Minutes<input type="number" id="femin" min="5" step="5" value="${Math.max(5, st.dailyMinutes || 25)}"></label><label>Quiz questions<input type="number" id="fequiz" min="1" max="10" value="3"></label></div>
    ${todayBlk ? `<div class="mut">Up next: ${esc(todayBlk.subject)} ${esc(todayBlk.label)} ${todayBlk.start} to ${todayBlk.end}</div>` : ""}
    <button class="b" id="fgo">Start session</button>` : `<div class="mut">Add a subject in Setup first.</div>`}
    </div>${sessions.length ? `<div class="card"><b>Recent sessions</b>${sessions.slice(-6).reverse().map((s) => `<div class="mut">${new Date(s.started).toLocaleDateString()} ${esc(subName(s.subjectId))} ${s.minutes} min, ${s.cards} cards, quiz ${s.quizRight}/${s.quizN}</div>`).join("")}</div>` : ""}`;
    if (!st.subjects.length) return;
    $("#fgo").onclick = () => { startSession($("#fesub").value, todayBlk && $("#fesub").value === todayBlk.subjectId ? todayBlk : null, { minutes: +$("#femin").value || 25, quizN: +$("#fequiz").value || 3 }); render(); };
  },
  library(v) {
    if (!st.subjects.length) { v.innerHTML = `<div class="card">Add a subject in Setup first.</div>`; return; }
    const bm = marks.filter((m) => m.kind === "bookmark");
    v.innerHTML = `<div class="card"><h2>Import PDF</h2><select id="sub">${st.subjects.map((s) => `<option value="${s.id}">${esc(s.name)}</option>`).join("")}</select><div class="row"><label class="b" for="pdf">Choose PDF</label><label class="b alt" for="pdfm">Choose several</label></div><input type="file" id="pdf" style="position:absolute;opacity:0;width:1px;height:1px"><input type="file" id="pdfm" multiple style="position:absolute;opacity:0;width:1px;height:1px"><div id="prog" class="mut">PDFs are read in your browser and stored on this device only. Scanned (image) PDFs have no text and cannot be read without AI. Cloze cards are auto-made too.</div></div>
    ${bm.length ? `<div class="card"><b>Bookmarks</b>${bm.map((m) => `<div class="row"><span>${esc(m.label)} <span class="mut">${esc(m.page ? "p." + m.page : "")}</span></span><button class="b alt" data-open-guide="${m.sectionId}">Open</button></div>`).join("")}</div>` : ""}
    ${docs.map((d) => `<div class="card"><b>${esc(d.name)}</b> <span class="mut">${esc(subName(d.subjectId))}, ${d.pages} pages, ${d.sections.length} sections${d.blob ? ", original PDF kept" : ""}</span><div class="mut">${d.sections.slice(0, 6).map((s) => esc(s.title)).join(" | ")}</div><button class="b alt" data-gen="${d.id}">Make cards</button><button class="b alt" data-cloze="${d.id}">Fill-in blanks</button>${ai.ready ? `<button class="b alt" data-aigen="${d.id}">AI cards</button>` : ""}<button class="b alt" data-guide="${d.id}">Study guide</button><button class="b bad" data-del="${d.id}">Delete</button></div>`).join("") || '<div class="card mut">No PDFs yet.</div>'}
    <div class="card" id="guideCard"><h2>Study guide (searchable text)</h2><div class="row"><input id="gq" placeholder="Search your PDFs for a phrase"><button class="b" id="gsearch">Search</button></div><div id="gout"></div><div id="gsec"></div></div>`;
    const onPick = async (e) => { const fs = Array.from(e.target.files || []); const sub = $("#sub").value; e.target.value = ""; for (const f of fs) await importPdf(f, sub); render(); };
    $("#pdf").onchange = onPick; $("#pdfm").onchange = onPick;
    v.querySelectorAll("[data-gen]").forEach((b) => b.onclick = async () => { const d = docs.find((x) => x.id === b.dataset.gen); const n = await genCards(d); b.textContent = `+${n} cards`; });
    v.querySelectorAll("[data-cloze]").forEach((b) => b.onclick = async () => { const d = docs.find((x) => x.id === b.dataset.cloze); const have = new Set(cards.map((c) => c.q)); let n = 0; for (const s of d.sections) for (const c of makeClozeCards(s, d.subjectId)) { if (have.has(c.q)) continue; have.add(c.q); await put("cards", c); cards.push(c); n++; } b.textContent = `+${n} blanks`; });
    v.querySelectorAll("[data-aigen]").forEach((b) => b.onclick = async () => { const d = docs.find((x) => x.id === b.dataset.aigen); b.textContent = "working..."; try { const n = await aiCards(d); b.textContent = `+${n} AI cards`; } catch (e) { b.textContent = e.message; } });
    v.querySelectorAll("[data-guide]").forEach((b) => b.onclick = () => { guideSel = docs.find((x) => x.id === b.dataset.guide).sections[0].id; drawGuide(v); });
    v.querySelectorAll("[data-open-guide]").forEach((b) => b.onclick = () => { guideSel = b.dataset.openGuide; drawGuide(v); });
    $("#gsearch").onclick = () => {
      const q = $("#gq").value; const hits = docSearch(q, allSecs());
      $("#gout").innerHTML = hits.length ? hits.map(({ section, hits: hs }) => `<div class="card"><div class="row"><div class="mut">${esc(section.title)}${section.page ? ` | p.${section.page}` : ""}</div><button class="b alt" data-gopen="${section.id}">Open section</button></div>${hs.map((h) => `<div class="mut">${esc(h.snippet)}</div>`).join("<hr>")}</div>`).join("") : '<div class="mut">Nothing found.</div>';
      $("#gout").querySelectorAll("[data-gopen]").forEach((x) => x.onclick = () => { guideSel = x.dataset.gopen; drawGuide(v); });
    };

    if (guideSel) drawGuide(v);
    v.querySelectorAll("[data-del]").forEach((b) => b.onclick = async () => { if (!confirm("Delete this PDF and its cards?")) return; const d = docs.find((x) => x.id === b.dataset.del); for (const c of cards.filter((c) => d.sections.some((s) => s.id === c.topicId))) await del("cards", c.id); await del("docs", d.id); await load(); render(); });
  },

  cards(v) {
    const qs = queueStats(cards);
    v.innerHTML = `<div class="card"><b>Due queue</b><div class="mut">${qs.due} due now, ${qs.overdue} overdue, ${qs.newCards} new, ${qs.future} saved for later. Total ${qs.total} cards.</div><div class="bar"><i style="width:${qs.total ? Math.round((qs.due / qs.total) * 100) : 0}%"></i></div></div>`;
    const due = dueQueue(cards);
    if (!cards.length) { v.innerHTML += `<div class="card">No cards yet. Import a PDF in Library and tap Make cards.</div>`; return; }
    if (!due.length) { v.innerHTML += `<div class="card">All caught up. ${cards.length} cards total.</div>`; return; }
    const c = due[0]; let shown = false, editing = false;
    const draw = () => {
      v.querySelector("#dueCard")?.remove();
      const wrap = document.createElement("div");
      wrap.id = "dueCard";
      wrap.innerHTML = `<div class="mut">${due.length} due | ${esc(sourceLabel(c))}</div><div class="card"><h2>${esc(c.q)}</h2>${shown ? `<p>${esc(c.a)}</p><div class="row"><button class="b bad" data-q="0">Again</button><button class="b alt" data-q="3">Hard</button><button class="b" data-q="4">Good</button><button class="b alt" data-q="5">Easy</button></div><div class="row"><button class="b alt" id="cedit">Edit card</button><button class="b bad" id="cdel">Delete</button></div>` : `<button class="b" id="show">Show answer</button>`}
      ${editing ? `<div class="row"><input id="cq" value="${esc(c.q)}"><input id="ca" value="${esc(c.a)}"><button class="b" id="csave">Save</button></div>` : ""}</div>`;
      v.appendChild(wrap);
      if (!shown) wrap.querySelector("#show").onclick = () => { shown = true; draw(); };
      else {
        wrap.querySelectorAll("[data-q]").forEach((b) => b.onclick = async () => { const q = +b.dataset.q; const n = gradeCard(c, q); await put("cards", n); Object.assign(c, n); cards[cards.findIndex((x) => x.id === c.id)] = n; if (q === 0) st.weak[c.topicId] = true; await saveSt(); render(); });
        wrap.querySelector("#cedit").onclick = () => { editing = !editing; draw(); };
        wrap.querySelector("#cdel").onclick = async () => { if (!confirm("Delete this card?")) return; const n = deleteCard(c); await put("cards", n); cards[cards.findIndex((x) => x.id === c.id)] = n; render(); };
        if (editing) wrap.querySelector("#csave").onclick = async () => { const n = editCard(c, { q: wrap.querySelector("#cq").value, a: wrap.querySelector("#ca").value }); await put("cards", n); cards[cards.findIndex((x) => x.id === c.id)] = n; editing = false; shown = false; draw(); };
      }
    };
    draw();
  },
  quiz(v) {
    v.innerHTML = `<div class="card"><h2>Practice test</h2><select id="qs"><option value="">All subjects</option>${st.subjects.map((s) => `<option value="${s.id}">${esc(s.name)}</option>`).join("")}</select><select id="qn"><option>5</option><option selected>10</option><option>20</option></select><label class="blk"><input type="checkbox" id="qnotes" checked><div class="t">Build some questions from my notes too</div></label><button class="b" id="start">Start</button>${ai.ready ? '<button class="b alt" id="aiq">AI quiz</button>' : ""}<div id="qerr" class="warn"></div></div><div id="qbox"></div>`;
    const pick = () => cards.filter((c) => !$("#qs").value || c.subjectId === $("#qs").value);
    $("#start").onclick = () => { const n = +$("#qn").value; const fromNotes = $("#qnotes").checked ? makeQuizFromNotes(allSecs().filter((x) => !$("#qs").value || x.subjectId === $("#qs").value), Math.max(0, n - 2)) : []; const q = [...makeQuiz(pick(), n), ...fromNotes].slice(0, n); if (q.length < 2) { $("#qerr").textContent = "Not enough cards or note sentences. Make cards from a PDF first."; return; } runQuiz(q); };
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
    <div class="card"><h2>Check-in for my agent</h2><p class="mut">What did I actually finish, where did I get stuck, and what do I want to try next.</p>
    <div class="row" id="ckinRow"><button class="b bad" data-ck="in">Missed today</button><button class="b alt" data-ck="bad">Studied badly</button><button class="b" data-ck="good">Did well</button><button class="b alt" data-ck="early">Finished early</button><button class="b alt" data-ck="more">Need more time</button></div>
    <div id="ckinOut" class="mut"></div>
    <div class="mut">Saying "missed it" or "studied badly" counts as not-done and the planner carries that block forward. "Did well" marks it done.</div></div>
    <div class="card"><h2>Backup</h2><div class="${backupStatus({lastExportAt: st.lastExportAt, lastImportAt: st.lastImportAt, docsWithPdf: docs.filter((d) => d.blob).length, docsTotal: docs.length}).tone === "warn" ? "warn" : "mut"}" id="bkStatus">${esc(backupStatus({lastExportAt: st.lastExportAt, lastImportAt: st.lastImportAt, docsWithPdf: docs.filter((d) => d.blob).length, docsTotal: docs.length}).text)}</div><button class="b" id="exp">Export JSON (with original PDFs)</button>${st.lastExportAt || st.snapAt ? '<button class="b alt" id="undo">Undo last import (restore snapshot)</button>' : ""}<input type="file" id="imp" accept="application/json"><div class="mut">Includes settings, extracted text, cards and progress, plus the original PDF files for every doc. Before any import, the app saves a snapshot of your current data so a bad import can be undone.</div><button class="b bad" id="wipe">Erase all data</button></div>
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
    const u = $("#undo"); if (u) u.onclick = restoreSnapshot;
    v.querySelectorAll("[data-ck]").forEach((b) => b.onclick = async () => {
      const k = b.dataset.ck;
      const todayKey = dstr(new Date());
      const todayBlk = (plan.days.find((x) => x.date === todayKey) || { blocks: [] }).blocks.find((x) => !x.done) || carried.find((x) => !x.unscheduled);
      if (!todayBlk) { $("#ckinOut").textContent = "Nothing open to check in for today. See you tomorrow, or finish a Focus session."; return; }
      if (k === "good") { st.done[todayBlk.id] = true; $("#ckinOut").textContent = "Nice. Marked done."; }
      if (k === "early" || k === "more") { st.dailyMinutes = Math.max(25, Math.min(240, (st.dailyMinutes || 90) + (k === "more" ? 25 : -25))); $("#ckinOut").textContent = `Daily time is now ${st.dailyMinutes} minutes.`; }
      if (k === "in" || k === "bad") { $("#ckinOut").textContent = "That block stays undone and will be carried over around your busy times and test dates."; }
      await saveSt(); replan(); render();
    });
    $("#imp").onchange = (e) => importJSON(e.target.files[0]);
    $("#wipe").onclick = async () => { if (!confirm("Erase everything on this device?")) return; for (const s of STORES) await clear(s); await load(); render(); };
  },
};

// ---------- actions ----------
function drawGuide(v) {
  const s = secById(guideSel); const box = $("#gsec"); if (!s || !box) return;
  const doc = docs.find((d) => d.sections.some((x) => x.id === s.id));
  const highlights = marks.filter((m) => m.kind === "highlight" && m.sectionId === s.id);
  const bm = marks.find((m) => m.kind === "bookmark" && m.sectionId === s.id);
  const hls = highlights.reduce((a, m) => a + [m.start, m.end], []).join(", ");
  box.innerHTML = `<div class="card"><div class="row"><b>${esc(s.title)}</b><span class="mut">From: ${esc(doc ? doc.name : "")}${s.page ? ` | p.${s.page}` : ""}</span></div>
  <div style="white-space:pre-wrap;line-height:1.6">${hl(s.text)}</div>
  <div class="row"><button class="b alt" id="ghlsel">Mark selected text</button><button class="b alt" id="gbm">${bm ? "Remove bookmark" : "Bookmark"}</button><button class="b alt" id="gfrom">Make question from this</button></div>
  <div class="mut">${highlights.length} highlight(s) saved on this device.</div></div>`;
  function hl(text) {
    let t = esc(text);
    for (const m of marks.filter((m) => m.kind === "highlight" && m.sectionId === s.id).sort((a, b) => b.start - a.start)) {
      const before = t.slice(0, m.start), mid = t.slice(m.start, m.end), after = t.slice(m.end);
      t = before + `<mark>${mid}</mark>` + after;
    }
    return t;
  }
  $("#ghlsel").onclick = async () => {
    const sel = window.getSelection(); const range = sel && sel.getRangeAt && sel.rangeCount ? sel.getRangeAt(0) : null;
    const txt = sel ? sel.toString().trim() : ""; if (!txt || txt.length < 3) return alert("Select some text in the section first, then tap Mark.");
    const idx = s.text.indexOf(txt); if (idx < 0) return alert("Could not locate that selection in extracted text.");
    const m = { id: uid(), kind: "highlight", sectionId: s.id, start: idx, end: idx + txt.length, text: txt, page: s.page, created: Date.now() };
    await put("marks", m); marks.push(m); drawGuide(v);
  };
  $("#gbm").onclick = async () => { if (bm) { await del("marks", bm.id); marks = marks.filter((m) => m.id !== bm.id); } else { const m = { id: uid(), kind: "bookmark", sectionId: s.id, label: s.title, page: s.page, created: Date.now() }; await put("marks", m); marks.push(m); } drawGuide(v); };
  $("#gfrom").onclick = async () => { const have = new Set(cards.map((c) => c.q)); let n = 0; for (const c of makeClozeCards(s, s.subjectId || (doc && doc.subjectId), 6)) { if (have.has(c.q)) continue; have.add(c.q); await put("cards", c); cards.push(c); n++; } hline(`+${n} fill-in cards in Cards tab`); };
}
function hline(t) { const x = $("#gout"); if (x) x.innerHTML = `<div class="warn">${esc(t)}</div>`; }

async function importPdf(file, subjectId) {
  const prog = $("#prog");
  try {
    prog.textContent = `Reading ${file.name}...`;
    const pdfjs = await import("/vendor/pdf.min.mjs");
    pdfjs.GlobalWorkerOptions.workerSrc = "/vendor/pdf.worker.min.mjs";
    const buf = await file.arrayBuffer();
    const head = new Uint8Array(buf.slice(0, 1024)); let isPdf = false; for (let i = 0; i + 4 <= head.length; i++) if (head[i] === 37 && head[i+1] === 80 && head[i+2] === 68 && head[i+3] === 70) { isPdf = true; break; }
    if (!isPdf) { prog.textContent = `${file.name}: not a PDF file.`; alert(`${file.name} is not a PDF.`); return; }
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
  const pdfs = [];
  for (const d of docs) if (d.blob) pdfs.push({ docId: d.id, name: d.name, mime: d.blob.type || "application/pdf", data: await b64(d.blob) });
  const out = { app: "study-deck", version: BACKUP_VERSION, exported: new Date().toISOString(), state: st, docs: docs.map(({ blob, ...d }) => d), cards, attempts, sessions, marks, pdfs };
  const a = document.createElement("a"); a.href = URL.createObjectURL(new Blob([JSON.stringify(out)], { type: "application/json" })); a.download = `study-deck-${dstr(new Date())}.json`; a.click();
  st.lastExportAt = Date.now(); await saveSt();
}
async function snapshot() {
  const pdfs = [];
  for (const d of docs) if (d.blob) pdfs.push({ docId: d.id, name: d.name, mime: d.blob.type || "application/pdf", data: await b64(d.blob) });
  const snap = { app: "study-deck", version: BACKUP_VERSION, exported: new Date().toISOString(), state: st, docs: docs.map(({ blob, ...d }) => d), cards, attempts, sessions, marks, pdfs };
  await put("kv", { k: "snapshot", v: snap });
}
async function applyBackup(o) {
  const pdfById = Object.fromEntries((o.pdfs || []).map((p) => [p.docId, p]));
  for (const s of STORES) await clear(s);
  st = { ...DEF, ...o.state };
  await put("kv", { k: "state", v: st });
  for (const d of o.docs || []) {
    const p = pdfById[d.id];
    const nd = p ? { ...d, blob: new Blob([blobFromB64(p.data)], { type: p.mime || "application/pdf" }) } : d;
    await put("docs", nd);
  }
  for (const c of o.cards || []) await put("cards", c);
  for (const a of o.attempts || []) await put("attempts", a);
  for (const a of o.sessions || []) await put("sessions", a);
  for (const a of o.marks || []) await put("marks", a);
  st.lastImportAt = Date.now(); await saveSt();
}
async function importJSON(f) {
  if (!f) return;
  try {
    const o = validateImport(JSON.parse(await f.text()));
    if (!confirm("This replaces all data on this device. A snapshot of your current data is saved first so you can undo. Continue?")) return;
    await snapshot(); st.snapAt = Date.now(); await saveSt();
    await applyBackup(o);
    await load(); render();
  } catch (e) { alert("Import failed: " + e.message); }
}
async function restoreSnapshot() {
  const kv = (await all("kv")).find((x) => x.k === "snapshot");
  if (!kv || !kv.v) return alert("No snapshot saved yet.");
  if (!confirm("Restore the snapshot from before the last import? Current data will be replaced (and a new snapshot is saved first).")) return;
  await snapshot(); await applyBackup(kv.v); await load(); render();
}

if ("serviceWorker" in navigator) navigator.serviceWorker.register("/sw.js").catch(() => {});
if (navigator.storage && navigator.storage.persist) navigator.storage.persist().catch(() => {});
load().then(() => { const fy = $("#footYear"); if (fy) fy.textContent = "\u00a9 " + new Date().getFullYear() + " Study Deck. Local first."; initWheel(); render(); checkAI(); });
