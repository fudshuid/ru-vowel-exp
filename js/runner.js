/* Browser runner: screens, Web Audio playback, data saving and resume.
   All design logic lives in design.js; all sounds are synthesized in the
   browser by synth.js (no audio files are downloaded).                       */
(function () {
  "use strict";
  const S = window.VowelSynth, D = window.VowelDesign, C = window.CONFIG, T = window.TEXT;
  const app = document.getElementById("app");
  const URLP = new URLSearchParams(location.search);
  C.TEST_MODE = URLP.get("test") === "1";
  if (C.TEST_MODE) { C.MIN_BREAK_S = 2; C.HP_TRIALS = 2; C.HP_PASS = 1; }
  const STORE_KEY = "ru_vowel_state_" + C.EXP_VERSION + (C.TEST_MODE ? "_test" : "");
  const G = D.grid();

  // ------------------------------------------------------------ utilities
  const sleep = ms => new Promise(r => setTimeout(r, ms));
  const html = s => { app.innerHTML = s; window.scrollTo(0, 0); };
  const $ = id => document.getElementById(id);
  let keyHandler = null;
  document.addEventListener("keydown", e => { if (keyHandler) keyHandler(e); });
  function digitOf(e) {                       // layout-independent digit / key codes
    const m = /^(Digit|Numpad)([0-9])$/.exec(e.code || "");
    if (m) return +m[2];
    const n = parseInt(e.key, 10); return isNaN(n) ? null : n;
  }
  const isReplay = e => e.code === "KeyR" || e.key === "r" || e.key === "R" || e.key === "к" || e.key === "К";
  const isSpace = e => e.code === "Space" || e.key === " ";
  function randomId(n) {
    const ch = "abcdefghjkmnpqrstuvwxyz23456789"; let s = "";
    const a = new Uint32Array(n); (window.crypto || window.msCrypto).getRandomValues(a);
    for (let i = 0; i < n; i++) s += ch[a[i] % ch.length];
    return s;
  }
  function waitSpaceOrButton(btnId) {
    return new Promise(res => {
      const done = () => { keyHandler = null; res(); };
      if (btnId && $(btnId)) $(btnId).onclick = done;
      keyHandler = e => { if (isSpace(e)) { e.preventDefault(); done(); } };
    });
  }

  // ------------------------------------------------------------ state + persistence
  let st = null;
  function save() { try { localStorage.setItem(STORE_KEY, JSON.stringify(st)); } catch (e) { /* quota: ignore */ } }
  function load() { try { return JSON.parse(localStorage.getItem(STORE_KEY) || "null"); } catch (e) { return null; } }
  function newState() {
    const pid = (URLP.get("pid") || "").replace(/[^A-Za-z0-9_-]/g, "").slice(0, 20);
    return {
      sid: (pid ? pid + "_" : "") + randomId(8), seed: Math.floor(Math.random() * 2 ** 31), version: C.EXP_VERSION,
      test_mode: C.TEST_MODE, started: new Date().toISOString(), stage: "consent",
      meta: { user_agent: navigator.userAgent, screen: [screen.width, screen.height], lang: navigator.language,
              f3_rule: C.F3_RULE, url_pid: pid || null },
      questionnaire: null, headphone: [], hp_attempts: 0, hp_passed: null,
      p1: null, ident: [], p1_practice: [], design: null, p2: null, oddity: [], p2_practice: [],
      end: null, uploads: {}, finished: null,
    };
  }

  // ------------------------------------------------------------ audio
  let ctx = null;
  const bufCache = new Map();
  async function ensureAudio() {
    if (!ctx) {
      const AC = window.AudioContext || window.webkitAudioContext;
      ctx = new AC();
    }
    if (ctx.state === "suspended") await ctx.resume();
  }
  function vowelBuffer(b1, b2) {
    const key = b1.toFixed(5) + "," + b2.toFixed(5);
    if (bufCache.has(key)) return bufCache.get(key);
    const r = S.synthBark(b1, b2, { f3rule: C.F3_RULE });
    const buf = ctx.createBuffer(1, r.x.length, r.fs);
    buf.getChannelData(0).set(r.x);
    bufCache.set(key, buf);
    return buf;
  }
  function playAt(buf, when, gainDb) {
    const s = ctx.createBufferSource(); s.buffer = buf;
    const g = ctx.createGain(); g.gain.value = Math.pow(10, (gainDb || 0) / 20);
    s.connect(g); g.connect(ctx.destination); s.start(when); return s;
  }
  function toneBuffer(antiphase, gainDb) {      // 200 Hz, 1 s, stereo (Woods et al. 2017)
    const fs = ctx.sampleRate, n = Math.round(fs * 1.0), nr = Math.round(fs * 0.1);
    const buf = ctx.createBuffer(2, n, fs), L = buf.getChannelData(0), R = buf.getChannelData(1);
    const a = 0.12 * Math.pow(10, gainDb / 20);
    for (let i = 0; i < n; i++) {
      let env = 1;
      if (i < nr) env = 0.5 - 0.5 * Math.cos(Math.PI * i / nr);
      else if (i > n - nr) env = 0.5 - 0.5 * Math.cos(Math.PI * (n - i) / nr);
      const v = a * env * Math.sin(2 * Math.PI * 200 * i / fs);
      L[i] = v; R[i] = antiphase ? -v : v;
    }
    return buf;
  }

  // ------------------------------------------------------------ data export / upload
  function toCSV(rows) {
    if (!rows.length) return "";
    const cols = []; rows.forEach(r => Object.keys(r).forEach(k => { if (!cols.includes(k)) cols.push(k); }));
    const esc = v => {
      if (v === null || v === undefined) return "";
      if (typeof v === "object") v = JSON.stringify(v);
      v = String(v); return /[",\n]/.test(v) ? '"' + v.replace(/"/g, '""') + '"' : v;
    };
    return [cols.join(",")].concat(rows.map(r => cols.map(c => esc(r[c])).join(","))).join("\n");
  }
  function sessionJSON() {
    return JSON.stringify({ sid: st.sid, version: st.version, seed: st.seed, test_mode: st.test_mode, started: st.started,
      finished: st.finished, meta: st.meta, questionnaire: st.questionnaire, headphone: st.headphone, hp_passed: st.hp_passed,
      hp_attempts: st.hp_attempts, part1_first_half: st.p1 && st.p1.firstHalf, design: st.design,
      p1_practice: st.p1_practice, p2_practice: st.p2_practice, end: st.end, uploads: st.uploads, config: C }, null, 1);
  }
  async function upload(filename, text) {
    if (!C.DATAPIPE_ID) { st.uploads[filename] = "skipped(no DATAPIPE_ID)"; save(); return false; }
    for (let attempt = 1; attempt <= 3; attempt++) {
      try {
        const r = await fetch(C.DATAPIPE_URL, {
          method: "POST", headers: { "Content-Type": "application/json", Accept: "*/*" },
          body: JSON.stringify({ experimentID: C.DATAPIPE_ID, filename: filename, data: text }) });
        if (r.ok) { st.uploads[filename] = "ok"; save(); return true; }
        st.uploads[filename] = "http " + r.status;
      } catch (e) { st.uploads[filename] = "error " + e.message; }
      save(); await sleep(1000 * attempt);
    }
    return false;
  }
  function downloadAll() {
    const parts = { ident: toCSV(st.ident), oddity: toCSV(st.oddity), session: sessionJSON() };
    const blob = new Blob([JSON.stringify({ sid: st.sid, files: parts })], { type: "application/json" });
    const a = document.createElement("a"); a.href = URL.createObjectURL(blob); a.download = "vowel_exp_" + st.sid + ".json"; a.click();
  }

  // ------------------------------------------------------------ screens
  function header(title) {
    return `${C.TEST_MODE ? '<div class="testbar">TEST MODE — shortened run; data files are prefixed TEST_</div>' : ""}<h1>${title}</h1>`;
  }
  const fileName = base => (C.TEST_MODE ? "TEST_" : "") + st.sid + "_" + base;

  function screenConsent() {
    const mobile = /Android|iPhone|iPad|iPod|Mobile/i.test(navigator.userAgent) || (("ontouchstart" in window) && screen.width < 900);
    html(`${header(T.title)}${mobile ? `<p class="warn">${T.mobile_warn}</p>` : ""}${T.welcome}
      <p><label><input type="checkbox" id="ok"> ${T.consent_box}</label></p>
      <div class="row"><button class="big" id="go" disabled>${T.start}</button></div>`);
    $("ok").onchange = () => { $("go").disabled = !$("ok").checked; };
    $("go").onclick = async () => { await ensureAudio(); st.consent_time = new Date().toISOString(); st.stage = "questionnaire"; save(); route(); };
  }

  function radios(name, opts) {
    return opts.map((o, i) => `<label class="opt"><input type="radio" name="${name}" value="${o}"> ${o}</label>`).join(" ");
  }
  function screenQuestionnaire() {
    html(`${header(T.q_title)}
      <div class="form">
      <p>${T.q_age}<br><input type="number" id="age" min="16" max="99" style="width:90px"></p>
      <p>${T.q_gender}<br>${radios("gender", T.q_gender_opts)}</p>
      <p>${T.q_native}<br><input type="text" id="native" value="русский"></p>
      <p>${T.q_region}<br><input type="text" id="region"></p>
      <p>${T.q_other}<br><input type="text" id="other"></p>
      <p>${T.q_hearing}<br>${radios("hearing", T.q_hearing_opts)}</p>
      <p>${T.q_device}<br>${radios("device", T.q_device_opts)}</p>
      </div><p class="warn" id="msg"></p>
      <div class="row"><button class="big" id="go">${T.next}</button></div>`);
    $("go").onclick = () => {
      const val = n => { const e = document.querySelector(`input[name="${n}"]:checked`); return e ? e.value : null; };
      const q = { age: $("age").value, gender: val("gender"), native: $("native").value.trim(), region: $("region").value.trim(),
                  other_languages: $("other").value.trim(), hearing: val("hearing"), device: val("device") };
      if (!q.age || !q.gender || !q.native || !q.hearing || !q.device) { $("msg").textContent = T.q_required; return; }
      st.questionnaire = q; st.stage = "volume"; save(); route();
    };
  }

  function screenVolume() {
    html(`${header(T.vol_title)}${T.vol_text}
      <div class="row"><button class="big" id="play">${T.vol_play}</button></div>
      <div class="row"><button class="big" id="go" disabled>${T.next}</button></div>`);
    let plays = 0;
    $("play").onclick = async () => {
      await ensureAudio();
      const t0 = ctx.currentTime + 0.1;   // a, i, u from the middle of the space
      [[6.6, 10.2], [2.6, 13.7], [3.1, 6.7]].forEach((p, i) => playAt(vowelBuffer(p[0], p[1]), t0 + i * 0.6, 0));
      plays++; $("go").disabled = false;
    };
    $("go").onclick = () => { st.meta.volume_plays = plays; st.stage = "headphone"; save(); route(); };
  }

  async function screenHeadphone() {
    await ensureAudio();
    st.hp_attempts += 1;
    const attempt = st.hp_attempts, rows = [];
    html(`${header(T.hp_title)}${T.hp_text.replace("{n}", C.HP_TRIALS)}
      <div class="row"><button class="big" id="start">${T.hp_play}</button></div>`);
    await new Promise(r => { $("start").onclick = r; });
    for (let t = 0; t < C.HP_TRIALS; t++) {
      const order = D.shuffle(["std", "quiet", "anti"], Math.random);
      html(`${header(T.hp_title)}<p class="center muted">${t + 1} / ${C.HP_TRIALS}</p>
        <div class="row" style="gap:28px;margin-top:30px">${[1, 2, 3].map(i => `<div class="box" id="b${i}">${i}</div>`).join("")}</div>
        <p class="center" id="q" style="visibility:hidden">${T.hp_q}</p>`);
      const boxes = [1, 2, 3].map(i => $("b" + i));
      const t0 = ctx.currentTime + 0.4;
      order.forEach((k, i) => {
        const when = t0 + i * 1.5;
        playAt(toneBuffer(k === "anti", k === "quiet" ? -6 : 0), when, 0);
        setTimeout(() => boxes[i].classList.add("lit"), (when - ctx.currentTime) * 1000);
        setTimeout(() => boxes[i].classList.remove("lit"), (when + 1.0 - ctx.currentTime) * 1000);
      });
      await sleep((t0 + 2 * 1.5 + 1.0 - ctx.currentTime) * 1000);
      $("q").style.visibility = "visible";
      const resp = await new Promise(res => {
        boxes.forEach((b, i) => { b.classList.add("click"); b.onclick = () => res(i + 1); });
        keyHandler = e => { const d = digitOf(e); if (d >= 1 && d <= 3) res(d); };
      });
      keyHandler = null;
      rows.push({ attempt: attempt, trial: t + 1, order: order.join("|"), response: resp, correct: order[resp - 1] === "quiet" ? 1 : 0 });
      await sleep(300);
    }
    st.headphone = st.headphone.concat(rows);
    const nOk = rows.reduce((s, r) => s + r.correct, 0);
    st.hp_passed = nOk >= C.HP_PASS;
    save();
    if (st.hp_passed || attempt >= 2) { st.stage = "p1_instr"; save(); route(); return; }
    html(`${header(T.hp_title)}${T.hp_fail}
      <div class="row"><button class="big" id="retry">${T.hp_retry}</button><button id="skip">${T.hp_continue_anyway}</button></div>`);
    $("retry").onclick = () => route();
    $("skip").onclick = () => { st.stage = "p1_instr"; save(); route(); };
  }

  function screenP1Instr() {
    html(`${header(T.p1_title)}${T.p1_text}<div class="row"><button class="big" id="go">${T.start}</button></div>`);
    $("go").onclick = () => {
      if (!st.p1) {
        const rng = D.mulberry32(st.seed);
        const o = D.part1Order(G, C, rng);
        // 3 practice tokens: random grid points (not analysed)
        const prac = D.shuffle(G, rng).slice(0, 3).map(g => ({ block: 0, half: g.half, grid_index: g.index, kind: "practice" }));
        st.p1 = { order: o.order, firstHalf: o.firstHalf, practice: prac, idx: 0, pidx: 0 };
      }
      st.stage = "p1"; save(); route();
    };
  }

  /* one classification trial; resolves to a row (without bookkeeping fields) */
  async function classifyTrial(g, progress) {
    const labelBtns = D.LABELS.map((l, i) => `<button class="big lab" disabled data-k="${l.key}">${l.cyr}<br><span class="muted"><kbd>${i + 1}</kbd></span></button>`).join("");
    const goodBtns = [1, 2, 3, 4, 5, 6, 7].map(v => `<button class="big good" data-g="${v}">${v}</button>`).join("");
    html(`${header(T.p1_title)}<div class="bar"><div style="width:${(100 * progress).toFixed(1)}%"></div></div>
      <p class="center">${T.p1_q_label}</p><div class="row" id="labs">${labelBtns}</div>
      <div id="gq" style="visibility:hidden"><p class="center" id="gtext"></p><div class="row">${goodBtns}</div>
      <p class="center muted">${T.p1_scale}</p></div>
      <div class="row"><button id="rep">${T.replay} (<kbd>R</kbd>)</button></div>`);
    const buf = vowelBuffer(g.F1_bark, g.F2_bark);
    let plays = 0, label = null, goodness = null, tLabel = null, tGood = null;
    const play = () => { if (plays < C.ID_MAX_PLAYS) { plays++; playAt(buf, ctx.currentTime + 0.05, 0); } if (plays >= C.ID_MAX_PLAYS) $("rep").disabled = true; };
    await sleep(300); play(); const t0 = performance.now();
    await new Promise(resolve => {
      const pickLabel = key => {
        if (label !== null) return;
        label = key; tLabel = performance.now() - t0;
        app.querySelectorAll(".lab").forEach(b => { b.disabled = true; if (b.dataset.k === key) b.classList.add("chosen"); });
        $("gtext").innerHTML = T.p1_q_good(D.LABELS.find(l => l.key === key).cyr);
        $("gq").style.visibility = "visible";
      };
      const pickGood = v => { if (label === null || goodness !== null) return; goodness = v; tGood = performance.now() - t0; resolve(); };
      app.querySelectorAll(".lab").forEach(b => b.onclick = () => pickLabel(b.dataset.k));
      app.querySelectorAll(".good").forEach(b => b.onclick = () => pickGood(+b.dataset.g));
      $("rep").onclick = play;
      keyHandler = e => {
        if (isReplay(e)) { play(); return; }
        const d = digitOf(e); if (d === null) return;
        if (label === null && d >= 1 && d <= D.LABELS.length) pickLabel(D.LABELS[d - 1].key);
        else if (label !== null && d >= 1 && d <= 7) pickGood(d);
      };
      app.querySelectorAll(".lab").forEach(x => { x.disabled = false; });   // respond only after the sound started
    });
    keyHandler = null;
    return { grid_index: g.index, half: g.half, F1_bark: g.F1_bark, F2_bark: g.F2_bark, F1_hz: +g.F1_hz.toFixed(1), F2_hz: +g.F2_hz.toFixed(1),
             label: label, goodness: goodness, n_plays: plays, rt_label_ms: Math.round(tLabel), rt_goodness_ms: Math.round(tGood) };
  }

  async function runP1() {
    await ensureAudio();
    const P = st.p1;
    while (P.pidx < P.practice.length) {
      const t = P.practice[P.pidx];
      const r = await classifyTrial(G[t.grid_index], 0);
      st.p1_practice.push(Object.assign({ sid: st.sid, trial: P.pidx + 1, kind: "practice" }, r)); P.pidx++; save();
      await sleep(250);
      if (P.pidx === P.practice.length) {
        html(`${header(T.p1_title)}<p>${T.practice_done}</p><p>${T.press_space}</p><div class="row"><button class="big" id="go">${T.cont}</button></div>`);
        await waitSpaceOrButton("go");
      }
    }
    const nMain = P.order.length;
    while (P.idx < nMain) {
      const t = P.order[P.idx];
      const r = await classifyTrial(G[t.grid_index], P.idx / nMain);
      st.ident.push(Object.assign({ sid: st.sid, trial: P.idx + 1, block: t.block, kind: t.kind }, r,
                    { f3_rule: C.F3_RULE, timestamp: new Date().toISOString(), version: C.EXP_VERSION }));
      P.idx++; save();
      await sleep(250);
      const next = P.order[P.idx];
      if (next && next.block === 2 && t.block === 1) {
        html(`${header(T.p1_title)}<p>${T.p1_half}</p><p>${T.press_space}</p><div class="row"><button class="big" id="go">${T.cont}</button></div>`);
        await waitSpaceOrButton("go");
      }
    }
    st.stage = "break"; save(); route();
  }

  async function screenBreak() {
    await ensureAudio();
    html(`${header(T.brk_title)}${T.brk_text}<p class="center muted" id="stat">${T.brk_preparing}</p>
      <div class="bar"><div id="pb" style="width:0%"></div></div><div class="row"><button class="big" id="go" style="visibility:hidden">${T.cont}</button></div>`);
    const tStart = performance.now();
    if (!st.design) {
      const rng = D.mulberry32((st.seed ^ 0x5bd1e995) >>> 0);
      const sel = D.selectAnchors(st.ident, G, C);
      const trials = D.part2Trials(sel.anchors, C, rng);
      const practice = D.practiceTrials(C, rng);
      st.design = { prototypes: sel.prototypes, anchors: sel.anchors, warnings: sel.warnings, computed: new Date().toISOString() };
      st.p2 = { trials: trials, practice: practice, idx: 0, pidx: 0 };
      save();
    }
    // synthesize every Part-2 sound now (also warms the cache after a resume)
    const all = st.p2.practice.concat(st.p2.trials);
    for (let i = 0; i < all.length; i++) {
      vowelBuffer(all[i].std_F1_bark, all[i].std_F2_bark); vowelBuffer(all[i].odd_F1_bark, all[i].odd_F2_bark);
      if (i % 20 === 0) { $("pb").style.width = (100 * i / all.length).toFixed(0) + "%"; await sleep(0); }
    }
    $("pb").style.width = "100%";
    st.design.synth_ms = Math.round(performance.now() - tStart); save();
    // upload Part-1 data now, so it is kept even if the participant stops during Part 2
    if (!st.uploads[fileName("part1_ident.csv")]) upload(fileName("part1_ident.csv"), toCSV(st.ident));
    const wait = Math.max(0, C.MIN_BREAK_S * 1000 - (performance.now() - tStart));
    await sleep(wait);
    $("stat").textContent = T.brk_ready; $("go").style.visibility = "visible";
    await waitSpaceOrButton("go");
    st.stage = "p2_instr"; save(); route();
  }

  function screenP2Instr() {
    html(`${header(T.p2_title)}${T.p2_text}<div class="row"><button class="big" id="go">${T.start}</button></div>`);
    $("go").onclick = () => { st.stage = "p2"; save(); route(); };
  }

  async function oddityTrial(t, progress, feedback) {
    html(`${header(T.p2_title)}<div class="bar"><div style="width:${(100 * progress).toFixed(1)}%"></div></div>
      <div class="row" style="gap:28px;margin-top:40px">${[1, 2, 3].map(i => `<div class="box" id="b${i}">${i}</div>`).join("")}</div>
      <p class="center" id="msg">&nbsp;</p>`);
    const boxes = [1, 2, 3].map(i => $("b" + i));
    const bs = vowelBuffer(t.std_F1_bark, t.std_F2_bark), bo = vowelBuffer(t.odd_F1_bark, t.odd_F2_bark);
    const dur = bs.duration, step = dur + C.ISI_MS / 1000, t0 = ctx.currentTime + 0.35;
    const rove = [0, 1, 2].map(() => +((2 * Math.random() - 1) * C.ROVE_DB).toFixed(2));
    for (let i = 0; i < 3; i++) {
      const when = t0 + i * step;
      playAt(i + 1 === t.odd_pos ? bo : bs, when, rove[i]);
      setTimeout(() => boxes[i].classList.add("lit"), (when - ctx.currentTime) * 1000);
      setTimeout(() => boxes[i].classList.remove("lit"), (when + dur - ctx.currentTime) * 1000);
    }
    await sleep((t0 + 2 * step + dur - ctx.currentTime) * 1000);
    $("msg").textContent = T.p2_q;
    const tR = performance.now();
    const resp = await new Promise(res => {
      boxes.forEach((b, i) => { b.classList.add("click"); b.onclick = () => res(i + 1); });
      keyHandler = e => { const d = digitOf(e); if (d >= 1 && d <= 3) res(d); };
    });
    keyHandler = null; boxes.forEach(b => { b.onclick = null; b.classList.remove("click"); });
    const rt = Math.round(performance.now() - tR), correct = resp === t.odd_pos ? 1 : 0;
    if (feedback) {
      boxes[t.odd_pos - 1].classList.add("correct"); if (!correct) boxes[resp - 1].classList.add("wrong");
      $("msg").textContent = correct ? T.p2_right : T.p2_wrong(t.odd_pos);
      await sleep(1100);
    }
    return { response: resp, correct: correct, rt_ms: rt, rove_db: rove.join("|") };
  }

  async function runP2() {
    await ensureAudio();
    const P = st.p2;
    while (P.pidx < P.practice.length) {
      const t = P.practice[P.pidx];
      const r = await oddityTrial(t, 0, true);
      st.p2_practice.push(Object.assign({ sid: st.sid, trial: P.pidx + 1 }, t, r)); P.pidx++; save();
      await sleep(C.ITI_MS);
      if (P.pidx === P.practice.length) {
        html(`${header(T.p2_title)}<p>${T.p2_main_start}</p><div class="row"><button class="big" id="go">${T.cont}</button></div>`);
        await waitSpaceOrButton("go");
      }
    }
    const n = P.trials.length;
    while (P.idx < n) {
      const t = P.trials[P.idx];
      const r = await oddityTrial(t, P.idx / n, false);
      st.oddity.push(Object.assign({ sid: st.sid }, t, r, { isi_ms: C.ISI_MS, f3_rule: C.F3_RULE,
                     timestamp: new Date().toISOString(), version: C.EXP_VERSION }));
      P.idx++; save();
      await sleep(C.ITI_MS);
      if (P.idx < n && P.idx % C.BREAK_EVERY === 0) {
        html(`${header(T.p2_title)}<p>${T.p2_break(P.idx, n)}</p><div class="row"><button class="big" id="go">${T.cont}</button></div>`);
        await waitSpaceOrButton("go");
      }
    }
    st.stage = "end_q"; save(); route();
  }

  function screenEndQ() {
    html(`${header(T.end_title)}<div class="form">
      <p>${T.end_q_diff}<br>${radios("diff", T.end_q_diff_opts)}</p>
      <p>${T.end_q_comment}<br><textarea id="cm" rows="4" style="width:100%"></textarea></p></div>
      <div class="row"><button class="big" id="go">${T.end_submit}</button></div>`);
    $("go").onclick = () => {
      const e = document.querySelector('input[name="diff"]:checked');
      st.end = { difficulty: e ? e.value : null, comment: $("cm").value };
      st.finished = new Date().toISOString(); st.stage = "save"; save(); route();
    };
  }

  async function screenSave() {
    html(`${header(T.end_title)}<p>${T.saving}</p>`);
    const ok1 = await upload(fileName("ident.csv"), toCSV(st.ident));
    const ok2 = await upload(fileName("oddity.csv"), toCSV(st.oddity));
    const ok3 = await upload(fileName("session.json"), sessionJSON());
    const ok = ok1 && ok2 && ok3;
    st.stage = "done"; st.saved_ok = ok; save();
    html(`${header(T.end_title)}${ok ? T.saved : T.save_failed}
      <p class="muted">${T.your_code} <b>${st.sid}</b></p>
      <div class="row"><button id="dl" class="${ok ? "" : "big"}">${T.download}</button></div>`);
    $("dl").onclick = downloadAll;
  }

  // ------------------------------------------------------------ researcher page: listen to the synthesizer
  function screenSynthDemo() {
    const tokens = Object.entries(D.RU_REF_HZ).map(([k, v]) => ({ k: k, cyr: D.LABELS.find(l => l.key === k).cyr, f1: v[0], f2: v[1] }));
    html(`<h1>Synthesizer check (researcher page)</h1>
      <p>Approximate Russian male targets (Fant 1960). Compare the two F3 rules by ear; click a ⬇ link to save a WAV.</p>
      <table class="prog"><tr><th></th><th>F1, F2 (Hz)</th><th>F3 natural</th><th>F3 pilot</th><th></th><th></th></tr>
      ${tokens.map(t => `<tr><td><b>${t.cyr}</b></td><td>${t.f1}, ${t.f2}</td><td>${S.f3Natural(t.f1, t.f2).toFixed(0)}</td><td>${S.f3Pilot(t.f1, t.f2).toFixed(0)}</td>
        <td><button data-k="${t.k}" data-r="natural">▶ natural</button> <a href="#" data-dl="${t.k}" data-r="natural">⬇</a></td>
        <td><button data-k="${t.k}" data-r="pilot">▶ pilot</button> <a href="#" data-dl="${t.k}" data-r="pilot">⬇</a></td></tr>`).join("")}
      </table><p>Grid: ${G.length} tokens (half A ${G.filter(g => g.half === "A").length}, half B ${G.filter(g => g.half === "B").length}).</p>`);
    app.querySelectorAll("button[data-k]").forEach(b => b.onclick = async () => {
      await ensureAudio(); const t = tokens.find(x => x.k === b.dataset.k);
      const r = S.synthVowel(t.f1, t.f2, { f3rule: b.dataset.r }); const buf = ctx.createBuffer(1, r.x.length, r.fs);
      buf.getChannelData(0).set(r.x); playAt(buf, ctx.currentTime + 0.05, 0);
    });
    app.querySelectorAll("a[data-dl]").forEach(a => a.onclick = ev => {
      ev.preventDefault(); const t = tokens.find(x => x.k === a.dataset.dl);
      const r = S.synthVowel(t.f1, t.f2, { f3rule: a.dataset.r });
      const l = document.createElement("a"); l.href = URL.createObjectURL(new Blob([S.toWav(r.x, r.fs)], { type: "audio/wav" }));
      l.download = `ru_${t.k}_${a.dataset.r}.wav`; l.click();
    });
  }

  // ------------------------------------------------------------ router
  function route() {
    switch (st.stage) {
      case "consent": return screenConsent();
      case "questionnaire": return screenQuestionnaire();
      case "volume": return screenVolume();
      case "headphone": return screenHeadphone();
      case "p1_instr": return screenP1Instr();
      case "p1": return runP1();
      case "break": return screenBreak();
      case "p2_instr": return screenP2Instr();
      case "p2": return runP2();
      case "end_q": return screenEndQ();
      case "save": return screenSave();
      case "done": return screenSave();
    }
  }

  function boot() {
    document.title = T.title;
    if (URLP.get("demo") === "synth") return screenSynthDemo();
    const old = load();
    if (old && old.stage !== "done" && old.stage !== "consent") {
      html(`${header(T.title)}<p>${T.resume_q}</p><div class="row"><button class="big" id="y">${T.resume_yes}</button><button id="n">${T.resume_no}</button></div>`);
      $("y").onclick = async () => {
        st = old; await ensureAudio();
        // an interrupted headphone check restarts; an interrupted trial is repeated
        route();
      };
      $("n").onclick = () => { st = newState(); save(); route(); };
      return;
    }
    st = newState(); save(); route();
  }
  window.addEventListener("beforeunload", e => {
    if (st && ["p1", "p2", "break", "save"].includes(st.stage)) { e.preventDefault(); e.returnValue = ""; }
  });
  boot();
})();
