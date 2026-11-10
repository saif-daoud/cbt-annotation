// Annotation document model, shared by the browser (app.js) and the Cloudflare Worker.
// Pure functions only: no DOM, no network.

export const OTHER = "__other__";
export const NONE = "__none__";
export const REWARD_LEVELS = [
  { value: 0, key: "unsuccessful", label: "Unsuccessful" },
  { value: 1, key: "acceptable", label: "Acceptable" },
  { value: 2, key: "ideal", label: "Ideal" }
];
export const GENERIC_SUCCESS_LEVELS = {
  unsuccessful: "The phase did not move the session toward its intended goal.",
  acceptable: "The phase made partial or satisfactory progress toward its intended goal.",
  ideal: "The phase fully achieved its intended goal."
};
export const STAGES = ["segment", "annotate", "ctrs", "done"];
export const MAX_DOC_BYTES = 600000;

export function newId() {
  const bytes = new Uint8Array(6);
  crypto.getRandomValues(bytes);
  return "p" + [...bytes].map(b => b.toString(16).padStart(2, "0")).join("");
}

export function newPhase(start) {
  return {
    id: newId(),
    start,
    macro: "",
    macro_other: "",
    state_updates: {},
    state_done: false,
    micro: {},
    reward: null,
    reward_comment: "",
    goal_other: ""
  };
}

export function emptyDocument() {
  return {
    version: 1,
    phases: [newPhase(0)],
    segmentation_done: false,
    ctrs: {},
    ctrs_comments: "",
    ui: { phase: 0, step: "state" }
  };
}

export function macroByName(taxonomy, name) {
  return taxonomy.macro_actions.find(macro => macro.name === name) || null;
}

export function dimensionByName(taxonomy, name) {
  return taxonomy.state_dimensions.find(dim => dim.name === name) || null;
}

export function macroLabel(phase) {
  if (!phase.macro) return "";
  return phase.macro === OTHER ? `Other: ${phase.macro_other || "…"}` : phase.macro;
}

export function phaseLabelled(phase) {
  if (!phase.macro) return false;
  if (phase.macro === OTHER) return Boolean(String(phase.macro_other || "").trim());
  return true;
}

// Micro-action names an expert may pick inside a phase.
export function allowedMicroNames(taxonomy, phase) {
  if (phase.macro === OTHER) return taxonomy.macro_actions.flatMap(macro => macro.micro_actions.map(a => a.name));
  const macro = macroByName(taxonomy, phase.macro);
  return macro ? macro.micro_actions.map(a => a.name) : [];
}

export function microForName(taxonomy, name) {
  for (const macro of taxonomy.macro_actions) {
    const action = macro.micro_actions.find(a => a.name === name);
    if (action) return { ...action, macro: macro.name };
  }
  return null;
}

// Turn ranges for every phase. Phases are contiguous and ordered by their first turn.
export function phaseRanges(doc, turns) {
  const phases = doc.phases;
  return phases.map((phase, index) => {
    const start = phase.start;
    const end = index + 1 < phases.length ? phases[index + 1].start - 1 : turns.length - 1;
    const inside = turns.filter(turn => turn.turn_index >= start && turn.turn_index <= end);
    const therapist = inside.filter(turn => turn.speaker === "therapist");
    return { index, start, end, turns: inside, therapist };
  });
}

export function microLabelComplete(label) {
  if (!label || !label.action) return false;
  if (label.action === OTHER) return Boolean(String(label.other || "").trim());
  return true;
}

export function phaseProgress(taxonomy, phase, range) {
  const labelled = range.therapist.filter(turn => microLabelComplete(phase.micro[String(turn.turn_index)])).length;
  const microDone = labelled === range.therapist.length;
  const rewardDone = phase.reward === 0 || phase.reward === 1 || phase.reward === 2;
  return {
    stateDone: Boolean(phase.state_done),
    microLabelled: labelled,
    microTotal: range.therapist.length,
    microDone,
    rewardDone,
    complete: Boolean(phase.state_done) && microDone && rewardDone && phaseLabelled(phase)
  };
}

