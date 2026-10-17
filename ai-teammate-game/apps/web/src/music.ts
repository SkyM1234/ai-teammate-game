import type { Phase } from '../../../packages/game-core/src/types.ts';

type Track = 'bgm-exploration' | 'rescue-success' | 'mission-failure';

export class GameMusic {
  private context: AudioContext | null = null;
  private master: GainNode | null = null;
  private buffers = new Map<Track, Promise<AudioBuffer>>();
  private playing: { source: AudioBufferSourceNode; gain: GainNode } | null = null;
  private session = '';
  private track: Track | null = null;
  private started = '';
  private revision = 0;
  private visible = true;
  private enabled = true;
  private readonly report: (enabled: boolean) => void;
  private readonly onError: () => void;

  constructor(report: (enabled: boolean) => void, onError: () => void) {
    this.report = report; this.onError = onError;
    try { this.enabled = localStorage.getItem('last-oxygen-music') !== 'off'; } catch { /* Storage may be disabled. */ }
    report(this.enabled);
  }

  update(session: string, phase: Phase, replay = false) {
    const track = replay ? null : phase === 'success' ? 'rescue-success' : phase === 'failure' ? 'mission-failure' : 'bgm-exploration';
    if (session === this.session && track === this.track) return;
    this.session = session; this.track = track; this.started = ''; this.revision++;
    this.fadeOut();
    void this.play();
  }

  async unlock() {
    if (!this.enabled || !this.visible) return;
    try {
      if (!this.context) {
        this.context = new AudioContext();
        this.master = this.context.createGain(); this.master.gain.value = 0.35;
        this.master.connect(this.context.destination);
      }
      await this.context.resume();
      await this.play();
    } catch { this.onError(); }
  }

  toggle() {
    this.enabled = !this.enabled;
    try { localStorage.setItem('last-oxygen-music', this.enabled ? 'on' : 'off'); } catch { /* Playback still works without storage. */ }
    this.report(this.enabled);
    if (this.master && this.context) {
      this.master.gain.cancelScheduledValues(this.context.currentTime);
      this.master.gain.setTargetAtTime(this.enabled ? 0.35 : 0, this.context.currentTime, 0.04);
    }
    if (this.enabled) void this.unlock();
    else if (this.context) void this.context.suspend().catch(() => undefined);
  }

  setVisible(visible: boolean) {
    this.visible = visible;
    if (!visible && this.context) void this.context.suspend().catch(() => undefined);
    else if (this.context && this.enabled) void this.unlock();
  }

  dispose() {
    this.revision++; this.track = null;
    if (this.context) void this.context.close().catch(() => undefined);
    this.context = null; this.playing = null;
  }

  private fadeOut() {
    if (!this.playing || !this.context) return;
    const { source, gain } = this.playing;
    const now = this.context.currentTime;
    gain.gain.cancelScheduledValues(now);
    gain.gain.setValueAtTime(gain.gain.value, now);
    gain.gain.linearRampToValueAtTime(0, now + 0.7);
    source.stop(now + 0.72);
    this.playing = null;
  }

  private async play() {
    const context = this.context;
    const track = this.track;
    const key = `${this.session}:${track}`;
    if (!context || !track || !this.enabled || !this.visible || context.state !== 'running' || this.started === key) return;
    this.started = key;
    const revision = this.revision;
    try {
      let buffer = this.buffers.get(track);
      if (!buffer) {
        buffer = fetch(`/audio/${track}.wav`).then(async response => {
          if (!response.ok) throw new Error('Music unavailable');
          return context.decodeAudioData(await response.arrayBuffer());
        });
        this.buffers.set(track, buffer);
        void buffer.catch(() => { this.buffers.delete(track); });
      }
      const decoded = await buffer;
      if (revision !== this.revision || context !== this.context) return;
      if (!this.enabled || !this.visible || context.state !== 'running') { this.started = ''; return; }
      const source = context.createBufferSource(); source.buffer = decoded;
      source.loop = track === 'bgm-exploration';
      const gain = context.createGain(); gain.gain.value = 0;
      source.connect(gain); gain.connect(this.master!);
      gain.gain.linearRampToValueAtTime(1, context.currentTime + (source.loop ? 1.8 : 0.08));
      source.onended = () => { source.disconnect(); gain.disconnect(); };
      source.start(); this.playing = { source, gain };
    } catch {
      if (revision === this.revision) { this.started = ''; this.onError(); }
    }
  }
}
