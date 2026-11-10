# CBT Session Annotation

Expert annotation website for CBT session transcripts using the TOPAS components.

- **Website:** https://saif-daoud.github.io/cbt-annotation/
- **API:** https://cbt-annotation-api.saif-sedaoud.workers.dev (Cloudflare Worker + SQLite Durable Object)

## What experts do

Experts sign in with their **email address** (the unique identifier) and the shared study access code. On first sign-in they fill in a short profile: full name, role or specialty, institution, latest degree and years of clinical experience. Returning experts continue where they left off; all work is autosaved.

Each of the 10 sessions is annotated in two stages followed by a rating:

| Stage | Task |
| --- | --- |
| **1 · Read & segment** | Read the transcript (with summary and presenting conditions) and split it into phases. Each phase is labelled with one of the 12 macro actions, or **Other** with a description. |
| **2 · Annotate phases** | For each phase, in order: (a) update the **conversation state** at the start of the phase: all 62 dimensions start at *None* and carry over, so the expert only changes what changed; (b) label every therapist turn with a **micro action** of the phase's macro action, or *None* for minimal responses, or **Other** with a description; (c) rate the **intrinsic reward** using the macro action's goal rubric (0 unsuccessful, 1 acceptable, 2 ideal). |
| **3 · CTRS rating** | Score the 11 CTRS items (0–6) with the anchors from `topa-server/topa/reward/cbt`, then submit. |

The taxonomy comes from `new_simulations/topa_components/micro_actions.json` (macro actions, goals and micro actions) and `conversation_states.json`. `user_profile.json` and `macro_actions.json` are not used. The scales match the TOPAS annotators: one micro action per therapist utterance (`"None"` if nothing fits), and an intrinsic reward from 0 to 2.

## Session selection

`scripts/build_data.py` picks 10 sessions from `AlexanderStreet_Dataset.json` using the GPT CTRS scores in `baselines/extrinsic_reward/CBT/annotations_extrinsic_reward.csv`:

1. eligible sessions have at least one presenting condition, at most 130 therapist turns and at most 8,500 words, so turn-level annotation stays feasible;
2. each patient is represented by their highest-rated eligible session (one session per patient);
3. the 10 patients whose session scores highest are kept (CTRS totals 55–66 of 66), ordered from shortest to longest.

The selection, with dataset indices, is recorded in [`scripts/selection.json`](scripts/selection.json). Experts never see the GPT scores.

**The transcripts are licensed and are never committed.** `data/` is git-ignored, and the transcripts live only in the Cloudflare database. The Worker serves them only to signed-in experts.

## Layout

```text
frontend/            static site (GitHub Pages), no build step
  app.js             UI
  model.js           annotation document model and validation (shared with the Worker)
  taxonomy.js        generated: macro/micro actions, state dimensions, CTRS items
worker/              Cloudflare Worker API
  src/index.js       routes: login, profile, sessions, autosave, submit, reopen, admin seed/export
  src/entry.js       Durable Object (SQLite) wrapper
  local_server.mjs   local preview of site + API using node:sqlite
  tests/             model and end-to-end API tests
scripts/
  build_data.py      regenerate taxonomy.js, selection.json and data/sessions.json
  seed.mjs           load data/sessions.json into an API
  export.mjs         download all annotations
```

## Run locally

```bash
python scripts/build_data.py                 # creates data/sessions.json (private)
cd worker && npm install
cp .dev.vars.example .dev.vars               # local secrets
npm run dev:local                            # http://127.0.0.1:8787
# in another terminal:
ADMIN_TOKEN=<ADMIN_TOKEN from .dev.vars> node ../scripts/seed.mjs --api http://127.0.0.1:8787
```

Sign in with any email address and the `ACCESS_CODE` from `.dev.vars`. `wrangler dev` also works where the `workerd` binary is allowed to run.

Tests: `cd worker && npm test`.

## Deploy

GitHub Actions does the following on every push to `main`:

- `pages.yml` publishes `frontend/` to GitHub Pages (**Settings → Pages → Source: GitHub Actions**);
- `worker.yml` runs the tests and deploys the Worker when the repository secrets `CLOUDFLARE_API_TOKEN` and `CLOUDFLARE_ACCOUNT_ID` are set; otherwise it only tests.

The Worker's runtime secrets live in Cloudflare and persist across deploys. Set them once:

```bash
cd worker
npx wrangler secret put ACCESS_CODE     # shared code given to experts
npx wrangler secret put TOKEN_SECRET    # long random string (signs login tokens)
npx wrangler secret put ADMIN_TOKEN     # long random string (seed/export)
ADMIN_TOKEN=... node ../scripts/seed.mjs --api https://cbt-annotation-api.saif-sedaoud.workers.dev
```

Re-seeding replaces the sessions and transcripts but keeps all annotations. If the frontend is hosted somewhere else, add its origin to `ALLOWED_ORIGINS` in `worker/wrangler.toml`.

## Export the annotations

```bash
ADMIN_TOKEN=... node scripts/export.mjs [--snapshots]   # writes exports/cbt-annotation-<time>.json (git-ignored)
```

Each record contains the expert's email, session and dataset indices (`dataset_user_idx`, `dataset_session_idx`), status, active time, and:

- `annotation.phases[]`: turn range, first/last therapist `utterance_id` (TOPAS numbering, `therapist_N`), macro action (or `Other` + description), state updates, full `state_at_start` (62 dimensions, `None` when unset), intrinsic reward and comment;
- `annotation.micro_actions[]`: one entry per therapist utterance with its micro action (`None`, or `Other` + description);
- `annotation.ctrs`: the 11 item scores, part sums, total and comments;
- `raw`: the stored document.

`--snapshots` adds the immutable copies saved at every stage transition, submission and reopening.

Before inviting experts, add any consent, withdrawal and contact wording your ethics approval requires.
