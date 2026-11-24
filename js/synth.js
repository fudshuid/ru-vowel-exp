/* Klatt-style cascade formant synthesizer for static vowels (browser + Node).
   JavaScript port of vowelpoc/synth.py (Korean pilot), sample-for-sample
   (validated against the Python implementation in tests/validate_synth.py).

   Source  : impulse train with fractional-sample placement -> glottal low-pass
             (resonator F=0, BW=100 Hz; -12 dB/oct)
   Tract   : cascade of 5 digital resonators F1..F5
   Lips    : first difference (+6 dB/oct)
   Envelope: 25-ms raised-cosine ramps; RMS normalised to -22 dBFS.

   Only F1 and F2 are experimental variables. F3 follows a deterministic rule:
     "natural" (default): regression in Bark on F1, F2 fitted to the male means of
                Peterson & Barney (1952) + Hillenbrand et al. (1995) (20 non-rhotic
                vowels):  F3 = 8.276 + 0.6017 F2 + 0.9969 F1 - 0.09727 F1*F2 (Bark),
                with smooth floors F3 >= 2200 Hz and F3 - F2 >= 1.5 Bark.
     "pilot"  : the Korean pilot's logistic rule of F2 only.                     */
(function (root) {
  "use strict";

  const FS = 22050, DUR = 0.250, RAMP = 0.025, F0_START = 125.0, F0_END = 112.0;
  const TARGET_RMS_DBFS = -22.0, RUNIN = 0.05;

  function pyRound(v) {                       // Python 3 round(): ties to even
    const f = Math.floor(v), d = v - f;
    if (d > 0.5) return f + 1;
    if (d < 0.5) return f;
    return (f % 2 === 0) ? f : f + 1;
  }

  // ---------- Traunmüller (1990) Bark scale with end corrections (as scales.py)
  function hzToBark(f) {
    let z = 26.81 * f / (1960.0 + f) - 0.53;
    if (z < 2.0) z = z + 0.15 * (2.0 - z);
    if (z > 20.1) z = z + 0.22 * (z - 20.1);
    return z;
  }
  function barkToHz(z) {
    let zc = z;
    if (z < 2.0) zc = (z - 0.3) / 0.85;
    if (zc > 20.1) zc = (zc + 4.422) / 1.22;
    return 1960.0 * (zc + 0.53) / (26.28 - zc);
  }

  // ---------- F3 rules
  const F3C = [8.276054065446468, 0.6016932289899987, 0.9969304966540484, -0.09726825881481437];
  const F3_FLOOR_HZ = 2200.0, F3_MIN_GAP_BARK = 1.5, SMAX_T = 0.1;
  function smax(a, b, t) {
    const m = Math.max(a, b);
    return m + t * Math.log(Math.exp((a - m) / t) + Math.exp((b - m) / t));
  }
  function f3Natural(f1, f2) {
    const b1 = hzToBark(f1), b2 = hzToBark(f2);
    let z = F3C[0] + F3C[1] * b2 + F3C[2] * b1 + F3C[3] * b1 * b2;
    z = smax(z, hzToBark(F3_FLOOR_HZ), SMAX_T);
    z = smax(z, b2 + F3_MIN_GAP_BARK, SMAX_T);
    return barkToHz(z);
  }
  function f3Pilot(f1, f2) { return 2450.0 + 560.0 / (1.0 + Math.exp(-(f2 - 1900.0) / 160.0)); }

  function formantSet(f1, f2, rule) {
    const f3 = (rule === "pilot") ? f3Pilot(f1, f2) : f3Natural(f1, f2);
    return [f1, f2, f3, Math.max(3500.0, f3 + 500.0), 4500.0];
  }
  function bandwidths(F) {
    return [50.0 + 0.05 * F[0], 60.0 + 0.03 * F[1], 120.0 + 0.02 * F[2], 250.0, 300.0];
  }

  // y[n] = A x[n] + B y[n-1] + C y[n-2]   (Klatt 1980 digital resonator)
  function resonate(x, F, BW, fs) {
    const T = 1.0 / fs;
    const C = -Math.exp(-2 * Math.PI * BW * T);
    const B = 2 * Math.exp(-Math.PI * BW * T) * Math.cos(2 * Math.PI * F * T);
    const A = 1.0 - B - C;
    const y = new Float64Array(x.length);
    let y1 = 0, y2 = 0;
    for (let n = 0; n < x.length; n++) {
      const v = A * x[n] + B * y1 + C * y2;
      y[n] = v; y2 = y1; y1 = v;
    }
    return y;
  }

  const _srcCache = {};
  function glottalSource(n, fs) {
    const key = n + "_" + fs;
    if (_srcCache[key]) return _srcCache[key];
    const phase = new Float64Array(n);
    let acc = 0;
    for (let i = 0; i < n; i++) {             // linear F0 declination over the buffer
      acc += F0_START + (F0_END - F0_START) * (i / fs) / (n / fs);
      phase[i] = acc / fs;                    // cumulative cycles
    }
    const src = new Float64Array(n + 2);
    let k = 1, idx = 0;
    for (;;) {
      while (idx < n && phase[idx] < k) idx++; // first sample with phase >= k
      if (idx >= n) break;
      const p0 = idx > 0 ? phase[idx - 1] : 0.0;
      const frac = (k - p0) / Math.max(phase[idx] - p0, 1e-12);
      src[idx - 1] += 1.0 - frac;
      src[idx] += frac;
      k += 1;
    }
    const out = resonate(src.subarray(0, n), 0.0, 100.0, fs);
    _srcCache[key] = out;
    return out;
  }

  /* Synthesize one vowel (Hz). Returns {x: Float32Array, F, B, fs}. */
  function synthVowel(f1, f2, opts) {
    opts = opts || {};
    const fs = opts.fs || FS, dur = opts.dur || DUR, rule = opts.f3rule || "natural";
    const n = pyRound(dur * fs), nRun = Math.floor(RUNIN * fs);
    let x = glottalSource(n + nRun, fs).slice();
    const F = formantSet(f1, f2, rule), Bw = bandwidths(F);
    for (let i = 0; i < 5; i++) x = resonate(x, F[i], Bw[i], fs);
    const d = new Float64Array(x.length);     // lip radiation (np.diff, prepend=0)
    d[0] = x[0];
    for (let i = 1; i < x.length; i++) d[i] = x[i] - x[i - 1];
    const y = d.slice(nRun, nRun + n);
    const nr = Math.floor(RAMP * fs);
    for (let i = 0; i < nr; i++) {
      const r = 0.5 - 0.5 * Math.cos(Math.PI * i / (nr - 1));
      y[i] *= r; y[n - 1 - i] *= r;
    }
    let ss = 0;
    for (let i = 0; i < n; i++) ss += y[i] * y[i];
    const g = Math.pow(10, TARGET_RMS_DBFS / 20) / Math.sqrt(ss / n);
    const out = new Float32Array(n);
    for (let i = 0; i < n; i++) out[i] = y[i] * g;
    return { x: out, F: F, B: Bw, fs: fs };
  }
  function synthBark(b1, b2, opts) { return synthVowel(barkToHz(b1), barkToHz(b2), opts); }

  /* 16-bit PCM WAV bytes (researcher test page: download a stimulus) */
  function toWav(x, fs) {
    const n = x.length, buf = new ArrayBuffer(44 + 2 * n), v = new DataView(buf);
    const w = (o, s) => { for (let i = 0; i < s.length; i++) v.setUint8(o + i, s.charCodeAt(i)); };
    w(0, "RIFF"); v.setUint32(4, 36 + 2 * n, true); w(8, "WAVE"); w(12, "fmt ");
    v.setUint32(16, 16, true); v.setUint16(20, 1, true); v.setUint16(22, 1, true);
    v.setUint32(24, fs, true); v.setUint32(28, 2 * fs, true); v.setUint16(32, 2, true); v.setUint16(34, 16, true);
    w(36, "data"); v.setUint32(40, 2 * n, true);
    for (let i = 0; i < n; i++) v.setInt16(44 + 2 * i, Math.round(Math.max(-1, Math.min(1, x[i])) * 32767), true);
    return buf;
  }

  const api = { FS, DUR, RAMP, F0_START, F0_END, TARGET_RMS_DBFS, pyRound, hzToBark, barkToHz,
                f3Natural, f3Pilot, formantSet, bandwidths, resonate, glottalSource, synthVowel, synthBark, toWav };
  if (typeof module !== "undefined" && module.exports) module.exports = api;
  else root.VowelSynth = api;
})(this);