// Full categorical state at the start of phase `phaseIndex` (inclusive of that phase's updates).
// Unset dimensions are null ("None" in exports).
export function stateAtPhaseStart(taxonomy, doc, phaseIndex) {
  const state = Object.fromEntries(taxonomy.state_dimensions.map(dim => [dim.name, null]));
  for (let index = 0; index <= phaseIndex && index < doc.phases.length; index += 1) {
    for (const [name, value] of Object.entries(doc.phases[index].state_updates || {})) {
      if (name in state) state[name] = value;
    }
  }
  return state;
}

// State before the phase's own updates (i.e. carried over from earlier phases).
export function carriedState(taxonomy, doc, phaseIndex) {
  return phaseIndex <= 0
    ? Object.fromEntries(taxonomy.state_dimensions.map(dim => [dim.name, null]))
    : stateAtPhaseStart(taxonomy, doc, phaseIndex - 1);
}

export function documentProgress(taxonomy, doc, turns) {
  const ranges = phaseRanges(doc, turns);
  const phases = doc.phases.map((phase, index) => phaseProgress(taxonomy, phase, ranges[index]));
  const ctrsDone = taxonomy.ctrs.items.filter(item => Number.isInteger(doc.ctrs?.[item.key])).length;
  return {
    phases: doc.phases.length,
    phasesLabelled: doc.phases.filter(phaseLabelled).length,
    phasesComplete: phases.filter(p => p.complete).length,
    microLabelled: phases.reduce((sum, p) => sum + p.microLabelled, 0),
    microTotal: phases.reduce((sum, p) => sum + p.microTotal, 0),
    ctrsDone,
    ctrsTotal: taxonomy.ctrs.items.length
  };
}

// Drop annotations that no longer fit the current segmentation (after a split, merge or relabel).
export function reconcile(taxonomy, doc, turns) {
  const ranges = phaseRanges(doc, turns);
  doc.phases.forEach((phase, index) => {
    const range = ranges[index];
    const allowed = new Set(allowedMicroNames(taxonomy, phase));
    const valid = new Set(range.therapist.map(turn => String(turn.turn_index)));
    for (const [key, label] of Object.entries(phase.micro || {})) {
      const keep = valid.has(key) && label && (label.action === OTHER || label.action === NONE || allowed.has(label.action));
      if (!keep) delete phase.micro[key];
    }
  });
  if (doc.ui) doc.ui.phase = Math.min(Math.max(0, doc.ui.phase || 0), doc.phases.length - 1);
  return doc;
}

// Split the phase containing `turnIndex` so a new phase starts at that turn.
export function splitAt(taxonomy, doc, turns, turnIndex) {
  const position = doc.phases.findIndex((phase, index) =>
    phase.start <= turnIndex && (index + 1 >= doc.phases.length || doc.phases[index + 1].start > turnIndex));
  if (position < 0 || doc.phases[position].start === turnIndex) return doc;
  const original = doc.phases[position];
  const created = newPhase(turnIndex);
  for (const [key, label] of Object.entries(original.micro || {})) {
    if (Number(key) >= turnIndex) delete original.micro[key];
  }
  original.reward = null;
  doc.phases.splice(position + 1, 0, created);
  return reconcile(taxonomy, doc, turns);
}

// Merge phase `index` into the previous phase.
export function mergeWithPrevious(taxonomy, doc, turns, index) {
  if (index <= 0 || index >= doc.phases.length) return doc;
  const previous = doc.phases[index - 1];
  const removed = doc.phases[index];
  if (removed.macro && removed.macro === previous.macro && removed.macro !== OTHER) {
    Object.assign(previous.micro, removed.micro);
  }
  previous.reward = null;
  doc.phases.splice(index, 1);
  return reconcile(taxonomy, doc, turns);
}

