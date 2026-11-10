import assert from "node:assert/strict";
import test from "node:test";

import { TAXONOMY } from "../../frontend/taxonomy.js";
import * as M from "../../frontend/model.js";

// t0 T, t1 P, t2 T, t3 P, t4 T, t5 P, t6 T, t7 P
const turns = Array.from({ length: 8 }, (_, i) => ({
  turn_index: i,
  speaker: i % 2 === 0 ? "therapist" : "patient",
  utterance_id: `${i % 2 === 0 ? "therapist" : "patient"}_${Math.floor(i / 2)}`,
  text: `turn ${i}`
}));
const [macroA, macroB] = TAXONOMY.macro_actions;

test("taxonomy matches the TOPAS components and CTRS rubric", () => {
  assert.equal(TAXONOMY.macro_actions.length, 12);
  assert.equal(TAXONOMY.state_dimensions.length, 62);
  assert.equal(TAXONOMY.ctrs.items.length, 11);
  for (const item of TAXONOMY.ctrs.items) assert.deepEqual(Object.keys(item.anchors), ["0", "2", "4", "6"]);
});

test("split, label, merge and reconcile", () => {
  const doc = M.emptyDocument();
  M.splitAt(TAXONOMY, doc, turns, 4);
  assert.deepEqual(doc.phases.map(p => p.start), [0, 4]);
  const ranges = M.phaseRanges(doc, turns);
  assert.deepEqual(ranges.map(r => [r.start, r.end]), [[0, 3], [4, 7]]);
  assert.deepEqual(ranges[1].therapist.map(t => t.turn_index), [4, 6]);

  M.setPhaseMacro(TAXONOMY, doc, turns, 0, macroA.name);
  M.setPhaseMacro(TAXONOMY, doc, turns, 1, macroA.name);
  doc.phases[0].micro["0"] = { action: macroA.micro_actions[0].name };
  doc.phases[1].micro["4"] = { action: macroA.micro_actions[1].name };
  doc.phases[1].micro["6"] = { action: M.NONE };
  M.mergeWithPrevious(TAXONOMY, doc, turns, 1);
  assert.equal(doc.phases.length, 1);
  assert.deepEqual(Object.keys(doc.phases[0].micro).sort(), ["0", "4", "6"]);

  // Changing the macro drops micro labels that do not belong to it, but keeps None/Other.
  M.setPhaseMacro(TAXONOMY, doc, turns, 0, macroB.name);
  assert.deepEqual(Object.keys(doc.phases[0].micro), ["6"]);
});

test("conversation state carries over between phases", () => {
  const doc = M.emptyDocument();
  M.splitAt(TAXONOMY, doc, turns, 4);
  doc.phases[0].state_updates = { "Automatic Thoughts": "Negative" };
  doc.phases[1].state_updates = { "Mood/Emotional State": "Neutral/Mixed" };
  assert.equal(M.carriedState(TAXONOMY, doc, 0)["Automatic Thoughts"], null);
  assert.equal(M.carriedState(TAXONOMY, doc, 1)["Automatic Thoughts"], "Negative");
  const state = M.stateAtPhaseStart(TAXONOMY, doc, 1);
  assert.equal(state["Automatic Thoughts"], "Negative");
  assert.equal(state["Mood/Emotional State"], "Neutral/Mixed");
  assert.equal(Object.keys(state).length, 62);
});

test("progress, validation and flattening", () => {
  const doc = M.emptyDocument();
  M.splitAt(TAXONOMY, doc, turns, 4);
  assert.equal(M.segmentationErrors(doc).length, 2);
  M.setPhaseMacro(TAXONOMY, doc, turns, 0, macroA.name);
  M.setPhaseMacro(TAXONOMY, doc, turns, 1, M.OTHER, "");
  assert.equal(M.segmentationErrors(doc).length, 1, "Other requires a description");
  doc.phases[1].macro_other = "Small talk";
  assert.equal(M.segmentationErrors(doc).length, 0);

  doc.phases.forEach(p => { p.state_done = true; p.reward = 1; });
  doc.phases[0].micro = { 0: { action: macroA.micro_actions[0].name }, 2: { action: M.NONE } };
  doc.phases[1].micro = { 4: { action: M.OTHER, other: "" }, 6: { action: macroB.micro_actions[0].name } };
  assert.match(M.annotationErrors(TAXONOMY, doc, turns).join(" "), /Phase 2: 1 therapist/);
  doc.phases[1].micro[4].other = "Scheduling";
  assert.deepEqual(M.annotationErrors(TAXONOMY, doc, turns), []);
  assert.equal(M.ctrsErrors(TAXONOMY, doc).length, 1);
  for (const item of TAXONOMY.ctrs.items) doc.ctrs[item.key] = 4;
  assert.deepEqual(M.submissionErrors(TAXONOMY, doc, turns), []);

  const flat = M.flattenDocument(TAXONOMY, doc, turns);
  assert.equal(flat.ctrs.overall_sum, 44);
  assert.equal(flat.phases[1].macro_action, "Other");
  assert.equal(flat.phases[1].first_therapist_utterance_id, "therapist_2");
  assert.deepEqual(flat.micro_actions.map(m => m.micro_action), [macroA.micro_actions[0].name, "None", "Other", macroB.micro_actions[0].name]);
  assert.equal(flat.micro_actions[3].micro_action_source_macro, macroB.name);
});

test("sanitizeDocument drops invalid input", () => {
  const dirty = {
    phases: [
      { start: 4, macro: "Not a macro", micro: { 4: { action: "made up" } } },
      { start: 99, macro: macroA.name },
      { start: 0, macro: macroA.name, state_updates: { "Automatic Thoughts": "Bogus", "Mood/Emotional State": "Positive" }, reward: 7, micro: { 1: { action: M.NONE } } }
    ],
    ctrs: { agenda: 9, feedback: 3 },
    ui: { phase: 10, step: "nope" }
  };
  const doc = M.sanitizeDocument(TAXONOMY, dirty, turns);
  assert.deepEqual(doc.phases.map(p => p.start), [0, 4]);
  assert.equal(doc.phases[1].macro, "");
  assert.deepEqual(doc.phases[0].state_updates, { "Mood/Emotional State": "Positive" });
  assert.equal(doc.phases[0].reward, null);
  assert.deepEqual(doc.phases[0].micro, {}, "patient turns cannot carry micro actions");
  assert.deepEqual(doc.ctrs, { feedback: 3 });
  assert.deepEqual(doc.ui, { phase: 1, step: "state" });
});
