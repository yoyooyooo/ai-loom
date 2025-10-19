# ai-loom

Local-first code exploration and annotation workbench. Run it in any project to browse files, annotate code, and stitch high‑quality prompts from selected context — all on your machine.

- Backend: Rust (Axum)
- Frontend: React + Vite
- Data: SQLite (per‑workspace isolation)
- Distribution: cross‑platform CLI (`npx ai-loom`), binds to 127.0.0.1 only

## Highlights
- Explore your project tree quickly; respects .gitignore and optional .ailoomignore
- Safe sandbox: never reads or writes outside the chosen root
- View (and optionally edit) files with Monaco, Markdown preview included
- Create, manage, verify annotations with floating UI and precise ranges
- Stitch prompts from annotations with concise/detailed templates and budgeting
- Import/Export annotations; optimistic UI with local persistence
- Conflict‑safe saves: digest/checks to prevent accidental overwrites

## Install and Run
The simplest way is via the CLI — no local build required.

- Prerequisite for CLI: Node.js 18+

```bash
# Run in your project root (will open the app in your browser)
npx ai-loom --root .
```

Common options:
- `--port <number>`: choose a port (default is printed as AILOOM_PORT on start)
- `--db <path>` or `--db-path <path>`: store annotations in a custom SQLite DB
- `--no-open`: do not auto‑open the browser

Examples:
```bash
# Use a fixed port
npx ai-loom --root . --port 63000

# Keep data next to the project
npx ai-loom --root . --db ./.ailoom/ailoom.db
```

Notes:
- By default data is stored at `~/ailoom/ailoom.db`; if that fails it falls back to `.ailoom/ailoom.db` in your project.
- The server binds to `127.0.0.1` only and serves a local web UI.

## Quick Start
1) In your project directory run `npx ai-loom --root .`
2) The app opens in your browser. If it does not, copy the printed URL (`http://127.0.0.1:<port>`)
3) Browse files from the left tree; open files in the viewer/editor
4) Select lines or text and add annotations; manage them in the side panel
5) Stitch prompts from selected annotations using the Stitch panel
6) Export your annotations as JSON when you need to share or back them up

## Key Concepts
- Workspace: the app scopes visibility by workspace. It looks up the nearest `.git` as workspace root; if none found, it uses `--root`.
- Annotations: metadata attached to file ranges and text selections (priority, comment, etc.). Stored in SQLite.
- Stitching: builds a prompt from chosen annotations using predefined templates and budget constraints.

## Privacy & Safety
- Local‑first: no telemetry and no external API calls are required to use the app
- Network boundary: binds to `127.0.0.1` only
- Filesystem boundary: all file access is sandboxed under `--root`; binary files are guarded, large payloads are paginated
- Ignore rules: respects `.gitignore` and optional `.ailoomignore`

## Supported Platforms
The CLI ships prebuilt server binaries for common platforms:
- macOS (Apple Silicon and x64)
- Linux x64 (glibc and musl) and Linux arm64 (glibc and musl)
- Windows x64 (MSVC)

## Troubleshooting
- Port already in use: pass `--port <number>`
- Browser didn’t open: use the printed URL `http://127.0.0.1:<port>`
- Annotation data location: pass `--db`/`--db-path` to control where SQLite lives
- Large/binary files: large files are read in pages; binary files are detected and guarded

## Feedback
Issues and feature requests are welcome. Please open an Issue in this repository.

## For Developers
If you’re contributing or building from source, see `CONTRIBUTING.md` and the single source of truth under `docs/guide/`.