export function setPhaseMacro(taxonomy, doc, turns, index, macro, macroOther = "") {
  const phase = doc.phases[index];
  if (phase.macro !== macro) phase.reward = null;
  phase.macro = macro;
  phase.macro_other = macro === OTHER ? macroOther : "";
  return reconcile(taxonomy, doc, turns);
}

export function hasStageTwoData(phase) {
  return Boolean(phase.state_done || Object.keys(phase.state_updates || {}).length || Object.keys(phase.micro || {}).length || phase.reward !== null);
}

function text(value, max) {
  return String(value ?? "").slice(0, max);
}

// Normalise an untrusted document (from the browser) into the expected shape.
export function sanitizeDocument(taxonomy, input, turns) {
  const doc = emptyDocument();
  if (!input || typeof input !== "object") return doc;
  const turnSet = new Set(turns.map(turn => turn.turn_index));
  const therapistSet = new Set(turns.filter(turn => turn.speaker === "therapist").map(turn => turn.turn_index));
  const macroNames = new Set(taxonomy.macro_actions.map(m => m.name));
  const microNames = new Set(taxonomy.macro_actions.flatMap(m => m.micro_actions.map(a => a.name)));
  const dims = new Map(taxonomy.state_dimensions.map(d => [d.name, new Set(d.values)]));

  const phases = Array.isArray(input.phases) ? input.phases : [];
  const seen = new Set();
  const cleaned = [];
  for (const raw of phases.slice(0, 400)) {
    const start = Number(raw?.start);
    if (!Number.isInteger(start) || !turnSet.has(start) || seen.has(start)) continue;
    seen.add(start);
    const phase = newPhase(start);
    phase.id = /^[a-z0-9]{1,32}$/i.test(String(raw.id || "")) ? String(raw.id) : phase.id;
    phase.macro = raw.macro === OTHER || macroNames.has(raw.macro) ? raw.macro : "";
    phase.macro_other = phase.macro === OTHER ? text(raw.macro_other, 300) : "";
    phase.state_done = raw.state_done === true;
    for (const [name, value] of Object.entries(raw.state_updates || {})) {
      if (dims.has(name) && dims.get(name).has(value)) phase.state_updates[name] = value;
    }
    for (const [key, label] of Object.entries(raw.micro || {})) {
      const turnIndex = Number(key);
      if (!therapistSet.has(turnIndex) || !label) continue;
      const action = label.action === OTHER || label.action === NONE || microNames.has(label.action) ? label.action : "";
      if (!action) continue;
      phase.micro[String(turnIndex)] = action === OTHER ? { action, other: text(label.other, 300) } : { action };
    }
    phase.reward = [0, 1, 2].includes(raw.reward) ? raw.reward : null;
    phase.reward_comment = text(raw.reward_comment, 2000);
    phase.goal_other = phase.macro === OTHER ? text(raw.goal_other, 600) : "";
    cleaned.push(phase);
  }
  cleaned.sort((a, b) => a.start - b.start);
  if (!cleaned.length || cleaned[0].start !== turns[0]?.turn_index) cleaned.unshift(newPhase(turns[0]?.turn_index ?? 0));
  doc.phases = cleaned;
  doc.segmentation_done = input.segmentation_done === true;
  for (const item of taxonomy.ctrs.items) {
    const value = input.ctrs?.[item.key];
    if (Number.isInteger(value) && value >= 0 && value <= 6) doc.ctrs[item.key] = value;
  }
  doc.ctrs_comments = text(input.ctrs_comments, 4000);
  const ui = input.ui || {};
  doc.ui = {
    phase: Number.isInteger(ui.phase) ? Math.min(Math.max(ui.phase, 0), doc.phases.length - 1) : 0,
    step: ["state", "micro", "reward"].includes(ui.step) ? ui.step : "state"
  };
  return reconcile(taxonomy, doc, turns);
}

