# Milestone 2 — Editing Essentials

## Overview
9 steps, 8 files modified/created. Focused on: undo/redo, razor split, snap, ripple, transform rendering, editable Inspector.

---

## Step 1: Data Model Expansion
**File: `apps/web/src/stores/projectStore.ts`**

Add to `TimelineClipData`:
```ts
// NEW fields (all optional, with defaults)
opacity?: number;       // default 1
positionX?: number;     // default 0  (px offset from center)
positionY?: number;     // default 0
scaleX?: number;        // default 1
scaleY?: number;        // default 1
rotation?: number;      // default 0  (degrees)
speed?: number;         // default 1
```
These are optional so existing clips keep working with defaults.

---

## Step 2: Undo/Redo — Local History Stack
**File: `apps/web/src/stores/projectStore.ts`**

Instead of installing `zundo` (adds a dep), implement a lightweight history stack:
- `_history: SequenceData[]` — past states (max ~50)
- `_future: SequenceData[]` — redo stack
- `_pushHistory()` — internal: snapshot current sequence data before mutation
- `undo()` — pop history, push current to future, apply
- `redo()` — pop future, push current to history, apply

Every edit action (`addClipToTrack`, `removeClips`, `moveClip`, `trimClip`, `splitClip`, `updateClipProperties`, `rippleTrimClip`, `rippleDeleteClips`) calls `_pushHistory()` before mutating.

The API calls are fire-and-forget persistence — undo restores local state AND calls `api.sequences.update()` to sync backend.

---

## Step 3: New Store Actions
**File: `apps/web/src/stores/projectStore.ts`**

### `splitClipAtPlayhead(clipId: string, frame: number)`
1. Find clip in tracks
2. Verify playhead is within clip range: `clip.startFrame < frame < clip.startFrame + clip.durationFrames`
3. Create clip A: `{ ...clip, durationFrames: frame - clip.startFrame, sourceOutFrame: sourceIn + (frame - clip.startFrame) }`
4. Create clip B: `{ ...clip, id: newId, startFrame: frame, durationFrames: clip.startFrame + clip.durationFrames - frame, sourceInFrame: sourceIn + (frame - clip.startFrame) }`
5. Replace original clip with [A, B] in track
6. Push history + persist

### `updateClipProperties(clipId: string, props: Partial<TimelineClipData>)`
1. Find clip, merge props
2. Push history + persist

### `rippleTrimClip(clipId: string, newStartFrame: number, newDurationFrames: number)`
1. Calculate delta = (newStart + newDuration) - (oldStart + oldDuration) for right trim, or newStart - oldStart for left trim
2. Shift all clips AFTER the trimmed clip's end by delta
3. Push history + persist

### `rippleDeleteClips(clipIds: string[])`
1. For each deleted clip, shift subsequent clips left by the deleted clip's duration
2. Push history + persist

### Fix `trimClip` — sourceIn/Out adjustment
Current `trimClip` only changes `startFrame` and `durationFrames` but does NOT adjust `sourceInFrame/sourceOutFrame`. Fix:
- Left trim: `sourceInFrame += (newStartFrame - oldStartFrame)`
- Right trim: `sourceOutFrame = sourceInFrame + newDurationFrames`

---

## Step 4: useKeyboard — Wire Missing Shortcuts
**File: `apps/web/src/hooks/useKeyboard.ts`**
- Add `Ctrl+Shift+Z → onRedo` (user requirement, currently missing)

**File: `apps/web/src/app/App.tsx`**
- Wire `onRazor` → calls `razorAtPlayhead()` (new helper that finds clips under playhead on all tracks and splits them)
- Wire `onUndo` → `projectStore.undo()`
- Wire `onRedo` → `projectStore.redo()`
- Wire `onDelete` → `removeClips(selectedClipIds)` + `clearClipSelection()`

---

## Step 5: Timeline — Snap System
**File: `apps/web/src/components/Timeline.tsx`**

