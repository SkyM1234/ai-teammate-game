import assert from 'node:assert/strict';
import test from 'node:test';
import type { TestContext } from 'node:test';
import { GameMusic } from '../apps/web/src/music.ts';

function fixture(t: TestContext) {
  const previous = { AudioContext: globalThis.AudioContext, fetch: globalThis.fetch, localStorage: globalThis.localStorage };
  const sources: { buffer: unknown; loop: boolean; starts: number; stops: number }[] = [];
  let context: FakeContext;
  const saved = new Map<string, string>();
  let errors = 0;
  let enabled = true;
  class FakeContext {
    state = 'suspended'; currentTime = 0; destination = {};
    constructor() { context = this; }
    async resume() { this.state = 'running'; }
    async suspend() { this.state = 'suspended'; }
    async close() { this.state = 'closed'; }
    async decodeAudioData(data: ArrayBuffer) { return new TextDecoder().decode(data); }
    createGain() {
      return { gain: { value: 0, cancelScheduledValues() {}, setValueAtTime() {}, setTargetAtTime() {}, linearRampToValueAtTime() {} }, connect() {}, disconnect() {} };
    }
    createBufferSource() {
      const source = { buffer: null as unknown, loop: false, starts: 0, stops: 0, connect() {}, disconnect() {},
        start() { this.starts++; }, stop() { this.stops++; } };
      sources.push(source); return source;
    }
  }
  globalThis.AudioContext = FakeContext as unknown as typeof AudioContext;
  globalThis.fetch = async input => new Response(String(input));
  Object.defineProperty(globalThis, 'localStorage', { configurable: true, value: { getItem: (key: string) => saved.get(key) ?? null, setItem: (key: string, value: string) => saved.set(key, value) } });
  t.after(() => {
    globalThis.AudioContext = previous.AudioContext; globalThis.fetch = previous.fetch;
    Object.defineProperty(globalThis, 'localStorage', { configurable: true, value: previous.localStorage });
  });
  const music = new GameMusic(value => { enabled = value; }, () => errors++);
  return { music, sources, saved, context: () => context, errors: () => errors, enabled: () => enabled };
}

const settled = () => new Promise<void>(resolve => setImmediate(resolve));
function deferred<T>() {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>(done => { resolve = done; });
  return { promise, resolve };
}

test('music waits for interaction, loops exploration, and does not restart on state updates', async t => {
  const { music, sources } = fixture(t);
  music.update('session-a', 'awaiting_command'); assert.equal(sources.length, 0);
  await music.unlock(); assert.equal(sources.length, 1); assert.equal(sources[0].loop, true);
  music.update('session-a', 'executing'); await music.unlock();
  assert.equal(sources.length, 1);
  music.update('session-a', 'success'); await settled();
  assert.equal(sources.length, 2); assert.equal(sources[1].loop, false);
  assert.equal(sources[1].buffer, '/audio/rescue-success.wav'); assert.equal(sources[0].stops, 1);
  music.update('session-a', 'success'); await music.unlock(); assert.equal(sources.length, 2);
  music.update('session-b', 'failure'); await settled();
  assert.equal(sources[2].buffer, '/audio/mission-failure.wav'); assert.equal(sources[2].loop, false);
});

test('muting persists preference, suspends playback, and resumes without replaying the ending', async t => {
  const f = fixture(t); f.music.update('a', 'success'); await f.music.unlock();
  f.music.toggle(); await settled();
  assert.equal(f.enabled(), false); assert.equal(f.saved.get('last-oxygen-music'), 'off');
  assert.equal(f.context().state, 'suspended');
  let restored = true;
  new GameMusic(value => { restored = value; }, () => undefined);
  assert.equal(restored, false);
  f.music.toggle(); await settled();
  assert.equal(f.context().state, 'running'); assert.equal(f.sources.length, 1);
  f.music.setVisible(false); await settled(); assert.equal(f.context().state, 'suspended');
  f.music.setVisible(true); await settled(); assert.equal(f.sources.length, 1);
});

test('replay suppresses all music and new sessions restore exploration', async t => {
  const { music, sources } = fixture(t);
  music.update('a', 'awaiting_command'); await music.unlock();
  music.update('a', 'success', true); music.update('a', 'failure', true); await settled();
  assert.equal(sources.length, 1); assert.equal(sources[0].stops, 1);
  music.update('b', 'awaiting_command'); await settled();
  assert.equal(sources.length, 2); assert.equal(sources[1].loop, true);
});

test('late downloads cannot start stale exploration after a terminal transition', async t => {
  const { music, sources } = fixture(t);
  const pending = deferred<Response>();
  globalThis.fetch = input => String(input).includes('exploration') ? pending.promise : Promise.resolve(new Response(String(input)));
  music.update('a', 'awaiting_command'); const unlocking = music.unlock(); await settled();
  music.update('a', 'success'); await settled();
  pending.resolve(new Response('/audio/bgm-exploration.wav')); await unlocking;
  assert.equal(sources.length, 1); assert.equal(sources[0].buffer, '/audio/rescue-success.wav');
});

test('failed downloads can retry and disposal cancels pending playback', async t => {
  const f = fixture(t);
  globalThis.fetch = async () => new Response('', { status: 404 });
  f.music.update('a', 'awaiting_command'); await f.music.unlock(); assert.equal(f.errors(), 1);
  const pending = deferred<Response>(); globalThis.fetch = () => pending.promise;
  const retrying = f.music.unlock(); await settled(); f.music.dispose();
  pending.resolve(new Response('music')); await retrying;
  assert.equal(f.sources.length, 0); assert.equal(f.context().state, 'closed');
});