export function segmentationErrors(doc) {
  return doc.phases
    .map((phase, index) => (phaseLabelled(phase) ? null : `Phase ${index + 1} needs a macro action${phase.macro === OTHER ? " description" : ""}.`))
    .filter(Boolean);
}

export function annotationErrors(taxonomy, doc, turns) {
  const ranges = phaseRanges(doc, turns);
  const errors = [];
  doc.phases.forEach((phase, index) => {
    const progress = phaseProgress(taxonomy, phase, ranges[index]);
    if (!progress.stateDone) errors.push(`Phase ${index + 1}: confirm the conversation state.`);
    if (!progress.microDone) errors.push(`Phase ${index + 1}: ${progress.microTotal - progress.microLabelled} therapist turn(s) without a micro action.`);
    if (!progress.rewardDone) errors.push(`Phase ${index + 1}: choose the phase reward.`);
  });
  return errors;
}

export function ctrsErrors(taxonomy, doc) {
  const missing = taxonomy.ctrs.items.filter(item => !Number.isInteger(doc.ctrs?.[item.key]));
  return missing.length ? [`Score every CTRS item (${missing.length} missing).`] : [];
}

export function submissionErrors(taxonomy, doc, turns) {
  return [...segmentationErrors(doc), ...annotationErrors(taxonomy, doc, turns), ...ctrsErrors(taxonomy, doc)];
}

// Analysis-ready view of one annotation document (used by the export endpoint).
export function flattenDocument(taxonomy, doc, turns) {
  const ranges = phaseRanges(doc, turns);
  const byIndex = new Map(turns.map(turn => [turn.turn_index, turn]));
  const phases = doc.phases.map((phase, index) => {
    const range = ranges[index];
    const state = stateAtPhaseStart(taxonomy, doc, index);
    return {
      phase_index: index,
      from_turn: range.start,
      to_turn: range.end,
      from_utterance_id: byIndex.get(range.start)?.utterance_id || null,
      to_utterance_id: byIndex.get(range.end)?.utterance_id || null,
      first_therapist_utterance_id: range.therapist[0]?.utterance_id || null,
      last_therapist_utterance_id: range.therapist[range.therapist.length - 1]?.utterance_id || null,
      macro_action: phase.macro === OTHER ? "Other" : phase.macro,
      macro_action_other: phase.macro === OTHER ? phase.macro_other : null,
      goal_other: phase.macro === OTHER ? phase.goal_other : null,
      state_updates: phase.state_updates,
      state_at_start: Object.fromEntries(Object.entries(state).map(([name, value]) => [name, value ?? "None"])),
      intrinsic_reward: phase.reward,
      intrinsic_reward_label: REWARD_LEVELS.find(level => level.value === phase.reward)?.key || null,
      reward_comment: phase.reward_comment
    };
  });
  const micro = [];
  doc.phases.forEach((phase, index) => {
    for (const turn of ranges[index].therapist) {
      const label = phase.micro[String(turn.turn_index)];
      micro.push({
        turn_index: turn.turn_index,
        utterance_id: turn.utterance_id,
        phase_index: index,
        macro_action: phase.macro === OTHER ? "Other" : phase.macro,
        micro_action: !label ? null : label.action === OTHER ? "Other" : label.action === NONE ? "None" : label.action,
        micro_action_other: label?.action === OTHER ? label.other : null,
        micro_action_source_macro: label && label.action !== OTHER && label.action !== NONE ? microForName(taxonomy, label.action)?.macro || null : null
      });
    }
  });
  const scores = Object.fromEntries(taxonomy.ctrs.items.map(item => [item.key, doc.ctrs?.[item.key] ?? null]));
  const sum = part => taxonomy.ctrs.items.filter(item => item.part === part).reduce((total, item) => total + (scores[item.key] ?? 0), 0);
  return {
    phases,
    micro_actions: micro,
    ctrs: { scores, part1_sum: sum("part1"), part2_sum: sum("part2"), overall_sum: sum("part1") + sum("part2"), comments: doc.ctrs_comments }
  };
}
