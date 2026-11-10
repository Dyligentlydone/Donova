# 13 — Desktop App (`apps/desktop`)

Goal: a non-technical creator downloads one installer, opens it, drops in a clip, and
gets a rendered video — no terminal, no Homebrew, no Node install.

## 1. Architecture (Electron)
- **Main process**: window management, menus, auto-update, deep links (`editnce://open?project=…`, `editnce://auth/callback`), file associations (`.editnce` project bundles), single-instance lock.
- **Utility process** (`utilityProcess.fork`): runs `@editnce/studio-server` (Node APIs available) on `127.0.0.1:<random>` with a per-launch session token.
- **Renderer**: loads Studio from the local server URL (same origin as previews). `contextIsolation: true`, `nodeIntegration: false`, `sandbox: true`; a minimal preload exposes `window.editnceDesktop = { openFolder, revealInFinder, getVersion, onUpdate, keychainGet/Set }` via `contextBridge`.
- **Bundled binaries** (in `resources/bin/<platform>-<arch>/`): `ffmpeg`, `ffprobe` (LGPL/GPL static builds — choose LGPL build if distributing proprietary app, and add license texts), `whisper-cli`. `chrome-headless-shell` downloaded on first launch into app data (≈100 MB) with progress UI (or bundled in a "full" installer variant). Engine resolves binaries through env vars set by main process.

## 2. Projects
- Default projects folder: `~/Editnce/` (NOT Documents/iCloud/Dropbox — sync clients corrupt media while writing; warn if chosen folder is synced).
- Home screen: recent projects (thumbnail, duration, modified), "New video" (template gallery with previews), "Edit a clip" (drop zone → creates project from `talking-head-captions` template with the clip imported, auto-transcribes).

## 3. First-run onboarding
1. Welcome → choose: "Edit my footage" / "Make from scratch" / "Make from a brief (AI)".
2. Optional sign-in (cloud features) via system browser + deep link callback.
3. Optional AI setup: hosted (signed in) or BYO Anthropic/OpenAI key (stored in OS keychain via `keytar`).
4. Background: download chrome-headless-shell and whisper `base` model with progress.

## 4. Native integrations
- Drag & drop files onto window → upload/copy into `assets/` (copy by default; "link instead" option for huge files).
- Menu bar: File (New, Open, Open Recent, Import Media, Export…), Edit (Undo/Redo routed to Studio history), View, Help (docs, report a bug → opens prefilled issue form with diagnostics zip excluding media).
- Notifications on render complete; dock progress bar during renders.
- Power save blocker during renders.

## 5. Updates, signing, distribution
- `electron-builder`: macOS universal `.dmg` (+ `.zip` for updates), Windows NSIS `.exe` (x64 + arm64), Linux `.AppImage` + `.deb`.
- macOS: Developer ID signing + hardened runtime + notarization (`notarytool`); entitlements allow JIT (Chrome) and child process exec of bundled binaries.
- Windows: code signing (EV or Azure Trusted Signing).
- Auto-update: `electron-updater` against a static update feed on R2/CDN (`latest-mac.yml` etc.); channels `stable` / `beta`; staged rollout percentage.
- Crash reporting: Sentry (opt-in).

## 6. Acceptance criteria
- Clean macOS VM without Node/FFmpeg/Homebrew: install DMG → open → drop sample clip → captions generated → render MP4 → file plays.
- Same on clean Windows 11 VM.
- Update from vN to vN+1 via feed works; rollback by publishing older version as latest works.
- No Node integration in renderer (Electron security checklist passes: `electronegativity` scan clean).
