AI Loom — Local Code & Docs Explorer
====================================

Language: 中文版请见 README.md

What it is
- A local “code/docs exploration + annotations” tool you run in your project, browse in the browser, and keep data on your machine.
- Backend: Rust/Axum; Frontend: React/Vite; works offline.
- Data is stored in SQLite: default `~/ailoom/ailoom.db`, fallback to `.ailoom/ailoom.db` in project root.

Install & Run (recommended)
- Zero‑install:
  - In your project directory: `npx ai-loom`
  - First run downloads a prebuilt binary for your platform and opens the browser automatically.
- Global install:
  - `npm i -g ai-loom`, then run `ai-loom --root .`
- Useful flags:
  - `--root <path>` restricts access to this subtree
  - `--db <path>` or `--db-path <path>` sets DB location
  - `--port <number>` sets port; `--no-open` disables auto‑open

UI & Features
- Explorer with lazy directory loading and expand memory
- File viewing with paging; Markdown preview with highlighting and jumps
- Annotations on ranges/lines; grouped list with quick navigation
- Sync: save → UI updates within ~1s; WS‑prefer reads with short‑fuse HTTP fallback

Works With AI Coding (e.g., Vibe Coding)
- Fits AI workflows: leave in‑place annotations on generated/edited code at the original file location, with line ranges and context.
- Faster review loops: copy snippets/paths from annotations back into the chat instead of repeatedly describing “which file/which line”; assistants can pinpoint intent more reliably.
- Handy for marking “needs change/explain/risky/misaligned API” spots as a to‑do list for the next iteration.

Troubleshooting
- Browser didn’t open: check terminal for `AILOOM_PORT=<port>` and open `http://127.0.0.1:<port>`
- Out‑of‑root access warning: ensure the file is under the `--root` path
- Large files truncated: paging/limits are applied for performance

Advanced (optional)
- Run from source (requires Rust, Node.js, pnpm, just):
  - In repo root: `just serve`
  - For development and contributions, see CONTRIBUTING.md
- API for integration: see `docs/guide/api.md`

Privacy & Security
- Server binds to `127.0.0.1` and prints `AILOOM_PORT` on startup
- Access is sandboxed to `--root`, honoring `.gitignore` and optional `.ailoomignore`
- DB location is configurable via `--db`/`--db-path`

More
- Contributing and local development: see CONTRIBUTING.md
- Detailed docs: `docs/guide/` (architecture/API/data/frontend/storage/security)

Security & Config
- Backend binds to `127.0.0.1` and prints `AILOOM_PORT` on startup.
- FS access is restricted to `--root`, honoring `.gitignore` and optional `.ailoomignore`.
- DB path can be set via `--db-path`/`--db`, e.g. `ai-loom --root . --db ~/.ailoom/ailoom.db`.

License
- MIT (see `packages/npm/ai-loom/package.json`)
