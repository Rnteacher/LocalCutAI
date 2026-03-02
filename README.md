# LocalCut

> Open-source, local-first video editor with AI capabilities.

LocalCut is a browser-based video editing application that runs entirely on your local machine. No cloud, no subscriptions, no data leaving your computer.

## Features (Planned)

### Core Editing
- Multi-track video and audio timeline
- Source and Program monitors
- Non-destructive editing
- Audio waveform display and gain automation
- Transform controls (position, scale, rotation, opacity)
- Audio mixer with per-track and per-clip controls
- Export via FFmpeg (H.264, H.265, ProRes, and more)

### AI-Powered Features
- **Object Selection & Masking** - Select and track objects in video using SAM2
- **Video Upscaling** - Enhance resolution with Real-ESRGAN
- **Slow Motion** - Generate smooth slow motion with RIFE frame interpolation
- **Speech Transcription** - Transcribe audio with Whisper for edit-by-dialogue
- **Auto Rough Cut** - AI-assisted assembly from script or dialogue
- **Smart Editing** - LLM-powered editing suggestions and automation

## Prerequisites

- Node.js 20+
- pnpm 10+
- FFmpeg (installed and in PATH)
- Python 3.10+ (for AI features, optional for MVP)

## Getting Started

```bash
# Clone the repository
git clone https://github.com/yourusername/localcut.git
cd localcut

# Install dependencies
pnpm install

# Build all packages
pnpm turbo build

# Start development servers
pnpm turbo dev
```

The editor will be available at `http://localhost:3000`.

## Project Structure

```
localcut/
├── apps/
│   ├── web/          # React frontend (Vite)
│   ├── server/       # Node.js backend (Fastify)
│   └── ai-server/    # Python AI backend (FastAPI) [Phase 2+]
├── packages/
│   ├── core/         # Shared types and timeline engine
│   ├── eslint-config/
│   └── typescript-config/
```

## Tech Stack

| Layer | Technology |
|-------|------------|
| Frontend | React 19, TypeScript, Vite, Tailwind CSS v4, Zustand |
| Backend | Fastify, better-sqlite3, Drizzle ORM |
| Video | WebCodecs (preview), FFmpeg (export/transcode) |
| Audio | Web Audio API |
| AI | PyTorch, SAM2, Real-ESRGAN, RIFE, Whisper |
| LLM | Ollama / llama.cpp (local) |

## License

MIT
