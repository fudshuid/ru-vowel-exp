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
  // neighbours around the vowel space (и–э–а–о–у–и); the у–и midpoint lies in the ы region
  const RING = ["i", "e", "a", "o", "u"];

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
  /* Every token is classified (label + goodness) twice: pass 1 = blocks 1-2, pass 2 =
     blocks 3-4. Within a pass the grid is split into the two interleaved quincunx halves
     (each covers the whole space, as in Zaslavsky & Arnon's split sub-grid); half order is
     counterbalanced by seed and reversed in pass 2; order within a block is random.      */
  function part1Order(G, cfg, rng) {
    const first = rng() < 0.5 ? "A" : "B", second = first === "A" ? "B" : "A";
    const plan = [[first, 1], [second, 1], [second, 2], [first, 2]];
    let blocks = plan.map(([h, pass], bi) =>
      shuffle(G.filter(g => g.half === h), rng).map(g => ({ block: bi + 1, rep: pass, half: h, grid_index: g.index, kind: "main" })));
    if (cfg.TEST_MODE) blocks = blocks.map(b => b.slice(0, cfg.TEST_N_PER_HALF));
    // avoid the same token on both sides of the pass boundary
    const b2 = blocks[1], b3 = blocks[2];
    if (b2.length && b3.length > 1 && b2[b2.length - 1].grid_index === b3[0].grid_index) [b3[0], b3[1]] = [b3[1], b3[0]];
    return { order: [].concat(...blocks), firstHalf: first, nBlocks: blocks.length };
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

  /* Prototype of each vowel: the listener's goodness-weighted centroid, or the
     Fant (1960) reference if the vowel got fewer than MIN_TOKENS_FOR_PROTO labels. */
  function ownPrototypes(identRows, cfg, warnings) {
    const protos = prototypes(identRows), P = {};
    for (const v of ANCHOR_VOWELS) {
      const pr = protos[v];
      if (pr.n >= cfg.MIN_TOKENS_FOR_PROTO) P[v] = { p: [pr.F1_bark, pr.F2_bark], method: "goodness_centroid", n: pr.n, mean_goodness: pr.mean_goodness };
      else {
        P[v] = { p: [S.hzToBark(RU_REF_HZ[v][0]), S.hzToBark(RU_REF_HZ[v][1])], method: "fallback_reference", n: pr.n, mean_goodness: pr.mean_goodness == null ? null : pr.mean_goodness };
        warnings.push(v + ": prototype from reference (n=" + pr.n + ")");
      }
    }
    return { protos, P };
  }

  /* Anchor designs (cfg.ANCHOR_DESIGN):
     "midpoint" (default; same logic as the Korean pilot, but built on the listener's
        OWN prototypes): 5 prototypes P_v + 5 midpoints M_v-w between neighbouring
        prototypes on the ring и–э–а–о–у–и + 1 centre C (mean of the 5 prototypes) = 11.
     "nonprototype": 5 prototypes + 5 poor-but-identified exemplars N_v (lowest-goodness
        token of the same label, >= MIN_PN_JND from P; fallback toward the centre).     */
  function selectAnchors(identRows, G, cfg) {
    const warnings = [], anchors = [];
    const { protos, P } = ownPrototypes(identRows, cfg, warnings);
    const design = cfg.ANCHOR_DESIGN || "midpoint";
    for (const v of ANCHOR_VOWELS) {
      anchors.push({ anchor: "P_" + v, vowel: v, kind: "prototype", F1_bark: P[v].p[0], F2_bark: P[v].p[1], method: P[v].method,
                     n_labels: P[v].n, mean_goodness: P[v].mean_goodness });
    }
    if (design === "midpoint") {
      for (let i = 0; i < RING.length; i++) {
        const a = RING[i], b = RING[(i + 1) % RING.length], pa = P[a].p, pb = P[b].p;
        const m = [(pa[0] + pb[0]) / 2, (pa[1] + pb[1]) / 2];
        const half = jndDist(pa, pb, cfg) / 2;
        if (half < cfg.MIN_PN_JND) warnings.push(`midpoint ${a}-${b}: only ${half.toFixed(2)} JND from the prototypes`);
        anchors.push({ anchor: `M_${a}-${b}`, vowel: `${a}|${b}`, kind: "midpoint", F1_bark: m[0], F2_bark: m[1],
                       method: (P[a].method === "goodness_centroid" && P[b].method === "goodness_centroid") ? "own_prototypes" : "uses_fallback",
                       dist_to_P_jnd: half });
      }
      const c = [0, 1].map(k => ANCHOR_VOWELS.reduce((s, v) => s + P[v].p[k], 0) / ANCHOR_VOWELS.length);
      anchors.push({ anchor: "C_centre", vowel: "centre", kind: "centre", F1_bark: c[0], F2_bark: c[1], method: "mean_of_prototypes",
                     dist_to_P_jnd: Math.min(...ANCHOR_VOWELS.map(v => jndDist(c, P[v].p, cfg))) });
    } else {
      const centre = [G.reduce((s, g) => s + g.F1_bark, 0) / G.length, G.reduce((s, g) => s + g.F2_bark, 0) / G.length];
      for (const v of ANCHOR_VOWELS) {
        const Pv = P[v].p;
        const cand = identRows.filter(r => r.kind === "main" && r.label === v)
          .map(r => ({ p: [r.F1_bark, r.F2_bark], g: +r.goodness || 1, gi: r.grid_index }))
          .filter(c => jndDist(c.p, Pv, cfg) >= cfg.MIN_PN_JND);
        let N, nMethod, nGood = null, nGrid = null;
        if (cand.length) {
          cand.sort((a, b) => (a.g - b.g) || (jndDist(b.p, Pv, cfg) - jndDist(a.p, Pv, cfg)));
          N = cand[0].p; nGood = cand[0].g; nGrid = cand[0].gi; nMethod = "lowest_goodness_same_label";
        } else {
          const dx = centre[0] - Pv[0], dy = centre[1] - Pv[1], dj = jndDist(centre, Pv, cfg) || 1;
          N = [Pv[0] + dx * cfg.MIN_PN_JND / dj, Pv[1] + dy * cfg.MIN_PN_JND / dj];
          nMethod = "fallback_toward_centre"; warnings.push(v + ": non-prototype by fallback");
        }
        anchors.push({ anchor: "N_" + v, vowel: v, kind: "nonprototype", F1_bark: N[0], F2_bark: N[1], method: nMethod,
                       goodness: nGood, grid_index: nGrid, dist_to_P_jnd: jndDist(N, Pv, cfg) });
      }
    }
    return { design: design, prototypes: protos, anchors: anchors, warnings: warnings };
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
          // odd-interval position balanced within each anchor x direction x step cell
          // (with REPS = 3: positions 1, 2, 3 once each, in random order)
          const pos = shuffle(Array.from({ length: cfg.REPS }, (_, i) => 1 + (i % 3)), rng);
          for (let r = 0; r < cfg.REPS; r++, k++) {
            let sign = signs[k], flipped = 0;
            const odd = s => dir === "F1" ? [a.F1_bark + s * st, a.F2_bark] : [a.F1_bark, a.F2_bark + s * st];
            if (!inSynthRegion(odd(sign), cfg.SYNTH_MARGIN_BARK)) {
              if (inSynthRegion(odd(-sign), cfg.SYNTH_MARGIN_BARK)) { sign = -sign; flipped = 1; } else flipped = 2;
            }
            const o = odd(sign);
            trials.push({ anchor: a.anchor, vowel: a.vowel, kind: a.kind, direction: dir, step_bark: st, rep: r + 1,
                          sign: sign, sign_flipped: flipped, std_F1_bark: a.F1_bark, std_F2_bark: a.F2_bark,
                          odd_F1_bark: o[0], odd_F2_bark: o[1], odd_pos: pos[r] });
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
    const pos = shuffle([1, 2, 3, 1, 2, 3], rng);           // each position twice
    for (const [dir, st] of specs) {
      const sign = rng() < 0.5 ? -1 : 1;
      out.push({ anchor: "practice", vowel: "-", kind: "practice", direction: dir, step_bark: st, rep: 1, sign: sign, sign_flipped: 0,
                 std_F1_bark: c[0], std_F2_bark: c[1], odd_F1_bark: dir === "F1" ? c[0] + sign * st : c[0],
                 odd_F2_bark: dir === "F2" ? c[1] + sign * st : c[1], odd_pos: pos[out.length] });
    }
    return out;
  }

  const api = { mulberry32, shuffle, LABELS, ANCHOR_VOWELS, RING, ownPrototypes, RU_REF_HZ, POLY_HZ, POLY, inPolygon, distToPolygonEdge,
                inSynthRegion, grid, part1Order, prototypes, jndDist, selectAnchors, part2Trials, practiceTrials };
  if (typeof module !== "undefined" && module.exports) module.exports = api;
  else root.VowelDesign = api;
})(this);
