# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

## Essential Commands

### Development
```bash
# Start development servers with hot reload (frontend + backend)
npm run dev

# Individual dev servers
npm run frontend:dev    # Frontend only (port 3000)
npm run backend:dev     # Backend only (port auto-assigned)

# Build production version
npm run build
```

### Testing & Validation
```bash
# Run all checks (frontend + backend)
npm run check

# Frontend specific
cd frontend && npm run lint          # Lint TypeScript/React code
cd frontend && npm run format:check  # Check formatting
cd frontend && npx tsc --noEmit     # TypeScript type checking

# Backend specific  
cargo test --workspace               # Run all Rust tests
cargo test -p <crate_name>          # Test specific crate
cargo test test_name                # Run specific test
cargo fmt --all -- --check          # Check Rust formatting
cargo clippy --all --all-targets --all-features -- -D warnings  # Linting

# Type generation (after modifying Rust types)
npm run generate-types               # Regenerate TypeScript types from Rust
npm run generate-types:check        # Verify types are up to date
```

### Database Operations
```bash
# SQLx migrations
sqlx migrate add migration_name      # Create new migration
sqlx migrate run                     # Apply migrations
sqlx database create                 # Create database
```

## Architecture Overview

### Tech Stack
- **Backend**: Rust with Axum web framework, Tokio async runtime, SQLx for database
- **Frontend**: React 18 + TypeScript + Vite, Tailwind CSS
- **Database**: SQLite with SQLx migrations
- **Type Sharing**: ts-rs generates TypeScript types from Rust structs
- **Distribution**: npm + npx for one-command deployment

### Project Structure
```
vibe-starter/
├── Cargo.toml              # Rust workspace configuration
├── package.json            # Root npm configuration
├── CLAUDE.md               # AI assistant guidance
├── README.md               # Project documentation
├── local-build.sh          # Build script
├── crates/                 # Rust modules
│   ├── server/            # HTTP server and routes
│   ├── db/                # Database models and migrations
│   ├── services/          # Business logic
│   ├── utils/             # Shared utilities
│   └── local-deployment/  # Deployment implementation
├── frontend/              # React application
│   ├── src/
│   ├── package.json
│   └── vite.config.ts
├── npx-cli/               # npx command line tool
│   ├── bin/cli.js
│   ├── package.json
│   └── dist/              # Pre-built binaries
├── shared/                # Frontend-backend shared
│   └── types.ts           # Auto-generated TypeScript types
└── .github/workflows/     # CI/CD configuration
```

### Key Architectural Patterns

1. **Type Safety**: TypeScript types are automatically generated from Rust structs
2. **Separation of Concerns**: Clear boundaries between server, database, services, and utilities
3. **Real-time Updates**: Server-Sent Events for live data synchronization
4. **One-Command Distribution**: Users run `npx vibe-starter` to start the entire application

### API Patterns

- REST endpoints under `/api/*`
- Frontend dev server proxies to backend (configured in vite.config.ts)
- All database queries in `crates/db/src/models/`
- Business logic in `crates/services/src/services/`

### Development Workflow

1. **Backend changes first**: When modifying both frontend and backend, start with backend
2. **Type generation**: Run `npm run generate-types` after modifying Rust types
3. **Database migrations**: Create in `crates/db/migrations/`, apply with `sqlx migrate run`
4. **Testing**: Run both Rust tests and TypeScript checks before committing

### Environment Variables

Build-time (set when building):
- `FRONTEND_PORT`: Frontend dev port (default: 3000)
- `BACKEND_PORT`: Backend server port (default: auto-assign)

# important-instruction-reminders
Do what has been asked; nothing more, nothing less.
NEVER create files unless they're absolutely necessary for achieving your goal.
ALWAYS prefer editing an existing file to creating a new one.
NEVER proactively create documentation files (*.md) or README files. Only create documentation files if explicitly requested by the User.
