# LocalCut Modern Video Editor Roadmap

## Current State (Mar 2026)

LocalCut now has a usable core:

- Local project/media management
- Source monitor and Program monitor
- Timeline with drag/trim/split/ripple delete
- Linked A/V pairs for move + trim (with Alt temporary unlink)
- In/Out ranges and Lift/Extract in Program
- Basic export via server FFmpeg

The app is no longer a prototype shell, but it is still far from a modern NLE. The work ahead is mostly about reliability, depth of editing tools, media pipeline quality, and UX polish.

---

## Product Goal

Become a modern, local-first NLE for creators who expect:

1. Fast and stable timeline editing at scale
2. Predictable professional editing semantics (trim modes, sync lock, track targeting)
3. Strong media pipeline (proxies, waveforms, background conform)
4. Competitive finishing features (effects, audio mix, color, export presets)

---

## Phase 1 — Editing Reliability and Core UX

### Must-have

- Linked selection model (A/V lock, unlink/relink, linked trim/ripple/split behavior parity)
- Full In/Out semantics:
  - Source: insert/overwrite from in/out
  - Program: lift/extract by in/out
- Better timeline conflict resolution:
  - deterministic overwrite
  - deterministic ripple insert
  - no accidental overlaps
- Context-accurate keyboard map:
  - Space, J/K/L, I/O, Q/W, C/V, +/-
- Unified tool state bar (select, razor, ripple/roll/slide placeholders)

### Nice-to-have

- Markers (sequence + clip markers)
- Track targeting headers (V1/A1 destination toggles)

---

## Phase 2 — Professional Timeline Features

### Must-have

- Trim modes:
  - ripple trim
  - roll trim
  - slip/slide
- Snapping improvements:
  - markers, playhead, clip edges, transitions
  - user-configurable snap strength
- Multitrack compositing controls:
  - per-track blend/opacity
  - clip transform gizmos + safe bounds
- Better undo/redo granularity and transaction grouping

### Nice-to-have

- Nested sequences (compound clips)
- Gap clips as first-class timeline objects

---

## Phase 3 — Audio Editing and Mixing

### Must-have

- Waveforms for audio clips (async generation + cache)
- Clip gain envelopes/keyframes
- Track mixer (mute/solo/arm, volume, pan)
- Sync-safe edits (sync lock and track lock semantics)

### Nice-to-have

- Loudness metering and normalization presets
- Audio effect chain (EQ, compressor, limiter)

---

## Phase 4 — Effects, Titles, Color, Motion

### Must-have

- Effect stack per clip/track
- Keyframe editor UI (time/value curve)
- Basic transitions (dip, dissolve, wipe)
- Text/title generator with templates

### Nice-to-have

- Motion presets + transform handles improvements
- LUT support + basic color wheels

---

## Phase 5 — Media Pipeline and Performance

### Must-have

- Proxy workflow (background transcode, toggle source/proxy)
- Decode strategy to avoid stutter on 4K+ media
- Thumbnail strip generation and caching
- Timeline virtualization for large projects

### Nice-to-have

- Hardware acceleration path selection
- Smart cache invalidation by sequence revision

---

## Phase 6 — Export, Delivery, and Workflow

### Must-have

- Export presets (H.264/H.265/ProRes-like presets where available)
- Queue multiple exports
- Render range / in-out export
- Failure diagnostics with actionable logs

### Nice-to-have

- Watch folders and auto-ingest
- Background render of preview files

---

## Phase 7 — Collaboration, AI, and Product Polish

### Must-have

- Project health tools:
  - autosave snapshots
  - crash recovery
  - media relink
- Settings and preferences panel
- Accessibility pass and keyboard customization

### Nice-to-have

- AI assistant workflows (rough cut, silence removal, caption draft)
- Plugin SDK for custom effects/exporters

---

## Technical Backbone Upgrades (Cross-phase)

- Single source of truth for timeline evaluation (already started with core integration)
- Strong typed command layer for all edits (command bus + reversible operations)
- Deterministic test fixtures for sequence edits and frame-accuracy checks
- Golden tests for Program vs Export parity

---

## What We Started Implementing Now

This sprint started Phase 1 continuation:

- Program In/Out became actionable through Lift/Extract operations
- Source monitor in/out interaction and viewfinder reliability improvements
- Linked trim behavior with Alt-temporary unlink

Next immediate sprint should complete:

1. Linked split/ripple parity (all linked operations, not only move/trim)
2. Track targeting model (source patching to V/A destinations)
3. Marker system and snap integration
