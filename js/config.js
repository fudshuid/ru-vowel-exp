/* Experiment configuration — edit here, not in runner.js. */
var CONFIG = {
  EXP_VERSION: "ru-vowel-v1.0",

  // ---- data saving: DataPipe (https://pipe.jspsych.org) -> Google Drive / Zenodo / Dataverse (OSF closed to new experiments).
  // Paste the 12-character experiment ID shown on your DataPipe experiment page.
  // While it is "" the experiment runs normally but data are only offered for download.
  DATAPIPE_ID: "",
  DATAPIPE_URL: "https://pipe.jspsych.org/api/data/",

  // ---- stimuli
  F3_RULE: "natural",          // "natural" (fitted to natural male vowels) | "pilot" (Korean pilot logistic rule)
  ISI_MS: 400,                 // gap between the three sounds of an odd-one-out trial (as in the pilot)
  ITI_MS: 600,                 // pause between trials
  ROVE_DB: 2,                  // level rove (uniform ±dB) per sound in odd-one-out (as in the pilot)

  // ---- Part 1: classification (106 grid tokens once each, label + goodness)
  ID_MAX_PLAYS: 3,             // play + up to 2 replays
  N_REPEAT: 10,                // label-only repeats at the end (test-retest reliability)

  // ---- between parts: anchor selection
  MIN_TOKENS_FOR_PROTO: 2,     // fewer labels than this -> fallback reference prototype (flagged)
  MIN_PN_JND: 1.5,             // non-prototype at least this far (≈JND) from the prototype
  JND_F1_BARK: 0.449,          // Korean pilot median 70.7%-correct oddity thresholds
  JND_F2_BARK: 0.573,
  SYNTH_MARGIN_BARK: 1.0,      // odd tokens may lie this far outside the identification polygon
  MIN_BREAK_S: 20,             // the "continue" button appears after this many seconds

  // ---- Part 2: odd-one-out, fixed steps (≈0.65, 1.3, 2.6 pilot-JND)
  STEPS_F1_BARK: [0.3, 0.6, 1.2],
  STEPS_F2_BARK: [0.375, 0.75, 1.5],
  REPS: 3,                     // 5 vowels x 2 anchors x 2 directions x 3 steps x 3 reps = 180 trials
  BREAK_EVERY: 60,

  // ---- headphone screen (Woods et al. 2017, antiphase tones)
  HP_TRIALS: 6, HP_PASS: 5,

  // ---- researcher test mode (?test=1 in the URL): shortened run
  TEST_N_PER_HALF: 4,
  TEST_N_ODDITY: 8,
};
if (typeof module !== "undefined") module.exports = CONFIG;
