# Verified Agent Skills research — software dev / architecture / UI-UX (Vibe Coding)

Researched 2026-11-12. Data sources: live [skills.sh](https://www.skills.sh) pages (Vercel's agent-skills directory — they render the real `SKILL.md` body and show the source repo's GitHub star count), the npm registry, and unpkg. Nothing was installed.

## 0. Verification caveat (read first)

`web_fetch` in this environment **cannot reach github.com, raw.githubusercontent.com, codeload, objects.githubusercontent.com, or jsdelivr** (TLS/DNS failures); the shell has no network at all. So raw-URL fetching was impossible. Instead, each **VERIFIED** skill below was confirmed by **reading its actual `SKILL.md` body** as rendered by skills.sh (which mirrors the repo file), plus live stars from the same page. Raw-URL strings in the tables are constructed from each repo's verified layout.

**Frontmatter caveat:** skills.sh strips YAML frontmatter when rendering. Frontmatter itself was verified only indirectly (the Agent Skills spec requires `name` + `description`: <https://agentskills.io/specification>, and the `skills` CLI docs at <https://app.unpkg.com/skills@1.8.1/files/docs/creating-skills.md>). Several skills use *link-only stubs* (e.g. `grill-me` is literally `Call the Skill tool with "grilling".`; `implement` similarly delegates) — those are poor standalone installs.

## 1. Source repos (all verified on skills.sh, stars live)

| Repo | Stars | License (source) | Skill layout | Skills |
|---|---|---|---|---|
| https://github.com/anthropics/skills | 193.1K | Apache-2.0 | `skills/<name>/SKILL.md` (+`scripts/`) | 21 |
| https://github.com/obra/superpowers | 316.3K | MIT | `skills/<name>/SKILL.md` | 15 |
| https://github.com/mattpocock/skills | 321.9K | MIT | `skills/<category>/<name>/SKILL.md` (e.g. `skills/engineering/tdd/`), with `references/` siblings | 56 |
| https://github.com/addyosmani/agent-skills | 116.0K | MIT | `skills/<name>/SKILL.md` | 25 |
| https://github.com/pbakaus/impeccable | 108.3K | **Apache-2.0** (npm `impeccable@4.8.2`) | `skills/<name>/SKILL.md`; npm ships only a `skill/scripts/` stub | 24 |
| https://github.com/vercel-labs/agent-skills | 33.9K | MIT | `skills/<name>/SKILL.md` | 16 |
| https://github.com/emilkowalski/skills | 56.1K | MIT (per directory listing) | `<name>/SKILL.md` at repo root | 18 |
| https://github.com/wshobson/agents | 42.4K | MIT | **`plugins/<plugin>/skills/<name>/SKILL.md`** (nested, not flat) | 185 |
| https://github.com/nextlevelbuilder/ui-ux-pro-max-skill | 148.2K | not established | `skills/<name>/SKILL.md` | 19 |
| https://github.com/github/awesome-copilot | 41.1K | MIT | `skills/<name>/SKILL.md` under `skills/` (catalog layout) | 486 |
| https://github.com/shubhamsaboo/awesome-llm-apps | 144.4K | repo is Apache-2.0 | `skills/<name>/SKILL.md` (catalog has `rules/` subfolders) | 27 |
| https://github.com/leonxlnx/taste-skill | 113.5K | not established | `skills/<name>/SKILL.md` | few |
| https://github.com/shadcn-ui/ui | 127.9K | MIT | `skills/shadcn/SKILL.md` (embedded in the UI repo — heavy) | 1 |
| https://github.com/microsoft/skills | 3.2K | MIT (typical) | `skills/<name>/SKILL.md` | 228 |

Notes: `wshobson/agents` is the best-stocked architecture/DDD/ADR source but is **not** a simple `skills/<name>` layout — the assembler must handle `plugins/*/skills/<name>`. `ui-ux-pro-max` and `taste-skill` embed setup scripts and have mixed security telemetry (Socket/Snyk warns; Taste "Gen Agent Trust Hub: Fail").

## 2. VERIFIED shortlist (SKILL.md body read)

| # | Repo | Skill | Raw URL | What it does |
|---|---|---|---|---|
| 1 | anthropics | `frontend-design` | `raw.githubusercontent.com/anthropics/skills/main/skills/frontend-design/SKILL.md` | Opinionated aesthetic direction (palette/type/layout) before writing UI code; kills generic AI look. 1.1M installs. |
| 2 | anthropics | `webapp-testing` | `.../anthropics/skills/main/skills/webapp-testing/SKILL.md` | Python Playwright QA of a local web app; ships `scripts/with_server.py` for server lifecycle; recon-then-act loop. |
| 3 | anthropics | `mcp-builder` | `.../anthropics/skills/main/skills/mcp-builder/SKILL.md` | 4-phase blueprint for MCP servers: research → implement → test → eval with tool-annotation and schema guidance. |
| 4 | anthropics | `canvas-design` | `.../anthropics/skills/main/skills/canvas-design/SKILL.md` | Design philosophy → PNG/PDF poster artefacts; useful for brand/presentation-grade visuals. |
| 5 | obra/superpowers | `systematic-debugging` | `.../obra/superpowers/main/skills/systematic-debugging/SKILL.md` | "Iron Law": no fix before root-cause investigation; 4-phase loop, stops after 3 failed fixes to question architecture. |
| 6 | obra/superpowers | `brainstorming` | `.../obra/superpowers/main/skills/brainstorming/SKILL.md` | Hard gate: no code until design is presented and approved; 9-step socratic design dialogue. |
| 7 | mattpocock | `tdd` | `.../mattpocock/skills/main/skills/engineering/tdd/SKILL.md` | Vertical-slice TDD at pre-agreed "seams"; behaviour tests through public interfaces; sibling `tests.md`, `mocking.md`. |
| 8 | mattpocock | `codebase-design` | `.../mattpocock/skills/main/skills/engineering/codebase-design/SKILL.md` | Deep-module vocabulary (interface, depth, seam, adapter) — the shared language other skills reference. |
| 9 | mattpocock | `improve-codebase-architecture` | `.../mattpocock/skills/main/skills/engineering/improve-codebase-architecture/SKILL.md` | Finds shallow modules from git hotspots, runs parallel design sub-agents, emits RFC issue. 1.3M installs. |
| 10 | mattpocock | `domain-modeling` | `.../mattpocock/skills/main/skills/engineering/domain-modeling/SKILL.md` | Builds/sharpen `GLOSSARY.md` + `docs/adr/` as you design; DDD-flavoured, multi-context via `GLOSSARY-MAP.md`. |
| 11 | mattpocock | `diagnosing-bugs` | `.../mattpocock/skills/main/skills/engineering/diagnosing-bugs/SKILL.md` | Phase 1 = build a tight red/green feedback loop; redaction rules; hypothesis→instrument→bisect. |
| 12 | mattpocock | `code-review` | `.../mattpocock/skills/main/skills/engineering/code-review/SKILL.md` | Two-axis diff review (repo standards vs originating spec) via parallel isolated sub-agents. |
| 13 | mattpocock | `prototype` | `.../mattpocock/skills/main/skills/engineering/prototype/SKILL.md` | Throwaway prototype answering one question: logic state-machine walkthrough or N toggleable UI variants on one route. |
| 14 | addyosmani | `api-and-interface-design` | `.../addyosmani/agent-skills/main/skills/api-and-interface-design/SKILL.md` | Hyrum's Law-driven API/module/prop contract design; "hard to misuse" principle. |
| 15 | addyosmani | `documentation-and-adrs` | `.../addyosmani/agent-skills/main/skills/documentation-and-adrs/SKILL.md` | ADR-first "document decisions not code"; when NOT to document. |
| 16 | addyosmani | `code-review-and-quality` | `.../addyosmani/agent-skills/main/skills/code-review-and-quality/SKILL.md` | Five-axis review (correctness, readability, architecture, security, performance) + approval standard. |
| 17 | addyosmani | `frontend-ui-engineering` | `.../addyosmani/agent-skills/main/skills/frontend-ui-engineering/SKILL.md` | Production UI: design-system adherence, a11y, interaction patterns, "no generic AI aesthetic". |
| 18 | addyosmani | `code-simplification` | `.../addyosmani/agent-skills/main/skills/code-simplification/SKILL.md` | Behaviour-preserving complexity reduction; adapted from Anthropic's code-simplifier agent. |
| 19 | vercel-labs | `web-design-guidelines` | `.../vercel-labs/agent-skills/main/skills/web-design-guidelines/SKILL.md` | Fetches Vercel's Web Interface Guidelines at review time, outputs terse `file:line` findings. 853K installs. |
| 20 | vercel-labs | `vercel-react-best-practices` | `.../vercel-labs/agent-skills/main/skills/vercel-react-best-practices/SKILL.md` | 70 impact-ranked React/Next perf rules (waterfalls, bundle, re-renders). 893K installs. |
| 21 | wshobson | `architecture-decision-records` | `.../wshobson/agents/main/plugins/documentation-generation/skills/architecture-decision-records/SKILL.md` | MADR/Y-statement/deprecation/RFC ADR templates + lifecycle. Plugin path UNVERIFIED. |
| 22 | wshobson | `architecture-patterns` | `.../wshobson/agents/main/plugins/backend-development/skills/architecture-patterns/SKILL.md` | Clean/Hexagonal/DDD with aggregate & value-object examples, Python/FastAPI. Plugin path UNVERIFIED. |
| 23 | emilkowalski | `emil-design-eng` | `.../emilkowalski/skills/main/emil-design-eng/SKILL.md` | "Taste is trained": craft-level detail philosophy from Linear's design engineer. |
| 24 | emilkowalski | `apple-design` | `.../emilkowalski/skills/main/apple-design/SKILL.md` | WWDC "Designing Fluid Interfaces" translated to web: velocity, springs, interruptibility. |

Hosted mirrors used: `https://www.skills.sh/<owner>/<repo>/<skill>` — verified working for every row above except the two `wshobson` plugin paths (row paths inferred). A workable non-GitHub fetch path exists for `impeccable` only via `app.unpkg.com` (scripts stub, no SKILL.md).

## 3. UNVERIFIED candidates (listed/described only)

- `wshobson/agents`: `code-review-excellence`, `tailwind-design-system`, `design-system-patterns`, `wcag-audit-patterns`, `e2e-testing-patterns`, `typescript-advanced-types`, `microservices-patterns`, `cqrs-implementation`, `event-store-design`, `saga-orchestration`.
- `pbakaus/impeccable`: `critique` (read), `polish` (read), `audit`, `distill`, `extract`.
- `nextlevelbuilder/ui-ux-pro-max-skill`: `ui-ux-pro-max`, `design-system`, `ui-styling` (bodies read; setup scripts + mixed audit results — inspect before use).
- `microsoft/skills`: `frontend-design-review`, `cloud-solution-architect` (bodies read; low stars).
- `github/awesome-copilot`: `acquire-codebase-knowledge`, `web-design-reviewer`, `create-architectural-decision-record`.
- `leonxlnx/taste-skill`: `design-taste-frontend` (body read; one audit partner = Fail).
- `shubhamsaboo/awesome-llm-apps`: `code-reviewer` (body read; needs its `rules/` folder).
- `anthropics/skills`: `web-artifacts-builder`, `theme-factory` (catalog only).

## 4. Recommended minimal stack for Vibe Coding

Design (pick 3): `frontend-design` + `web-design-guidelines` + `emil-design-eng`. Process (pick 3): `tdd` + `diagnosing-bugs` + `code-review` (mattpocock) or `code-review-and-quality`. Architecture (pick 2): `codebase-design` + `domain-modeling` / `documentation-and-adrs`. Tools (pick 2): `webapp-testing`, `mcp-builder`. Avoid installing stubs (`grill-me`, `implement`) alone.
