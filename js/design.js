/* Pure design logic (no DOM, no audio): stimulus grid, Part-1 trial order,
   prototype estimation, anchor selection and Part-2 trial generation.
   Shared by the browser runner and the Node tests (tests/simulate.js).       */
(function (root) {
  "use strict";
  const S = (typeof module !== "undefined" && module.exports) ? require("./synth.js") : root.VowelSynth;

  // ------------------------------------------------------------------ RNG
  function mulberry32(seed) {
    let a = seed >>> 0;
    return function () {
      a |= 0; a = (a + 0x6D2B79F5) | 0;
      let t = Math.imul(a ^ (a >>> 15), 1 | a);
      t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
      return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
    };
  }
  function shuffle(arr, rng) {
    const a = arr.slice();
    for (let i = a.length - 1; i > 0; i--) { const j = Math.floor(rng() * (i + 1)); [a[i], a[j]] = [a[j], a[i]]; }
    return a;
  }

  // ------------------------------------------------------------------ labels
  // key = analysis code; cyr = button label. ы is offered because isolated
  // central/back unrounded vowels are heard as ы by Russian listeners.
  const LABELS = [
    { key: "i", cyr: "и", ipa: "i" }, { key: "y", cyr: "ы", ipa: "ɨ" }, { key: "e", cyr: "э", ipa: "e" },
    { key: "a", cyr: "а", ipa: "a" }, { key: "o", cyr: "о", ipa: "o" }, { key: "u", cyr: "у", ipa: "u" },
  ];
  const ANCHOR_VOWELS = ["i", "e", "a", "o", "u"];   // the five Russian vowel phonemes

  // Approximate male Russian stressed-vowel targets (Hz), used ONLY as fallback
  // anchors when a listener gives too few labels for a vowel (Fant 1960, isolated
  // vowels; ы approximate).
  const RU_REF_HZ = { i: [240, 2250], y: [300, 1480], e: [440, 1800], a: [700, 1080], o: [535, 780], u: [300, 625] };

  // ------------------------------------------------------------------ space
  // Same vowel-space polygon and lattice as the Korean pilot (0.5 Bark F1 x 0.7 Bark F2,
  // 106 tokens), so that the two languages share one meaning grid.
  const POLY_HZ = [[250, 2450], [250, 640], [420, 600], [620, 700], [820, 950], [880, 1300], [820, 1800], [600, 2250], [400, 2450]];
  const POLY = POLY_HZ.map(p => [S.hzToBark(p[0]), S.hzToBark(p[1])]);
  const F1_START = 2.6, F1_STEP = 0.5, F1_STOP = 7.6, F2_START = 6.0, F2_STEP = 0.7, F2_STOP = 14.4;

  function inPolygon(p, poly) {               // ray casting (even-odd)
    let inside = false;
    for (let i = 0, j = poly.length - 1; i < poly.length; j = i++) {
      const xi = poly[i][0], yi = poly[i][1], xj = poly[j][0], yj = poly[j][1];
      if (((yi > p[1]) !== (yj > p[1])) && (p[0] < (xj - xi) * (p[1] - yi) / (yj - yi) + xi)) inside = !inside;
    }
    return inside;
  }
  function distToPolygonEdge(p, poly) {
    let best = Infinity;
    for (let i = 0, j = poly.length - 1; i < poly.length; j = i++) {
      const ax = poly[j][0], ay = poly[j][1], bx = poly[i][0], by = poly[i][1];
      const dx = bx - ax, dy = by - ay, L = dx * dx + dy * dy;
      let t = L > 0 ? ((p[0] - ax) * dx + (p[1] - ay) * dy) / L : 0;
      t = Math.max(0, Math.min(1, t));
      best = Math.min(best, Math.hypot(p[0] - (ax + t * dx), p[1] - (ay + t * dy)));
    }
    return best;
  }
  // valid stimulus: anywhere inside the identification polygon, or up to `margin`
  // Bark outside it provided F1 >= 2.0 Bark (~200 Hz) and F2 - F1 >= 0.8 Bark
  // (the smallest F2-F1 gap that occurs inside the polygon itself).
  function inSynthRegion(p, margin) {
    if (inPolygon(p, POLY)) return true;
    if (p[0] < 2.0 || p[1] - p[0] < 0.8) return false;
    return distToPolygonEdge(p, POLY) <= margin;
  }

  function grid() {
    const out = [];
    let idx = 0;
    for (let a = 0; F1_START + a * F1_STEP < F1_STOP - 1e-9; a++) {
      for (let b = 0; F2_START + b * F2_STEP < F2_STOP - 1e-9; b++) {
        const f1 = +(F1_START + a * F1_STEP).toFixed(4), f2 = +(F2_START + b * F2_STEP).toFixed(4);
        if (inPolygon([f1, f2], POLY)) {
          out.push({ index: idx++, i1: a, i2: b, half: (a + b) % 2 === 0 ? "A" : "B",
                     F1_bark: f1, F2_bark: f2, F1_hz: S.barkToHz(f1), F2_hz: S.barkToHz(f2) });
        }
      }
    }
    return out;
  }

  // ------------------------------------------------------------------ Part 1 order
  /* Two interleaved quincunx halves (each covers the whole space evenly, as in
     Zaslavsky & Arnon's split of the children's sub-grid), half order
     counterbalanced by seed, random order within a half, then a short
     repeat block (same label + goodness screen) for test-retest reliability.                     */
  function part1Order(G, cfg, rng) {
    const first = rng() < 0.5 ? "A" : "B", second = first === "A" ? "B" : "A";
    const blocks = [first, second].map((h, bi) =>
      shuffle(G.filter(g => g.half === h), rng).map(g => ({ block: bi + 1, half: h, grid_index: g.index, kind: "main" })));
    let all = blocks[0].concat(blocks[1]);
    if (cfg.TEST_MODE) all = blocks[0].slice(0, cfg.TEST_N_PER_HALF).concat(blocks[1].slice(0, cfg.TEST_N_PER_HALF));
    const nRep = cfg.TEST_MODE ? 2 : cfg.N_REPEAT;
    const rep = shuffle(all.slice(), rng).slice(0, nRep).map(t => ({ block: 3, half: t.half, grid_index: t.grid_index, kind: "repeat" }));
    return { order: all.concat(rep), firstHalf: first };
  }

  // ------------------------------------------------------------------ prototypes
  /* Goodness-weighted centroid, weights (g-1)^2 (identical to the pilot's
     personal_prototypes). Uses main-block trials only (they carry goodness). */
  function prototypes(identRows) {
    const out = {};
    for (const L of LABELS) {
      const d = identRows.filter(r => r.kind === "main" && r.label === L.key);
      if (!d.length) { out[L.key] = { n: 0 }; continue; }
      let w = d.map(r => Math.pow((+r.goodness || 1) - 1, 2));
      let ws = w.reduce((s, v) => s + v, 0);
      if (ws === 0) { w = d.map(() => 1); ws = d.length; }
      const f1 = d.reduce((s, r, i) => s + w[i] * r.F1_bark, 0) / ws;
      const f2 = d.reduce((s, r, i) => s + w[i] * r.F2_bark, 0) / ws;
      out[L.key] = { n: d.length, wsum: ws, mean_goodness: d.reduce((s, r) => s + (+r.goodness || 0), 0) / d.length,
                     F1_bark: f1, F2_bark: f2 };
    }
    return out;
  }

  /* Distance in approximate JND units (pilot median thresholds) */
  function jndDist(a, b, cfg) {
    return Math.hypot((a[0] - b[0]) / cfg.JND_F1_BARK, (a[1] - b[1]) / cfg.JND_F2_BARK);
  }

  /* Two anchors per vowel: P = the listener's own prototype; N = a poor but
     still-identified exemplar of the same category (Kuhl 1991 logic): the
     token labelled with that vowel that has the lowest goodness, at least
     cfg.MIN_PN_JND from P (ties -> farther from P). Fallbacks are flagged.   */
  function selectAnchors(identRows, G, cfg) {
    const protos = prototypes(identRows), anchors = [], warnings = [];
    const centre = [G.reduce((s, g) => s + g.F1_bark, 0) / G.length, G.reduce((s, g) => s + g.F2_bark, 0) / G.length];
    for (const v of ANCHOR_VOWELS) {
      const pr = protos[v];
      let P, pMethod;
      if (pr.n >= cfg.MIN_TOKENS_FOR_PROTO) { P = [pr.F1_bark, pr.F2_bark]; pMethod = "goodness_centroid"; }
      else { P = [S.hzToBark(RU_REF_HZ[v][0]), S.hzToBark(RU_REF_HZ[v][1])]; pMethod = "fallback_reference"; warnings.push(v + ": prototype from reference (n=" + pr.n + ")"); }
      const own = identRows.filter(r => r.kind === "main" && r.label === v);
      const cand = own.map(r => ({ p: [r.F1_bark, r.F2_bark], g: +r.goodness || 1, gi: r.grid_index }))
                      .filter(c => jndDist(c.p, P, cfg) >= cfg.MIN_PN_JND);
      let N, nMethod, nGood = null, nGrid = null;
      if (cand.length) {
        cand.sort((a, b) => (a.g - b.g) || (jndDist(b.p, P, cfg) - jndDist(a.p, P, cfg)));
        N = cand[0].p; nGood = cand[0].g; nGrid = cand[0].gi; nMethod = "lowest_goodness_same_label";
      } else {
        // step MIN_PN_JND from P toward the centre of the space
        const dx = centre[0] - P[0], dy = centre[1] - P[1], dj = jndDist(centre, P, cfg) || 1;
        N = [P[0] + dx * cfg.MIN_PN_JND / dj, P[1] + dy * cfg.MIN_PN_JND / dj];
        nMethod = "fallback_toward_centre"; warnings.push(v + ": non-prototype by fallback");
      }
      anchors.push({ anchor: "P_" + v, vowel: v, kind: "prototype", F1_bark: P[0], F2_bark: P[1], method: pMethod,
                     n_labels: pr.n, mean_goodness: pr.mean_goodness == null ? null : pr.mean_goodness });
      anchors.push({ anchor: "N_" + v, vowel: v, kind: "nonprototype", F1_bark: N[0], F2_bark: N[1], method: nMethod,
                     goodness: nGood, grid_index: nGrid, dist_to_P_jnd: jndDist(N, P, cfg) });
    }
    return { prototypes: protos, anchors: anchors, warnings: warnings };
  }

  // ------------------------------------------------------------------ Part 2 trials
  /* 3-interval odd-one-out at fixed step sizes (method of constant stimuli).
     Standard = anchor; odd = anchor + sign * step along F1 or F2 (Bark).
     Per anchor x direction: STEPS x REPS trials, signs balanced (+/- alternate
     in a shuffled list); a sign whose odd token leaves the synthesis region is
     flipped (flagged).                                                        */
  function part2Trials(anchors, cfg, rng) {
    const trials = [];
    for (const a of anchors) {
      for (const dir of ["F1", "F2"]) {
        const steps = dir === "F1" ? cfg.STEPS_F1_BARK : cfg.STEPS_F2_BARK;
        const n = steps.length * cfg.REPS;
        const signs = shuffle(Array.from({ length: n }, (_, i) => (i % 2 === 0 ? 1 : -1)), rng);
        let k = 0;
        for (const st of steps) {
          for (let r = 0; r < cfg.REPS; r++, k++) {
            let sign = signs[k], flipped = 0;
            const odd = s => dir === "F1" ? [a.F1_bark + s * st, a.F2_bark] : [a.F1_bark, a.F2_bark + s * st];
            if (!inSynthRegion(odd(sign), cfg.SYNTH_MARGIN_BARK)) {
              if (inSynthRegion(odd(-sign), cfg.SYNTH_MARGIN_BARK)) { sign = -sign; flipped = 1; } else flipped = 2;
            }
            const o = odd(sign);
            trials.push({ anchor: a.anchor, vowel: a.vowel, kind: a.kind, direction: dir, step_bark: st, rep: r + 1,
                          sign: sign, sign_flipped: flipped, std_F1_bark: a.F1_bark, std_F2_bark: a.F2_bark,
                          odd_F1_bark: o[0], odd_F2_bark: o[1], odd_pos: 1 + Math.floor(rng() * 3) });
          }
        }
      }
    }
    let out = shuffle(trials, rng);
    // avoid the same anchor+direction twice in a row where possible
    for (let i = 1; i < out.length; i++) {
      if (out[i].anchor === out[i - 1].anchor && out[i].direction === out[i - 1].direction) {
        for (let j = i + 1; j < out.length; j++) {
          if (out[j].anchor !== out[i - 1].anchor || out[j].direction !== out[i - 1].direction) { [out[i], out[j]] = [out[j], out[i]]; break; }
        }
      }
    }
    if (cfg.TEST_MODE) out = out.slice(0, cfg.TEST_N_ODDITY);
    out.forEach((t, i) => t.trial = i + 1);
    return out;
  }

  /* Practice: large, easy differences at the centre of the space, with feedback */
  function practiceTrials(cfg, rng) {
    const c = [5.1, 10.2], out = [];
    const specs = [["F2", 1.6], ["F1", 1.2], ["F2", 1.2], ["F1", 0.9], ["F2", 0.9], ["F1", 0.7]];
    for (const [dir, st] of specs) {
      const sign = rng() < 0.5 ? -1 : 1;
      out.push({ anchor: "practice", vowel: "-", kind: "practice", direction: dir, step_bark: st, rep: 1, sign: sign, sign_flipped: 0,
                 std_F1_bark: c[0], std_F2_bark: c[1], odd_F1_bark: dir === "F1" ? c[0] + sign * st : c[0],
                 odd_F2_bark: dir === "F2" ? c[1] + sign * st : c[1], odd_pos: 1 + Math.floor(rng() * 3) });
    }
    return out;
  }

  const api = { mulberry32, shuffle, LABELS, ANCHOR_VOWELS, RU_REF_HZ, POLY_HZ, POLY, inPolygon, distToPolygonEdge,
                inSynthRegion, grid, part1Order, prototypes, jndDist, selectAnchors, part2Trials, practiceTrials };
  if (typeof module !== "undefined" && module.exports) module.exports = api;
  else root.VowelDesign = api;
})(this);
