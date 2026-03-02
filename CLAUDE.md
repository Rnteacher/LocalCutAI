# LocalCut - Claude Code Instructions

## Project Overview
LocalCut is an open-source, local-first video editor with AI capabilities. UI runs in the browser (React), backend processes run locally (Node.js + Python).

## Architecture
- **Monorepo** using pnpm workspaces + Turborepo
- **Frontend** (`apps/web`): React 19 + TypeScript + Vite + Tailwind CSS v4 + Zustand
- **Backend** (`apps/server`): Fastify + TypeScript + SQLite (better-sqlite3 + Drizzle ORM)
- **AI Server** (`apps/ai-server`): Python + FastAPI (future - Phase 2+)
- **Shared** (`packages/core`): TypeScript types + timeline engine logic

## Quick Start
```bash
pnpm install          # Install all dependencies
pnpm turbo build      # Build all packages
pnpm turbo dev        # Start dev servers (frontend + backend)
pnpm turbo test       # Run all tests
pnpm turbo typecheck  # Type check all packages
```

## Key Directories
- `packages/core/src/types/` - All TypeScript type definitions (Project, Sequence, Track, ClipItem, etc.)
- `packages/core/src/engine/` - Timeline engine (time resolver, keyframe eval, audio mix, composition plan)
- `packages/core/src/utils/` - Timecode math, ID generation
- `apps/web/src/` - React frontend
- `apps/server/src/` - Fastify backend
- `apps/server/src/db/` - Database schema and client

## Coding Conventions
- TypeScript strict mode everywhere
- Use `type` imports: `import type { Foo } from './bar.js'`
- Use `.js` extensions in imports (NodeNext module resolution)
- Zustand for state management (not Redux)
- Use `nanoid` for ID generation (via `@localcut/core` generateId)
- Frame-accurate time: always use `TimeValue { frames, rate: FrameRate }` not raw seconds
- Non-destructive editing: never modify source media files

## Data Model
Core entities: Project → Sequence → Track → ClipItem
- Time is represented as `{ frames: number, rate: { num, den } }`
- FrameRate is rational (e.g., 24000/1001 for 23.976fps)
- Audio envelope: array of `{ time, gain }` points on each clip

## API
- REST on `http://localhost:9470/api/*`
- WebSocket on `ws://localhost:9470/ws`
- AI endpoints proxied to Python server on port 9471

## Testing
- Vitest for unit/integration tests
- `packages/core`: 90%+ coverage target
- Test files: `*.test.ts` co-located with source
