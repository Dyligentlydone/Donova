# AGENTS.md — Instructions for the model building this project

You are building **Framecraft** (working codename — see "Naming" below): a complete,
production-grade "write HTML, render video" platform with an AI editing agent, a
browser/desktop editor (Studio), a CLI, a cloud render service, and a block registry.
It is a from-scratch rebuild of the architecture of HeyGen's open-source HyperFrames,
plus a set of product improvements aimed at creators editing their own footage.

## Read in this order

1. `plan/00-OVERVIEW.md` — what we are building, architecture, stack, repo layout.
2. `plan/16-BUILD-ORDER.md` — the ordered task list. **Work strictly in this order.**
3. The spec file referenced by the task you are on (`plan/01-…` through `plan/15-…`).

Do not start coding a subsystem before reading its spec end to end.

## How to work

- Take one task from `plan/16-BUILD-ORDER.md` at a time. Each task lists its spec
  section, its dependencies, and **acceptance criteria**. A task is done only when
  every acceptance criterion passes and is covered by an automated test where the
  criterion says so.
- After finishing a task, tick it in `plan/16-BUILD-ORDER.md` (`- [x]`) and add a
  one-line note under it if you made a decision the spec left open.
- If the spec is ambiguous, pick the simplest option that satisfies the acceptance
  criteria, record the decision in `plan/DECISIONS.md` (create it), and continue.
  Do not stall.
- If a spec decision turns out to be wrong after implementation (e.g. an API does not
  behave as described), fix the code, update the spec file, and log it in
  `plan/DECISIONS.md`.
- Never mark a task done because "it should work". Run it.

## Reference source (read-only)

`_analysis/hyperframes-src/` is a shallow clone of `github.com/heygen-com/hyperframes`
(Apache-2.0). You MAY read it to understand edge cases (it is the best reference for
how a hard problem was solved). Rules:

- Write our own implementation. Do not bulk-copy files.
- If you copy any non-trivial snippet (>~15 lines) verbatim or near-verbatim, keep its
  Apache-2.0 copyright header on that file and add an entry to `NOTICE` at the repo root.
- Never use the names "HyperFrames" or "HeyGen" in our product, packages, globals,
  env vars, or UI. Use our own names (see Naming).
- `_analysis/` must stay out of our git history (it is in `.gitignore`).

## Naming (single source of truth)

| Thing | Value |
|---|---|
| Product name | Framecraft (placeholder; may be renamed later by find/replace) |
| npm scope | `@framecraft/*` |
| CLI binary | `framecraft` (alias `fc`) |
| Browser global namespace | `window.__fc` |
| Timeline registry global | `window.__timelines` (kept generic on purpose) |
| Env var prefix | `FRAMECRAFT_` |
| Project config file | `framecraft.json` |
| Config dir | `~/.config/framecraft/` (XDG), cache `~/.cache/framecraft/` |
| postMessage sources | `fc-parent` (host → runtime), `fc-runtime` (runtime → host) |
| CSS/attr prefix for internal markers | `__fc-` / `data-fc-` |

Keep all of these defined as constants in `packages/contract/src/names.ts` and import
them everywhere so a rename is a one-file change.

## Engineering conventions

- **Language**: TypeScript everywhere, `strict: true`, no `any`, no `as T` casts unless
  narrowing is impossible (comment why).
- **Runtime**: Node.js >= 22. Package manager: **pnpm workspaces** (`pnpm-workspace.yaml`).
  Use `pnpm` for all workspace operations.
- **Build**: `tsup` for Node packages, `esbuild` for the browser runtime IIFE, `vite` for
  the Studio and web apps.
- **Tests**: `vitest` for unit/integration. Playwright for Studio e2e. Golden-render
  tests per `plan/15-TESTING.md`.
- **Lint/format**: Biome (`biome.json` at root). `pnpm lint` and `pnpm format` must pass.
- **Commits**: Conventional commits (`feat:`, `fix:`, `docs:`, `refactor:`, `test:`, `chore:`).
- **Files**: keep source files under ~600 lines; split by responsibility.
- **Errors**: typed error classes with a stable `code` string (e.g. `E_FFMPEG_MISSING`)
  and a human hint. CLI prints hint; `--json` prints `{code, message, hint}`.
- **Determinism is a hard rule** in anything that touches rendering: no wall clock, no
  unseeded randomness, no network during capture. See `plan/02-RUNTIME.md`.
- **GSAP rule (licensing, hard)**: GSAP is used only as code (written by users or the AI
  agent). No Studio/no-code UI feature may generate, edit, or delete GSAP code; visual
  animation features write `data-fc-motion` only (see `plan/12-CLOUD-PLATFORM.md §9`).
  Keep GSAP's license/branding headers intact in vendored files.
- **Out of scope**: AI avatars / talking-presenter generation. Do not build or integrate.
- **Security**: never log secrets; API keys only from env or the OS keychain/config file
  with `0600` permissions; studio-server binds to `127.0.0.1` only.

## Verification commands (keep these working)

```bash
pnpm install
pnpm build            # builds all packages
pnpm test             # unit + integration
pnpm test:golden      # golden render tests (needs ffmpeg + chrome-headless-shell)
pnpm lint
pnpm --filter @framecraft/cli exec framecraft doctor
```

System prerequisites for development: Node 22+, pnpm 9+, FFmpeg 6+ (with ffprobe),
and Chrome-for-Testing `chrome-headless-shell` (auto-downloaded by `framecraft browser ensure`).
