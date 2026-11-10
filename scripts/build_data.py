"""Build the annotation taxonomy and the private session seed.

Outputs
-------
frontend/taxonomy.js     public ES module: macro/micro actions, conversation-state dimensions, CTRS items
scripts/selection.json   public: which dataset sessions were selected and why (indices + scores only)
data/sessions.json       PRIVATE (git-ignored): selected transcripts
data/seed.sql            PRIVATE (git-ignored): SQL loading the transcripts into D1 (npm run db:seed:remote)

Selection rule (one session per patient, so 10 distinct patients):
  1. eligible sessions have at least one presenting condition, <= MAX_THERAPIST_TURNS therapist
     turns and <= MAX_WORDS words (keeps turn-level annotation feasible);
  2. each patient is represented by their highest-rated eligible session (CTRS overall_sum from the
     GPT extrinsic-reward annotations; ties -> shorter session);
  3. the 10 patients whose representative session scores highest are kept (ties -> shorter).

Usage: python scripts/build_data.py [--dataset PATH] [--ctrs-csv PATH] [--components DIR] [--ctrs-module PATH]
"""
from __future__ import annotations

import argparse
import csv
import importlib.util
import json
import re
from pathlib import Path

ROOT = Path(__file__).resolve().parents[1]
TOPAS = ROOT.parents[1]

MAX_THERAPIST_TURNS = 130
MAX_WORDS = 8500
N_SESSIONS = 10


# A UTF-8 lead byte followed by continuation bytes, as they appear after a wrong cp1252 decode.
_CP1252_EXTRA = "ŒœŠšŸŽžƒˆ˜–—‘’‚“”„†‡•…‰‹›€™"
_MOJIBAKE = re.compile(f"[Â-ô][\u0080-¿{_CP1252_EXTRA}]{{1,3}}")


def _undo_mojibake(match: re.Match) -> str:
    chunk = match.group(0)
    raw = bytearray()
    for ch in chunk:
        try:
            raw += ch.encode("cp1252")
        except UnicodeEncodeError:
            if ord(ch) > 0xFF:
                return chunk
            raw.append(ord(ch))  # bytes undefined in cp1252 (0x81, 0x8d, 0x8f, 0x90, 0x9d)
    try:
        return raw.decode("utf-8")
    except UnicodeDecodeError:
        return chunk


def clean(text: str) -> str:
    """Repair double-encoded UTF-8 and normalise typography artefacts found in the source files."""
    return (
        _MOJIBAKE.sub(_undo_mojibake, str(text))
        .replace(";", ";")   # Greek question mark used as a semicolon
        .replace("­", "-")   # soft hyphen ("non-verbal")
        .replace(" ", " ")
        .strip()
    )


def load_ctrs(module_path: Path) -> dict:
    spec = importlib.util.spec_from_file_location("ctrs_rubric", module_path)
    module = importlib.util.module_from_spec(spec)
    spec.loader.exec_module(module)

    def items(part_items, part):
        return [
            {
                "key": it["key"],
                "label": clean(it["label"]),
                "part": part,
                "anchors": {str(k): clean(v) for k, v in module.CODE_ANCHORS[it["key"]].items()},
                "note": clean(module.PART_NOTES[it["key"]]) if it["key"] in module.PART_NOTES else "",
            }
            for it in part_items
        ]

    return {
        "scale": [
            {"value": 0, "label": "Poor"},
            {"value": 1, "label": "Barely adequate"},
            {"value": 2, "label": "Mediocre"},
            {"value": 3, "label": "Satisfactory"},
            {"value": 4, "label": "Good"},
            {"value": 5, "label": "Very good"},
            {"value": 6, "label": "Excellent"},
        ],
        "parts": [
            {"key": "part1", "title": clean(module.PART1_CRITERIA_TITLE)},
            {"key": "part2", "title": clean(module.PART2_CRITERIA_TITLE)},
        ],
        "items": items(module.PART1_ITEMS, "part1") + items(module.PART2_ITEMS, "part2"),
    }


