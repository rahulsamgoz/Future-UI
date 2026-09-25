# History fixture corpus

`generate.mjs` creates a disposable git repository (default `fixtures/history/.generated`,
override with an output-dir argument) containing **exactly 13 commits** that exercise the
identity-model cases from `docs/architecture.md` section 16:

| # | Commit | Identity-model case |
| --- | --- | --- |
| 1 | initial catalog with carousel | app shell + ProductCarousel |
| 2 | rename ProductCarousel to ProductChooser | renamed definition; semantic continuity via explicit anchor `catalog.productChooser` |
| 3 | move ProductChooser into features/catalog/ | source move; anchor unchanged |
| 4 | style-only refactor of chooser | class rename, same anchor |
| 5 | global spacing token change | tokens.css spacing 8 → 12 |
| 6 | add grid renderer | chooser now supports `grid@1` |
| 7 | repeated instances: add related-products chooser | second boundary, same contract, distinct `data-ui-instance` |
| 8 | split: product chooser splits into chooser + sort control | two boundaries (`catalog.productChooser` + `catalog.sortControl`) |
| 9 | merge: sort control merged back | sort control boundary disappears again |
| 10 | carousel → grid default | visual A→B change |
| 11 | revert to carousel default | A→B→A reversion |
| 12 | intentionally unbuildable revision | `app.js` throws on load, message contains `INTENTIONALLY_UNBUILDABLE` |
| 13 | fix build again | back to green |

## Runnable corpus

Every commit is a **runnable static app with no build step**: `index.html` (host page,
commit-distinct heading so captures are attributable) + `app.js` (renders the committed UI
into `#app` with real `data-ui-entity` anchors) + `tokens.css`/`styles.css` where the
narrative adds them. Commit 12's `app.js` throws on load, so the page never renders and
readiness is never satisfied — a genuine, honest capture failure.

`app.js` also honors the standard scenario fixture query param (`?__fixture=`): `empty`
renders zero product cards and `loading` defers rendering by 350 ms, so the standard
scenario recipes observe real pending/empty states. The committed UI renders at `/`
regardless of route; the reconstruction executor adapts the recipes accordingly
(`tolerantRecipe` in `packages/capture/src/reconstruct.ts`).

## Reconstruction

The corpus is the run target for genuine historical reconstruction:

- `packages/capture/src/reconstruct.ts` — `reconstructCommit()`: materializes a commit as a
  `git worktree`, serves the static tree on an ephemeral port (serving IS the build for this
  corpus; real apps would run their build pipeline there), runs the scenario recipes with
  `ScenarioRunner`, publishes every capture with `CaptureUploader`, and VERIFIES publication
  (capture retrievable, occurrences > 0, artifact bytes readable from the raw endpoint)
  before counting a scenario as captured. Provenance is bound in the manifest:
  `spec.commitSha` = the reconstructed commit, `buildArtifactDigest` = digest of the served
  tree. A commit whose sources declare `INTENTIONALLY_UNBUILDABLE` yields per-scenario
  EXPECTED failures — never synthetic successes.
- `apps/index-worker` `history_scan` — when the plan/job input carries `fixtureRepo`, every
  selected commit is reconstructed (extend-without-duplicating: existing captures are
  reused), and the job payload records per-commit outcomes
  (`captured` | `expected_failure` | `failed`).
- `fixtures/history/coverage.mjs` — regenerates `docs/coverage-report.json` by running the
  reconstruction over the whole corpus against the history API (`--offline` keeps producing
  the honest gap-only manifest for hermetic test runs).

## Capture slots

Combined with the six standard scenarios (`packages/capture` `standardScenarios()`) and the
two viewports (desktop 1440×900, mobile 390×844), the corpus plans

**13 commits × 6 scenarios × 2 viewports = 156 planned capture slots**

Commit 12 is intentionally unbuildable: its 12 slots (6 scenarios × 2 viewports) are
expected failures and remain explicit coverage records (`buildOutcome: "unbuildable"` in
`ground-truth.json`), not invented renders.

## Files

- `ground-truth.json` — per-commit expected entity anchors and expected build outcome.
- `.generated/` — the disposable repo produced by the script (gitignored).

The script is idempotent: it removes any previous `.generated` directory and creates a
fresh repository with local user config and fixed commit dates spanning 2026-08-01 to
2026-09-01.
