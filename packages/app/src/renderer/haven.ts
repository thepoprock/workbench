import { useSyncExternalStore } from 'react';
import type { HavenAudio, HavenMessage, HavenState } from '@workbench/shared';
import { hub } from './hub.ts';

// Haven's chat and the one voice-message player, alive for the whole app so a reply
// can play whichever project is open. Each message plays sentence by sentence as its
// audio arrives, so a long reply starts as soon as its first sentence is ready.

interface Queued {
  t: number;
  ready: number; // sentences that exist so far
  done: boolean; // no more are coming
  next: number;
}

interface View extends HavenState {
  playing: number | null; // the message now playing
  unread: boolean;
  notice: string | null;
  autoPlay: boolean; // whether to play new replies without clicking
  older: HavenMessage[]; // fetched by scrolling back, before `messages`
  more: boolean; // older ones exist that haven't been fetched
}

const AUTO_PLAY_KEY = 'haven.autoPlay';
const PHONE = matchMedia('(pointer: coarse)').matches;
// A phone only lets audio start from a touch, so the first touch unlocks this one element.
const SILENCE = 'data:audio/wav;base64,UklGRiQAAABXQVZFZm10IBAAAAABAAEARKwAAIhYAQACABAAZGF0YQAAAAA=';

export const onPhone = PHONE;

let view: View = {
  online: false,
  busy: false,
  listening: false,
  messages: [],
  playing: null,
  unread: false,
  notice: null,
  autoPlay: localStorage.getItem(AUTO_PLAY_KEY) === 'on',
  older: [],
  more: true,
};
const listeners = new Set<() => void>();
const set = (patch: Partial<View>) => {
  view = { ...view, ...patch };
  listeners.forEach((l) => l());
};

export const useHaven = () =>
  useSyncExternalStore(
    (l) => {
      listeners.add(l);
      return () => listeners.delete(l);
    },
    () => view,
  );

const element = new Audio();
const queue: Queued[] = [];
let loading = false;
let shownOpen = false;
let lastSpoken: number | null = null;

const b64Bytes = (b64: string) => Uint8Array.from(atob(b64), (c) => c.charCodeAt(0));

function finished() {
  if (view.playing !== null) void hub.call('haven.playing', { playing: false }).catch(() => {});
  set({ playing: null });
}

async function pump(): Promise<void> {
  if (loading || !element.paused) return;
  const now = queue[0];
  if (!now) return finished();
  if (now.next >= now.ready) {
    if (!now.done) return; // its next sentence arrives as a push
    queue.shift();
    return pump();
  }
  loading = true;
  try {
    const b64 = await hub.call('haven.audio', { t: now.t, part: now.next++ });
    URL.revokeObjectURL(element.src);
    element.src = URL.createObjectURL(new Blob([b64Bytes(b64)], { type: 'audio/wav' }));
    if (view.playing !== now.t) {
      if (view.playing === null) void hub.call('haven.playing', { playing: true }).catch(() => {});
      lastSpoken = now.t;
      set({ playing: now.t });
    }
    await element.play();
  } catch (err) {
    queue.length = 0;
    finished();
    set({ notice: `Couldn't play that: ${(err as Error).message}` });
  } finally {
    loading = false;
  }
}

element.onended = () => void pump();

export function stopPlaying(): void {
  queue.length = 0;
  element.pause();
  finished();
}

export async function play(t: number): Promise<void> {
  stopPlaying();
  lastSpoken = t;
  const entry: Queued = { t, ready: 0, done: false, next: 0 };
  queue.push(entry);
  const { ready, done } = await hub.call('haven.speak', { t });
  entry.ready = Math.max(entry.ready, ready);
  entry.done ||= done;
  void pump();
}

function onAudio(a: HavenAudio): void {
  let entry = queue.find((q) => q.t === a.t);
  if (a.failed) {
    if (entry) queue.splice(queue.indexOf(entry), 1);
    set({ notice: "That voice message couldn't be made." });
    return void pump();
  }
  const wanted = a.auto && view.autoPlay;
  if (!entry && wanted) queue.push((entry = { t: a.t, ready: 0, done: false, next: 0 }));
  if (!entry) return;
  entry.ready = Math.max(entry.ready, a.part + 1);
  entry.done ||= a.done;
  void pump();
}

function onMessage(m: HavenMessage): void {
  set({ messages: [...view.messages, m], unread: view.unread || (m.from === 'haven' && !shownOpen) });
}

async function load(): Promise<void> {
  const state = await hub.call('haven.state', {});
  set(state);
}

export function startHaven(): () => void {
  const unlock = () => {
    element.src = SILENCE;
    void element.play().catch(() => {});
    document.removeEventListener('pointerdown', unlock);
  };
  if (PHONE) document.addEventListener('pointerdown', unlock);
  if (hub.status === 'connected') void load().catch(() => {});
  const offStatus = hub.onStatus((s) => {
    if (s === 'connected') void load().catch(() => {});
  });
  const offPush = hub.onPush((p) => {
    if (p.event === 'haven.update') set(p.data);
    else if (p.event === 'haven.message') onMessage(p.data);
    else if (p.event === 'haven.audio') onAudio(p.data);
    else if (p.event === 'haven.notice') set({ notice: p.data.text });
    else if (p.event === 'haven.control') {
      if (p.data.action === 'stop') stopPlaying();
      else if (lastSpoken !== null) void play(lastSpoken);
    }
  });
  return () => {
    offStatus();
    offPush();
  };
}

export function setShown(open: boolean): void {
  shownOpen = open;
  if (open) set({ unread: false });
}

export function setAutoPlay(on: boolean): void {
  localStorage.setItem(AUTO_PLAY_KEY, on ? 'on' : 'off');
  set({ autoPlay: on });
}

export const clearNotice = () => set({ notice: null });

// The page before the oldest message on screen. Resolves false when there is nothing older.
let fetching: Promise<boolean> | null = null;
export function loadOlder(): Promise<boolean> {
  if (!view.more) return Promise.resolve(false);
  fetching ??= (async () => {
    const oldest = view.older[0] ?? view.messages[0];
    if (!oldest) return false;
    const { messages, more } = await hub.call('haven.history', { before: oldest.t });
    set({ older: [...messages, ...view.older], more });
    return messages.length > 0;
  })().finally(() => {
    fetching = null;
  });
  return fetching;
}
