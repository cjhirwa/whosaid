/* Pure logic shared by the page and the tests: no DOM, no network.
   Loaded as a plain <script> in the browser (exposes `Core`) and via require() in Node. */
(function (root) {
  'use strict';

  const PARAGRAPH_GAP_MS = 20000; // same speaker after this much silence starts a new paragraph

  function fmt(ms) {
    const s = Math.max(0, Math.floor(ms / 1000));
    const h = Math.floor(s / 3600), m = Math.floor(s / 60) % 60, sec = s % 60;
    return (h ? h + ':' : '') + String(m).padStart(2, '0') + ':' + String(sec).padStart(2, '0');
  }

  // Deepgram numbers speakers per stream, so keys are scoped to a connection and channel.
  // In "both" mode channel 0 is the user's own mic.
  function speakerKey(mode, connId, channel, speaker) {
    if (mode === 'both' && channel === 0) return 'me';
    return `${connId}:${channel}:${speaker ?? 0}`;
  }

  const wordText = w => w.punctuated_word || w.word;

  class Transcript {
    constructor({ lines = [], names = {}, numbers = {} } = {}) {
      this.lines = lines;     // paragraphs: {key, t, end, text}; times in ms
      this.names = names;     // key -> custom name
      this.numbers = numbers; // key -> "Speaker N" number, in order of appearance
    }

    // Accepts the current storage format, or the older one keyed by bare speaker number.
    static fromStorage(current, legacy) {
      if (current) return new Transcript(current);
      const t = new Transcript();
      for (const l of legacy?.lines || []) {
        const key = 'legacy:' + l.speaker;
        t.lines.push({ key, t: l.t, end: l.end, text: l.text });
        t.numbers[key] = l.speaker + 1;
        if (legacy.names?.[l.speaker]) t.names[key] = legacy.names[l.speaker];
      }
      return t;
    }

    nextNumber() {
      return Object.values(this.numbers).reduce((a, b) => Math.max(a, b), 0) + 1;
    }

    nameOf(key) {
      if (this.names[key]) return this.names[key];
      if (key === 'me') return 'You';
      return `Speaker ${this.numbers[key] || this.nextNumber()}`;
    }

    // -1 for "me", otherwise an index into a 6-colour palette.
    colorIndex(key) {
      return key === 'me' ? -1 : ((this.numbers[key] || this.nextNumber()) - 1) % 6;
    }

    // Appends one word; returns true when it started a new paragraph.
    addWord(key, t, end, text, forceNew = false) {
      if (key !== 'me' && !this.numbers[key]) this.numbers[key] = this.nextNumber();
      let last = this.lines[this.lines.length - 1];
      const fresh = !last || forceNew || last.key !== key || t - last.end > PARAGRAPH_GAP_MS;
      if (fresh) {
        last = { key, t, end: t, text: '' };
        this.lines.push(last);
      }
      last.text += (last.text ? ' ' : '') + text;
      last.end = end;
      return fresh;
    }

    rename(key, name) {
      const trimmed = (name || '').trim();
      if (trimmed) this.names[key] = trimmed;
      else delete this.names[key];
    }

    // Different keys renamed to the same person, close together, read as one block.
    isContinuation(prev, line) {
      return !!prev && this.nameOf(prev.key) === this.nameOf(line.key) && line.t - prev.end <= PARAGRAPH_GAP_MS;
    }

    speakerKeys() {
      return [...new Set(this.lines.map(l => l.key))];
    }

    peopleCount() {
      return new Set(this.speakerKeys().map(k => this.nameOf(k))).size;
    }

    endMs() {
      return this.lines.length ? this.lines[this.lines.length - 1].end : 0;
    }

    toText() {
      return this.lines.map(l => `[${fmt(l.t)}] ${this.nameOf(l.key)}: ${l.text}`).join('\n\n');
    }

    toJSON() {
      return { lines: this.lines, names: this.names, numbers: this.numbers };
    }

    clear() {
      this.lines = [];
      this.names = {};
      this.numbers = {};
    }
  }

  // Groups not-yet-final words into same-speaker runs, in time order.
  // channels: [{channel, words: [{key, t, text}]}]
  function pendingRuns(channels) {
    const out = [];
    for (const { channel, words } of channels) {
      let run = null;
      for (const w of words) {
        if (run && run.key === w.key) run.texts.push(w.text);
        else out.push((run = { channel, key: w.key, t: w.t, texts: [w.text] }));
      }
    }
    return out
      .sort((a, b) => a.t - b.t)
      .map(r => ({ channel: r.channel, key: r.key, t: r.t, text: r.texts.join(' ') }));
  }

  // ---------- Deepgram protocol ----------

  function listenParams({ model, language, rate, channels }) {
    return new URLSearchParams({
      model, language, diarize: 'true', smart_format: 'true',
      interim_results: 'true', utterance_end_ms: '1000', vad_events: 'true', endpointing: '300',
      encoding: 'linear16', sample_rate: String(rate), channels: String(channels),
      multichannel: String(channels > 1),
    });
  }

  // Normalises a Results message; null for any other message type.
  function parseResult(msg) {
    if (!msg || msg.type !== 'Results') return null;
    return {
      channel: msg.channel_index?.[0] ?? 0,
      words: msg.channel?.alternatives?.[0]?.words || [],
      isFinal: !!msg.is_final,
      endSec: (msg.start || 0) + (msg.duration || 0),
    };
  }

  // ---------- audio buffering ----------

  // Drops chunks older than maxFrames behind newestFrame (mutates and returns the array).
  function trimByAge(chunks, newestFrame, maxFrames) {
    while (chunks.length && newestFrame - chunks[0].frame > maxFrames) chunks.shift();
    return chunks;
  }

  // The earliest frame any channel still needs: everything from here on must be replayed.
  function firstUnfinalisedFrame(done, startFrame, channels) {
    let min = Infinity;
    for (let ch = 0; ch < channels; ch++) min = Math.min(min, done[ch] ?? startFrame ?? 0);
    return min === Infinity ? 0 : min;
  }

  function chunksFrom(chunks, frame) {
    return chunks.filter(c => c.frame + c.frames > frame);
  }

  // Float audio -> interleaved 16-bit PCM chunks of `size` frames. Its source is injected
  // into the AudioWorklet, so it must stay self-contained.
  class PcmChunker {
    constructor(size) {
      this.size = size;
      this.channels = 0;
    }

    reset(channels) {
      this.channels = channels;
      this.buf = new Int16Array(this.size * channels);
      this.n = 0;
      this.sum = 0;
    }

    // input: one Float32Array per channel. Returns finished chunks: {pcm, frames, rms}.
    push(input) {
      const out = [];
      if (!input || !input.length) return out;
      if (input.length !== this.channels) this.reset(input.length);
      const ch = this.channels;
      for (let i = 0; i < input[0].length; i++) {
        for (let c = 0; c < ch; c++) {
          let v = input[c][i];
          this.sum += v * v;
          v = v < -1 ? -1 : v > 1 ? 1 : v;
          this.buf[this.n * ch + c] = v < 0 ? v * 0x8000 : v * 0x7fff;
        }
        if (++this.n === this.size) {
          out.push({ pcm: this.buf.buffer, frames: this.n, rms: Math.sqrt(this.sum / (this.n * ch)) });
          this.reset(ch);
        }
      }
      return out;
    }
  }

  const api = {
    PARAGRAPH_GAP_MS, fmt, speakerKey, wordText, Transcript, pendingRuns,
    listenParams, parseResult, trimByAge, firstUnfinalisedFrame, chunksFrom, PcmChunker,
  };
  if (typeof module === 'object' && module.exports) module.exports = api;
  else root.Core = api;
})(typeof globalThis !== 'undefined' ? globalThis : this);
