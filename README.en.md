AI Loom — Local Code & Docs Explorer
====================================

Language: 中文版请见 README.md

What it is
- A local “code/docs exploration + annotations + lightweight editor” you run in your project, browse in the browser, and keep data on your machine.
- Backend: Rust/Axum; Frontend: React/Vite; works offline.
- Data is stored in SQLite: default `~/ailoom/ailoom.db`, fallback to `.ailoom/ailoom.db` in project root; data is partitioned per workspace (normalized by nearest .git or the provided root).

Highlights
- Explorer: left tree with lazy loading and expand memory; honors `.gitignore` and optional `.ailoomignore`.
- File viewing: large files are read in chunks (default page ~1000 lines); syntax highlighting; full Markdown preview with inline anchors.
- Lightweight editing (≤ 512KB): open full editor (Monaco), save with Ctrl/⌘+S; conflict detection via content digest with refresh guidance.
- Annotations: range/line annotations, grouped list with quick jump; CRUD; floating anchors in Markdown preview.
- Realtime sync: after save the UI self-corrects within ≤1s. Reads prefer WebSocket (WS) with a short‑fuse HTTP fallback on transport/ability errors. Server broadcasts `file.changed` / `tree.changed` / `annotations.*` to drive cache invalidation and UI updates.
- Stitch generation: assemble prompt text from annotations with templates (e.g. `concise`), one‑click copy to clipboard for chat assistants.

Install & Run (recommended)
- Zero‑install:
  - In your project directory: `npx ai-loom`
  - First run downloads a prebuilt binary for your platform and opens the browser automatically.
- Global install:
  - `npm i -g ai-loom`, then run `ai-loom --root .`
- Useful flags (passed through to `ailoom-server`):
  - `--root <path>` restricts access to this subtree
  - `--db <path>` or `--db-path <path>` sets DB location
  - `--port <number>` sets port; `--no-open` disables auto‑open
  - Dev only: `--no-static` (API only, pair with Vite Dev)

Quick Start
1) Run `npx ai-loom` at your project root.
2) In the browser:
   - Pick a file on the left → view on the right; large files are paged; Markdown supports full preview.
   - Click “Enter Edit” to edit small files (≤ 512KB) and save with Ctrl/⌘+S.
   - Select a range in code or Markdown preview to add an annotation; manage them in the Annotations panel and jump back in one click.
   - Need to bring context back to chat? Click “Generate & Copy” in the Annotations panel to stitch a prompt.

Works With AI Coding (e.g., Vibe Coding)
- Leave in‑place annotations at the original file location with line ranges and context.
- Faster loops: copy snippets/paths from annotations back into the chat instead of describing “which file/which line”; assistants can better pinpoint intent.
- Great for marking “needs change/explain/risky/misaligned API” spots as a to‑do list.

Commands & Local Development (optional)
- Same‑origin preview (build frontend then serve statically): `just serve`
- Hot reload:
  - Single terminal: `just dev-all` (backend hot reload + Vite Dev; Ctrl+C to stop both)
  - Split terminals: terminal A `just server-dev PORT=63000`; terminal B `just web-dev VITE_API_BASE=http://127.0.0.1:63000`
- Backend only: `just server-run` or `ROOT=. WEB_DIST=packages/web/dist just server-run`
- Frontend: `just web-install`, `just web-build` (only when producing static assets), `just web-dev VITE_API_BASE=http://127.0.0.1:<port>`
- For development flow, coding conventions and publishing, see CONTRIBUTING.md

WebSocket Behavior & Debugging
- Default “WS‑prefer reads”: tree/file/annotations list go via WS when possible; on transport/ability errors a short‑fuse HTTP fallback kicks in. Writes go REST by default; enable `VITE_WS_WRITE=1` if you want to test saving over WS.
- File watching (optional): set `AILOOM_FSWATCH_ENABLED=1` to enable backend FS watch and receive `file.changed`/`tree.changed`.
- Debug panel: set `VITE_WS_DEBUG=1` to show the WS panel at bottom‑right; `VITE_WS_DEBUG_ROUTE=1` prints WS/REST routing decisions.
- See `docs/guide/ws-overview.md` and `docs/specs/ws/client.md` for details.

API (for integrations)
- Local server exposes `/api/*` endpoints:
  - Tree: `GET /api/tree?dir=.` → `DirEntry[]`
  - File chunk: `GET /api/file?path=...&startLine=1&maxLines=2000` → `FileChunk`
  - File full: `GET /api/file/full?path=...` (size limits apply)
  - Save file: `PUT /api/file` (`{ path, content, baseDigest? }`, 409 for conflict)
  - Annotations CRUD/import/export/verify: `/api/annotations*`, `POST /api/annotations/verify`
  - Stitch: `POST /api/stitch?templateId=concise&maxChars=4000`
- Full contract, error mapping and examples: `docs/guide/api.md`

Privacy & Security
- Backend binds to `127.0.0.1` and prints `AILOOM_PORT=<port>` on startup.
- FS access is restricted to `--root`, honoring `.gitignore` and optional `.ailoomignore`.
- DB location is configurable via `--db`/`--db-path`; workspace isolation is based on nearest `.git` directory or the provided root.

Repository structure (overview)
- `packages/rust/ailoom-server`: Axum server, static hosting and `/api/*`.
- `packages/rust/crates/*`: domain libs — `ailoom-core` (types/errors), `ailoom-fs` (sandboxed FS with ignore + atomic writes), `ailoom-store` (SQLite), `ailoom-stitch` (stitching).
- `packages/web`: React + Vite frontend (Tailwind v4 + shadcn/ui + Monaco).
- `docs/`: architecture, WS, API and frontend guidelines.

Troubleshooting
- Browser didn’t open: check `AILOOM_PORT=<port>` in terminal and open `http://127.0.0.1:<port>`.
- Out‑of‑root access warning: ensure the file is under the `--root` path.
- Large files truncated: paging/limits are applied for performance; small files can enter full edit mode.
- Save conflict: `CONFLICT` means the file changed externally; refresh content before saving again.

More
- Contributing and local development: CONTRIBUTING.md
- Detailed docs: `docs/guide/` (architecture/WS/API/data/frontend/storage/security)

License
- MIT (see `packages/npm/ai-loom/package.json`)
