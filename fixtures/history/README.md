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
| 12 | intentionally unbuildable revision | syntax error, message contains `INTENTIONALLY_UNBUILDABLE` |
| 13 | fix build again | back to green |

Every commit carries `data-ui-entity="catalog.productChooser"` anchors inside rendered
markup strings, so anchor-based matching works across the whole corpus without a build.

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
