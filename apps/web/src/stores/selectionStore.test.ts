import { beforeEach, describe, expect, it } from 'vitest';
import { useSelectionStore } from './selectionStore.js';

describe('selectionStore renderer mode', () => {
  beforeEach(() => {
    useSelectionStore.setState({
      rendererMode: 'auto',
      selectedClipIds: new Set<string>(),
      selectedClipId: null,
      selectedTrackId: null,
      timelineTool: 'select',
      rippleMode: false,
      linkedSelection: true,
      autoKeyframeEnabled: false,
      activePanel: null,
      sourceAsset: null,
      sourceInTime: null,
      sourceOutTime: null,
      sourceInsertMode: 'overwrite',
      targetVideoTrackId: null,
      targetAudioTrackId: null,
    });
  });

  it('defaults to auto renderer mode', () => {
    expect(useSelectionStore.getState().rendererMode).toBe('auto');
  });

  it('switches renderer mode explicitly', () => {
    useSelectionStore.getState().setRendererMode('webgl2');
    expect(useSelectionStore.getState().rendererMode).toBe('webgl2');

    useSelectionStore.getState().setRendererMode('canvas2d');
    expect(useSelectionStore.getState().rendererMode).toBe('canvas2d');
  });

  it('keeps clip selection behavior after renderer mode changes', () => {
    useSelectionStore.getState().setRendererMode('webgl2');
    useSelectionStore.getState().selectClip('clip-a');
    useSelectionStore.getState().selectClip('clip-b', true);

    expect(useSelectionStore.getState().selectedClipIds.has('clip-a')).toBe(true);
    expect(useSelectionStore.getState().selectedClipIds.has('clip-b')).toBe(true);
    expect(useSelectionStore.getState().rendererMode).toBe('webgl2');
  });
});
