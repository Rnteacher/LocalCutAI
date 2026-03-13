import { useEffect, useRef } from 'react';
import { usePlaybackStore } from '../stores/playbackStore.js';
import { useProjectStore } from '../stores/projectStore.js';
import type { TimelineClipData, TimelineTrackData } from '../stores/projectStore.js';
import { api } from '../lib/api.js';
import { adaptSequence } from '../lib/timelineAdapter.js';
import { buildCompositionPlan } from '../lib/core.js';
import { evaluateClipNumericKeyframe, resolveClipSourceTimeSec } from '../lib/clipKeyframes.js';
import {
  buildRoutingMatrix,
  dbToGain,
  dbfsToMeterLevel,
  computePeakDbfs,
  gainToDb,
  resolveChannelMode,
} from '../lib/audioMath.js';

interface AudioSourceNode {
  element: HTMLMediaElement;
  sourceNode: MediaElementAudioSourceNode;
  gainNode: GainNode;
  eqBands: BiquadFilterNode[];
  routeSplitter: ChannelSplitterNode;
  routeMerger: ChannelMergerNode;
  routeLL: GainNode;
  routeLR: GainNode;
  routeRL: GainNode;
  routeRR: GainNode;
  panNode: StereoPannerNode | null;
  mediaAssetId: string;
}

interface MeterNodes {
  splitter: ChannelSplitterNode;
  analyserL: AnalyserNode;
  analyserR: AnalyserNode;
  lData: Float32Array;
  rData: Float32Array;
}