Add `computeSnap(targetFrame: number, excludeClipId: string, tracks: TimelineTrack[]): { frame: number; snapped: boolean }`
1. Collect snap targets: all clip start/end frames + playhead frame
2. Exclude the dragged clip itself
3. Check if targetFrame is within threshold (8px → convert to frames)
4. Return snapped frame + flag

Apply snap during:
- `handleMouseMove` for clip move (snap left edge)
- `handleMouseMove` for trim-left / trim-right

Visual: when `snapped === true`, render a vertical snap-line (yellow) at snapped position.

---

## Step 6: Timeline — Ripple Mode
**File: `apps/web/src/components/Timeline.tsx`**

During drag:
- Track `e.altKey` in mousemove handler
- Store in `DragState` as `ripple: boolean`

On mouseup:
- If `ripple && mode === 'trim-left' | 'trim-right'` → call `rippleTrimClip()` instead of `trimClip()`
- If `ripple && mode === 'move'` → call ripple move (shift subsequent clips)

Visual indicator: when Alt is held, show "RIPPLE" badge near cursor or in timeline header.

---

## Step 7: Inspector — Editable Controls
**File: `apps/web/src/components/Inspector.tsx`**

Replace read-only `Row` components with editable `NumberInput` components for the selected clip.

New sub-component `NumberInput`:
```tsx
function NumberInput({ label, value, onChange, step?, min?, max? })
```
- `<input type="number">` with debounced onChange
- Calls `projectStore.updateClipProperties(clipId, { [key]: newValue })`

Sections when single clip selected:
1. **Clip** (read-only): Name, Type, Track
2. **Transform** (editable): Position X, Position Y, Scale X, Scale Y, Rotation, Opacity
3. **Timing** (read-only for now): Start, Duration, End, Src In, Src Out
4. **Media** (read-only): File, Duration, Resolution, Codec

Changes propagate immediately → projectStore updates → ProgramMonitor re-renders on next rAF tick.

---

## Step 8: ProgramMonitor — Transform Rendering
**File: `apps/web/src/components/ProgramMonitor.tsx`**

In the `tick()` function, after finding active clip, before `drawImage`:

```ts
const clip = info.clip;
const opacity = clip.opacity ?? 1;
const px = clip.positionX ?? 0;
const py = clip.positionY ?? 0;
const sx = clip.scaleX ?? 1;
const sy = clip.scaleY ?? 1;
const rot = clip.rotation ?? 0;

ctx.save();
ctx.globalAlpha = opacity;
ctx.translate(cw/2 + px, ch/2 + py);
ctx.rotate(rot * Math.PI / 180);
ctx.scale(sx, sy);
ctx.translate(-cw/2, -ch/2);
drawVideoToCanvas(ctx, video, cw, ch);
ctx.restore();
```

This applies all transform properties with center-origin rotation/scale.

---

## Step 9: Build & Verify
- `pnpm turbo build` — zero errors
- Verify: C key splits, Ctrl+Z undoes, snap works, Inspector edits update Program Monitor

---

## Execution Order (dependencies)
```
Step 1 (data model)
  ↓
Step 2 (undo system)
  ↓
Step 3 (new actions: split, updateProps, ripple, fix trim) — depends on 1, 2
  ↓
Step 4 (keyboard wiring) — depends on 3
Step 5 (snap) — independent, can parallel with 4
Step 6 (ripple UI) — depends on 3
Step 7 (Inspector edit) — depends on 1, 3
Step 8 (transform render) — depends on 1
  ↓
Step 9 (build verify)
```

## Files Changed Summary
| File | Change |
|------|--------|
| `stores/projectStore.ts` | Data model + history + 5 new actions + trim fix |
| `hooks/useKeyboard.ts` | Add Ctrl+Shift+Z → redo |
| `app/App.tsx` | Wire onRazor, onUndo, onRedo, onDelete |
| `components/Timeline.tsx` | Snap system + ripple mode + snap line visual |
| `components/Inspector.tsx` | Editable NumberInput controls for transform |
| `components/ProgramMonitor.tsx` | Canvas transform rendering |