def build_taxonomy(components: Path, ctrs_module: Path) -> dict:
    macros = json.loads((components / "micro_actions.json").read_text(encoding="utf-8"))
    states = json.loads((components / "conversation_states.json").read_text(encoding="utf-8"))
    return {
        "macro_actions": [
            {
                "name": clean(m["name"]),
                "description": clean(m["description"]),
                "goal": {
                    "objective": clean(m["goal"]["objective"]),
                    "success_levels": {k: clean(v) for k, v in m["goal"]["success_levels"].items()},
                    "reward_hint": clean(m["goal"]["reward_hint"]),
                },
                "micro_actions": [
                    {"name": clean(a["name"]), "description": clean(a["description"])}
                    for a in m["micro_actions"]
                ],
            }
            for m in macros
        ],
        "state_dimensions": [
            {
                "name": clean(s["Variable Name"]),
                "description": clean(s["Description"]),
                "values": [clean(v) for v in s["Categorical values"]],
            }
            for s in states
        ],
        "ctrs": load_ctrs(ctrs_module),
    }


def select_sessions(dataset: list, ctrs_rows: list) -> list[dict]:
    best: dict[str, dict] = {}
    for row in ctrs_rows:
        u, s = int(row["user_idx"]), int(row["session_idx"])
        user = dataset[u]
        session = user["sessions"][s]
        md = session["session_metadata"]
        dialogue = session["dialogue"]
        therapist_turns = sum(1 for t in dialogue if t["speaker"] == "system")
        words = sum(len(t["text"].split()) for t in dialogue)
        if not md.get("presenting conditions") or therapist_turns > MAX_THERAPIST_TURNS or words > MAX_WORDS:
            continue
        candidate = {
            "user_idx": u,
            "session_idx": s,
            "patient": user["user_metadata"]["patient"],
            "ctrs_overall_sum": int(row["overall_sum"]),
            "ctrs_part1_sum": int(row["part1_sum"]),
            "ctrs_part2_sum": int(row["part2_sum"]),
            "therapist_turns": therapist_turns,
            "turns": len(dialogue),
            "words": words,
        }
        key = candidate["patient"]
        rank = (candidate["ctrs_overall_sum"], -words)
        if key not in best or rank > (best[key]["ctrs_overall_sum"], -best[key]["words"]):
            best[key] = candidate
    chosen = sorted(best.values(), key=lambda c: (-c["ctrs_overall_sum"], c["words"]))[:N_SESSIONS]
    # Present shorter sessions first so experts can warm up.
    return sorted(chosen, key=lambda c: (c["therapist_turns"], c["words"]))


def sql_str(value) -> str:
    if value is None:
        return "NULL"
    if isinstance(value, (int, float)):
        return str(value)
    return "'" + str(value).replace("'", "''") + "'"


def write_seed_sql(sessions: list[dict], path: Path) -> None:
    """Replace the session catalogue and transcripts; annotations and experts are untouched."""
    lines = [
        "-- Generated by scripts/build_data.py. Contains licensed transcripts: never commit.",
        "DELETE FROM session_turns;",
        "DELETE FROM sessions;",
    ]
    for s in sessions:
        values = (s["id"], s["display_order"], s["user_idx"], s["session_idx"], s["patient"], s["title"], s["summary"],
                  json.dumps(s["conditions"], ensure_ascii=False), s["therapist_turns"], s["patient_turns"],
                  s["word_count"], s["ctrs_overall_sum"])
        lines.append("INSERT INTO sessions (id, display_order, user_idx, session_idx, patient, title, summary, conditions_json, "
                     "therapist_turns, patient_turns, word_count, ctrs_overall_sum) VALUES (" + ", ".join(map(sql_str, values)) + ");")
        for t in s["turns"]:
            values = (s["id"], t["turn_index"], t["speaker"], t["utterance_id"], t["text"])
            lines.append("INSERT INTO session_turns (session_id, turn_index, speaker, utterance_id, text) VALUES ("
                         + ", ".join(map(sql_str, values)) + ");")
    path.write_text("\n".join(lines) + "\n", encoding="utf-8")