export function useAudioEngine(): void {
  const audioCtxRef = useRef<AudioContext | null>(null);
  const masterGainRef = useRef<GainNode | null>(null);
  const sourcesRef = useRef(new Map<string, AudioSourceNode>());
  const meterRef = useRef<MeterNodes | null>(null);

  const getAudioCtx = (): AudioContext => {
    if (!audioCtxRef.current) {
      audioCtxRef.current = new AudioContext();
      masterGainRef.current = audioCtxRef.current.createGain();
      masterGainRef.current.connect(audioCtxRef.current.destination);
      const splitter = audioCtxRef.current.createChannelSplitter(2);
      const analyserL = audioCtxRef.current.createAnalyser();
      const analyserR = audioCtxRef.current.createAnalyser();
      analyserL.fftSize = 256;
      analyserR.fftSize = 256;
      masterGainRef.current.connect(splitter);
      splitter.connect(analyserL, 0);
      splitter.connect(analyserR, 1);
      meterRef.current = {
        splitter,
        analyserL,
        analyserR,
        lData: new Float32Array(analyserL.fftSize),
        rData: new Float32Array(analyserR.fftSize),
      };
    }
    if (audioCtxRef.current.state === 'suspended') {
      audioCtxRef.current.resume();
    }
    return audioCtxRef.current;
  };

  const removeSource = (clipId: string) => {
    const src = sourcesRef.current.get(clipId);
    if (!src) return;
    src.element.pause();
    src.element.removeAttribute('src');
    src.element.load();
    try {
      src.sourceNode.disconnect();
    } catch {
      // ignore disconnect errors
    }
    try {
      src.gainNode.disconnect();
    } catch {
      // ignore disconnect errors
    }
    try {
      for (const b of src.eqBands) b.disconnect();
      const anySrc = src as Partial<AudioSourceNode>;
      anySrc.routeSplitter?.disconnect();
      anySrc.routeMerger?.disconnect();
      anySrc.routeLL?.disconnect();
      anySrc.routeLR?.disconnect();
      anySrc.routeRL?.disconnect();
      anySrc.routeRR?.disconnect();
    } catch {
      // ignore disconnect errors
    }
    if (src.panNode) {
      try {
        src.panNode.disconnect();
      } catch {
        // ignore disconnect errors
      }
    }
    sourcesRef.current.delete(clipId);
  };

  const getOrCreateSource = (clipId: string, mediaAssetId: string): AudioSourceNode | null => {
    let source = sourcesRef.current.get(clipId);
    if (source) return source;

    const ctx = getAudioCtx();
    const element = new Audio();
    element.src = api.media.fileUrl(mediaAssetId);
    element.preload = 'auto';
    element.crossOrigin = 'anonymous';
    element.volume = 1;

    try {
      const sourceNode = ctx.createMediaElementSource(element);
      const gainNode = ctx.createGain();
      const eqFreqs = [63, 125, 250, 500, 1000, 2000, 4000, 8000];
      const eqBands = eqFreqs.map((f, i) => {
        const b = ctx.createBiquadFilter();
        b.type = i === 0 ? 'lowshelf' : i === eqFreqs.length - 1 ? 'highshelf' : 'peaking';
        b.frequency.value = f;
        b.Q.value = 1;
        b.gain.value = 0;
        return b;
      });
      const routeSplitter = ctx.createChannelSplitter(2);
      const routeMerger = ctx.createChannelMerger(2);
      const routeLL = ctx.createGain();
      const routeLR = ctx.createGain();
      const routeRL = ctx.createGain();
      const routeRR = ctx.createGain();
      const panNode =
        typeof ctx.createStereoPanner === 'function' ? ctx.createStereoPanner() : null;
      sourceNode.connect(gainNode);
      gainNode.connect(eqBands[0]);
      for (let i = 0; i < eqBands.length - 1; i++) {
        eqBands[i].connect(eqBands[i + 1]);
      }
      eqBands[eqBands.length - 1].connect(routeSplitter);
      routeSplitter.connect(routeLL, 0);
      routeSplitter.connect(routeLR, 0);
      routeSplitter.connect(routeRL, 1);
      routeSplitter.connect(routeRR, 1);
      routeLL.connect(routeMerger, 0, 0);
      routeLR.connect(routeMerger, 0, 1);
      routeRL.connect(routeMerger, 0, 0);
      routeRR.connect(routeMerger, 0, 1);
      if (panNode) {
        routeMerger.connect(panNode);
        panNode.connect(masterGainRef.current!);
      } else {
        routeMerger.connect(masterGainRef.current!);
      }

      source = {
        element,
        sourceNode,
        gainNode,
        eqBands,
        routeSplitter,
        routeMerger,
        routeLL,
        routeLR,
        routeRL,
        routeRR,
        panNode,
        mediaAssetId,
      };
      sourcesRef.current.set(clipId, source);
      return source;
    } catch {
      return null;
    }
  };

  useEffect(() => {
    const runUpdate = (playback: ReturnType<typeof usePlaybackStore.getState>) => {
      try {
        const { sequences } = useProjectStore.getState();
        if (!sequences.length) return;

        const seq = sequences[0];
        const data = seq.data as { tracks?: TimelineTrackData[] } | undefined;
        const tracks = data?.tracks ?? [];
        const fps =
          seq.frameRate?.num && seq.frameRate?.den ? seq.frameRate.num / seq.frameRate.den : 30;
        const clipById = new Map<string, TimelineClipData>();
        const trackById = new Map<
          string,
          { channelMode?: 'stereo' | 'mono'; channelMap?: 'L+R' | 'L' | 'R'; pan?: number }
        >();
        for (const track of tracks) {
          trackById.set(track.id, {
            channelMode: track.channelMode,
            channelMap: track.channelMap,
            pan: track.pan,
          });
          for (const clip of track.clips) {
            clipById.set(clip.id, clip);
          }
        }

        const coreSeq = adaptSequence(
          seq.id,
          seq.projectId,
          seq.name,
          tracks,
          seq.frameRate,
          seq.resolution,
        );

        const plan = buildCompositionPlan(coreSeq, {
          frames: playback.currentFrame,
          rate: seq.frameRate,
        });

        const activeIds = new Set(plan.audioSources.map((s) => s.clipId));
        const effectiveAudioSources = plan.audioSources.filter((s) => {
          const c = clipById.get(s.clipId);
          if (!c) return true;
          // If linked audio clip is ALSO active now, avoid duplicate playback from video source.
          if (c.type === 'video' && c.linkedClipId && activeIds.has(c.linkedClipId)) {
            return false;
          }
          return true;
        });

        const activeClipIds = new Set(effectiveAudioSources.map((s) => s.clipId));
        const sequenceClipIds = new Set<string>();
        for (const track of tracks) {
          for (const clip of track.clips) {
            sequenceClipIds.add(clip.id);
          }
        }

        for (const [clipId, source] of sourcesRef.current.entries()) {
          if (!sequenceClipIds.has(clipId)) {
            removeSource(clipId);
            continue;
          }
          if (!activeClipIds.has(clipId)) {
            source.element.pause();
            source.element.playbackRate = 1;
          }
        }

        if (effectiveAudioSources.length === 0) {
          usePlaybackStore.getState().setAudioMeters(0, 0);
          return;
        }

        if (playback.isPlaying) {
          getAudioCtx();
        }

        for (const sourcePlan of effectiveAudioSources) {
          if (!sourcePlan.mediaAssetId) continue;
          const source = getOrCreateSource(sourcePlan.clipId, sourcePlan.mediaAssetId);
          if (!source) continue;

          const clip = clipById.get(sourcePlan.clipId);
          const clipLocalFrame = clip
            ? Math.max(0, Math.min(clip.durationFrames, playback.currentFrame - clip.startFrame))
            : 0;
          const speed = clip
            ? evaluateClipNumericKeyframe(clip, 'speed', clipLocalFrame, clip.speed ?? 1)
            : 1;
          const speedAbs = Math.max(0.1, Math.min(4, Math.abs(speed)));
          const preservePitch = clip?.preservePitch ?? true;
          const shuttle = playback.shuttleSpeed;
          const shuttleAbs = Math.max(0.1, Math.abs(shuttle));
          const canPlayForward = playback.isPlaying && shuttle > 0 && speed > 0;

          const sourceTimeSec = clip
            ? resolveClipSourceTimeSec(clip, clipLocalFrame, fps)
            : (sourcePlan.sourceTime.frames * sourcePlan.sourceTime.rate.den) /
              sourcePlan.sourceTime.rate.num;

          const gainDb = clip?.audioGainDb ?? gainToDb(clip?.gain ?? clip?.audioVolume ?? 1);
          const userGain = dbToGain(gainDb);
          source.element.volume = 1;
          let transitionGain = 1;
          if (
            sourcePlan.transitionType === 'cross-dissolve' &&
            sourcePlan.transitionAudioCrossfade &&
            sourcePlan.transitionProgress != null &&
            sourcePlan.transitionPhase
          ) {
            const t = Math.max(0, Math.min(1, sourcePlan.transitionProgress));
            transitionGain =
              sourcePlan.transitionPhase === 'in'
                ? Math.sin((t * Math.PI) / 2)
                : Math.cos((t * Math.PI) / 2);
          }
          const totalGain = sourcePlan.gain * userGain * transitionGain;
          const now = audioCtxRef.current?.currentTime;
          if (now != null) {
            source.gainNode.gain.setTargetAtTime(totalGain, now, 0.01);
          } else {
            source.gainNode.gain.value = totalGain;
          }
          const bandValues = [
            clip?.audioEq63 ?? clip?.audioEqLow ?? 0,
            clip?.audioEq125 ?? 0,
            clip?.audioEq250 ?? 0,
            clip?.audioEq500 ?? 0,
            clip?.audioEq1k ?? clip?.audioEqMid ?? 0,
            clip?.audioEq2k ?? 0,
            clip?.audioEq4k ?? 0,
            clip?.audioEq8k ?? clip?.audioEqHigh ?? 0,
          ];
          for (let i = 0; i < source.eqBands.length; i++) {
            const value = bandValues[i] ?? 0;
            if (now != null) {
              source.eqBands[i].gain.setTargetAtTime(value, now, 0.02);
            } else {
              source.eqBands[i].gain.value = value;
            }
          }

          const trackCfg = trackById.get(sourcePlan.trackId);
          const mode = resolveChannelMode(trackCfg?.channelMode, trackCfg?.channelMap);
          const keyframedPan = clip
            ? evaluateClipNumericKeyframe(
                clip,
                'pan',
                clipLocalFrame,
                clip.pan ?? clip.audioPan ?? 0,
              )
            : 0;
          const pan = Math.max(-1, Math.min(1, keyframedPan + (trackCfg?.pan ?? 0)));
          const matrix = buildRoutingMatrix(mode, pan);
          const anySource = source as Partial<AudioSourceNode>;
          if (anySource.routeLL && anySource.routeLR && anySource.routeRL && anySource.routeRR) {
            if (now != null) {
              anySource.routeLL.gain.setTargetAtTime(matrix.ll, now, 0.01);
              anySource.routeRL.gain.setTargetAtTime(matrix.rl, now, 0.01);
              anySource.routeLR.gain.setTargetAtTime(matrix.lr, now, 0.01);
              anySource.routeRR.gain.setTargetAtTime(matrix.rr, now, 0.01);
            } else {
              anySource.routeLL.gain.value = matrix.ll;
              anySource.routeRL.gain.value = matrix.rl;
              anySource.routeLR.gain.value = matrix.lr;
              anySource.routeRR.gain.value = matrix.rr;
            }
          }

          if (source.panNode) {
            // Pan is applied in routing matrix for deterministic hard edges.
            source.panNode.pan.value = 0;
          }

          const media = source.element as HTMLMediaElement & {
            preservesPitch?: boolean;
            webkitPreservesPitch?: boolean;
            mozPreservesPitch?: boolean;
          };
          media.preservesPitch = preservePitch;
          media.webkitPreservesPitch = preservePitch;
          media.mozPreservesPitch = preservePitch;

          if (canPlayForward) {
            source.element.playbackRate = Math.max(0.1, Math.min(4, speedAbs * shuttleAbs));
            if (Math.abs(source.element.currentTime - sourceTimeSec) > 0.04) {
              // Use a wider drift threshold to avoid micro-seek jitter during normal playback.
              if (Math.abs(source.element.currentTime - sourceTimeSec) > 0.18) {
                source.element.currentTime = sourceTimeSec;
              }
            }
            if (source.element.paused) source.element.play().catch(() => {});
          } else {
            source.element.pause();
            source.element.playbackRate = 1;
            if (Math.abs(source.element.currentTime - sourceTimeSec) > 0.03) {
              source.element.currentTime = sourceTimeSec;
            }
          }
        }

        const meter = meterRef.current;
        if (meter) {
          const lData = meter.lData as unknown as Float32Array<ArrayBuffer>;
          const rData = meter.rData as unknown as Float32Array<ArrayBuffer>;
          meter.analyserL.getFloatTimeDomainData(lData);
          meter.analyserR.getFloatTimeDomainData(rData);
          const [lDb, rDb] = computePeakDbfs([meter.lData, meter.rData]);
          usePlaybackStore.getState().setAudioMeters(dbfsToMeterLevel(lDb), dbfsToMeterLevel(rDb));
        }
      } catch (err) {
        console.error('[audio-engine] update failed', err);
      }
    };

    const unsubscribePlayback = usePlaybackStore.subscribe((playback, previousPlayback) => {
      if (
        playback.currentFrame === previousPlayback.currentFrame &&
        playback.isPlaying === previousPlayback.isPlaying &&
        playback.shuttleSpeed === previousPlayback.shuttleSpeed
      ) {
        return;
      }
      runUpdate(playback);
    });
    const unsubscribeProject = useProjectStore.subscribe(() =>
      runUpdate(usePlaybackStore.getState()),
    );
    runUpdate(usePlaybackStore.getState());

    return () => {
      unsubscribePlayback();
      unsubscribeProject();
      for (const clipId of sourcesRef.current.keys()) {
        removeSource(clipId);
      }
      if (audioCtxRef.current) {
        audioCtxRef.current.close();
        audioCtxRef.current = null;
      }
      usePlaybackStore.getState().setAudioMeters(0, 0);
    };
  }, []);
}
