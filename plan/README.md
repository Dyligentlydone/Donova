# Editnce build plan — index

Start with `../AGENTS.md`, then `STATUS.md`, then `17-VIBE-EDIT.md`, then
`00-OVERVIEW.md`, then follow `16-BUILD-ORDER.md` (MV track first).

| File | Covers |
|---|---|
| `00-OVERVIEW.md` | Product, the five core ideas, architecture, stack, repo layout, milestones, glossary |
| `01-COMPOSITION-CONTRACT.md` | HTML file format: attributes, timing expressions, variables, sub-compositions, config, parser API |
| `02-RUNTIME.md` | Injected browser runtime: boot, determinism shims, seek algorithm, adapters, media, bridge, pick mode |
| `03-ENGINE.md` | Chrome launch/capture (beginFrame + screenshot), video frame extraction, encoders, audio mixer, parallelism |
| `04-PRODUCER.md` | Render pipeline stages, compile step, errors, HTTP render server |
| `05-PLAYER.md` | `<fc-player>` web component |
| `06-CLI.md` | Every CLI command and flag, output conventions, templates |
| `07-LINT-AND-CHECK.md` | Static lint rule set and browser check gate |
| `08-STUDIO.md` | Editor UI, interactions, timeline, save/undo protocol, studio-server API |
| `09-AGENT-AND-SKILLS.md` | Skills content + install, built-in agent tools/loop, evals |
| `10-MEDIA-AI.md` | Probe, transcription, captions, TTS, background removal, beats, stock/gen providers, color grading |
| `11-REGISTRY.md` | Blocks/components format, client, CI, first-party catalog |
| `12-CLOUD-PLATFORM.md` | Accounts, device auth, cloud render sharding, publish, AI proxy, billing, legal checklist |
| `13-DESKTOP-APP.md` | Electron app, bundling, onboarding, signing, updates |
| `14-DIFFERENTIATORS.md` | Footage-first editing, Style Bible, incremental render, browser export |
| `15-TESTING.md` | Test layers, fixtures, golden/determinism/parity harness, perf budgets, CI |
| `16-BUILD-ORDER.md` | Ordered task list with acceptance criteria (MV track first) |
| `17-VIBE-EDIT.md` | **North star + priority track**: agent tools, style.md, footage skills, neutral blocks + SFX, SDK/MCP, Studio chat, render speed, background removal, TTS, evals |
| `STATUS.md` | What exists today, verified results, lessons learned, divergences from the plan |

Reference implementation (read-only, Apache-2.0): `../_analysis/hyperframes-src/`.