def main() -> None:
    parser = argparse.ArgumentParser(description=__doc__, formatter_class=argparse.RawDescriptionHelpFormatter)
    parser.add_argument("--dataset", type=Path, default=TOPAS / "topa-server/topa/data/datasets/CBT/AlexanderStreet_Dataset.json")
    parser.add_argument("--ctrs-csv", type=Path, default=TOPAS / "baselines/extrinsic_reward/CBT/annotations_extrinsic_reward.csv")
    parser.add_argument("--components", type=Path, default=TOPAS / "new_simulations/topa_components")
    parser.add_argument("--ctrs-module", type=Path, default=TOPAS / "topa-server/topa/reward/cbt/__init__.py")
    args = parser.parse_args()

    taxonomy = build_taxonomy(args.components, args.ctrs_module)
    (ROOT / "frontend/taxonomy.js").write_text(
        "// Generated by scripts/build_data.py from topa_components and the CTRS rubric. Do not edit by hand.\n"
        "// Shared by the browser and the Cloudflare Worker.\n"
        "export const TAXONOMY = " + json.dumps(taxonomy, ensure_ascii=False, indent=1) + ";\n",
        encoding="utf-8",
    )
    print(f"taxonomy: {len(taxonomy['macro_actions'])} macro actions, "
          f"{sum(len(m['micro_actions']) for m in taxonomy['macro_actions'])} micro actions, "
          f"{len(taxonomy['state_dimensions'])} state dimensions, {len(taxonomy['ctrs']['items'])} CTRS items")

    dataset = json.loads(args.dataset.read_text(encoding="utf-8"))
    with args.ctrs_csv.open(encoding="utf-8") as handle:
        ctrs_rows = list(csv.DictReader(handle))
    selection = select_sessions(dataset, ctrs_rows)

    sessions = []
    for order, sel in enumerate(selection, start=1):
        source = dataset[sel["user_idx"]]["sessions"][sel["session_idx"]]
        md = source["session_metadata"]
        counters = {"therapist": 0, "patient": 0}
        turns = []
        for index, turn in enumerate(source["dialogue"]):
            speaker = "therapist" if turn["speaker"] == "system" else "patient"
            turns.append({
                "turn_index": index,
                "speaker": speaker,
                "utterance_id": f"{speaker}_{counters[speaker]}",
                "text": clean(turn["text"]),
            })
            counters[speaker] += 1
        sessions.append({
            "id": f"S{order:02d}",
            "display_order": order,
            "user_idx": sel["user_idx"],
            "session_idx": sel["session_idx"],
            "patient": sel["patient"],
            "title": clean(md.get("Title", "")),
            "summary": clean(md.get("summary", "")),
            "conditions": [clean(c) for c in md.get("presenting conditions", [])],
            "therapist_turns": counters["therapist"],
            "patient_turns": counters["patient"],
            "word_count": sel["words"],
            "ctrs_overall_sum": sel["ctrs_overall_sum"],
            "turns": turns,
        })

    (ROOT / "data").mkdir(exist_ok=True)
    (ROOT / "data/sessions.json").write_text(json.dumps(sessions, ensure_ascii=False, indent=1), encoding="utf-8")
    write_seed_sql(sessions, ROOT / "data/seed.sql")

    public_selection = {
        "rule": {
            "one_session_per_patient": True,
            "requires_presenting_condition": True,
            "max_therapist_turns": MAX_THERAPIST_TURNS,
            "max_words": MAX_WORDS,
            "ranking": "CTRS overall_sum from baselines/extrinsic_reward/CBT/annotations_extrinsic_reward.csv (ties: fewer words)",
            "n_sessions": N_SESSIONS,
        },
        "sessions": [
            {k: s[k] for k in ("id", "user_idx", "session_idx", "patient", "conditions", "therapist_turns",
                               "patient_turns", "word_count", "ctrs_overall_sum")}
            for s in sessions
        ],
    }
    (ROOT / "scripts/selection.json").write_text(json.dumps(public_selection, ensure_ascii=False, indent=1) + "\n", encoding="utf-8")

    for s in sessions:
        print(f"{s['id']}  patient={s['patient']:<11} u{s['user_idx']:<2} s{s['session_idx']:<3} "
              f"CTRS={s['ctrs_overall_sum']}  therapist_turns={s['therapist_turns']:<3} words={s['word_count']:<5} {s['conditions']}")


if __name__ == "__main__":
    main()
