const test = require('node:test');
const assert = require('node:assert/strict');
const Core = require('../core.js');

const { fmt, speakerKey, Transcript, pendingRuns, listenParams, parseResult,
  trimByAge, firstUnfinalisedFrame, chunksFrom, PcmChunker, PARAGRAPH_GAP_MS } = Core;

test('fmt formats minutes, hours and clamps negatives', () => {
  assert.equal(fmt(0), '00:00');
  assert.equal(fmt(61_999), '01:01');
  assert.equal(fmt(3_725_000), '1:02:05');
  assert.equal(fmt(-500), '00:00');
});

test('speakerKey scopes speakers to connection and channel', () => {
  assert.equal(speakerKey('mic', 'c1', 0, 2), 'c1:0:2');
  assert.equal(speakerKey('mic', 'c1', 0, undefined), 'c1:0:0');
  assert.equal(speakerKey('both', 'c1', 0, 3), 'me', 'mic channel in both mode is always "me"');
  assert.equal(speakerKey('both', 'c1', 1, 3), 'c1:1:3');
  assert.notEqual(speakerKey('mic', 'c1', 0, 0), speakerKey('mic', 'c2', 0, 0));
});

test.describe('Transcript', () => {
  test('keeps a speaker in one paragraph and splits on speaker change', () => {
    const t = new Transcript();
    t.addWord('a', 0, 400, 'Hello');
    t.addWord('a', 500, 900, 'there.');
    t.addWord('b', 1000, 1400, 'Hi.');
    t.addWord('a', 1500, 1900, 'Again.');
    assert.deepEqual(t.lines.map(l => [l.key, l.text]), [['a', 'Hello there.'], ['b', 'Hi.'], ['a', 'Again.']]);
    assert.equal(t.lines[0].t, 0);
    assert.equal(t.lines[0].end, 900);
  });

  test('splits the same speaker after a long silence', () => {
    const t = new Transcript();
    t.addWord('a', 0, 500, 'One.');
    t.addWord('a', 500 + PARAGRAPH_GAP_MS - 1, 500 + PARAGRAPH_GAP_MS, 'Close.');
    t.addWord('a', 1000 + 2 * PARAGRAPH_GAP_MS, 1100 + 2 * PARAGRAPH_GAP_MS, 'Later.');
    assert.equal(t.lines.length, 2);
    assert.equal(t.lines[1].text, 'Later.');
  });

  test('forceNew starts a paragraph even for the same speaker', () => {
    const t = new Transcript();
    t.addWord('me', 0, 100, 'a');
    assert.equal(t.addWord('me', 200, 300, 'b', true), true);
    assert.equal(t.lines.length, 2);
  });

  test('numbers speakers in order of appearance; "me" is "You" and unnumbered', () => {
    const t = new Transcript();
    t.addWord('x:0:5', 0, 1, 'a');
    t.addWord('me', 2, 3, 'b');
    t.addWord('y:0:0', 4, 5, 'c');
    assert.equal(t.nameOf('x:0:5'), 'Speaker 1');
    assert.equal(t.nameOf('me'), 'You');
    assert.equal(t.nameOf('y:0:0'), 'Speaker 2');
    assert.equal(t.nameOf('unseen'), 'Speaker 3', 'provisional name for interim speakers');
    assert.equal(t.colorIndex('me'), -1);
    assert.equal(t.colorIndex('x:0:5'), 0);
    assert.equal(t.colorIndex('y:0:0'), 1);
  });

  test('rename sets, trims and clears names', () => {
    const t = new Transcript();
    t.addWord('k', 0, 1, 'a');
    t.rename('k', '  Alice ');
    assert.equal(t.nameOf('k'), 'Alice');
    t.rename('k', '   ');
    assert.equal(t.nameOf('k'), 'Speaker 1');
  });

  test('speakers renamed to the same name merge in counts and continuation', () => {
    const t = new Transcript();
    t.addWord('c1:0:0', 0, 1000, 'Before');
    t.addWord('c2:0:1', 1500, 2000, 'after reconnect');
    assert.equal(t.peopleCount(), 2);
    assert.equal(t.isContinuation(t.lines[0], t.lines[1]), false);
    t.rename('c1:0:0', 'Ann');
    t.rename('c2:0:1', 'Ann');
    assert.equal(t.peopleCount(), 1);
    assert.equal(t.isContinuation(t.lines[0], t.lines[1]), true);
    assert.equal(t.isContinuation(undefined, t.lines[0]), false);
  });

  test('toText exports timestamps and names', () => {
    const t = new Transcript();
    t.addWord('a', 0, 1, 'Hi.');
    t.addWord('b', 65_000, 66_000, 'Hello.');
    t.rename('b', 'Bo');
    assert.equal(t.toText(), '[00:00] Speaker 1: Hi.\n\n[01:05] Bo: Hello.');
  });

  test('round-trips through JSON storage', () => {
    const t = new Transcript();
    t.addWord('a', 0, 10, 'x');
    t.rename('a', 'Al');
    const back = Transcript.fromStorage(JSON.parse(JSON.stringify(t)));
    assert.deepEqual(back.toJSON(), t.toJSON());
    assert.equal(back.endMs(), 10);
  });

  test('migrates the legacy format keyed by speaker number', () => {
    const legacy = { lines: [{ speaker: 1, t: 0, end: 5, text: 'old' }], names: { 1: 'Zed' } };
    const t = Transcript.fromStorage(null, legacy);
    assert.equal(t.lines[0].key, 'legacy:1');
    assert.equal(t.nameOf('legacy:1'), 'Zed');
    assert.equal(t.numbers['legacy:1'], 2);
    assert.equal(Transcript.fromStorage(null, null).lines.length, 0);
  });

  test('clear empties everything', () => {
    const t = new Transcript();
    t.addWord('a', 0, 1, 'x');
    t.rename('a', 'A');
    t.clear();
    assert.deepEqual(t.toJSON(), { lines: [], names: {}, numbers: {} });
    assert.equal(t.endMs(), 0);
  });
});

test('pendingRuns groups by speaker per channel and orders by time', () => {
  const runs = pendingRuns([
    { channel: '1', words: [{ key: 'b', t: 300, text: 'later' }] },
    { channel: '0', words: [
      { key: 'a', t: 100, text: 'one' }, { key: 'a', t: 150, text: 'two' }, { key: 'c', t: 400, text: 'three' },
    ] },
  ]);
  assert.deepEqual(runs.map(r => [r.key, r.text]), [['a', 'one two'], ['b', 'later'], ['c', 'three']]);
  assert.deepEqual(pendingRuns([]), []);
});

test('listenParams requests diarization and raw PCM, multichannel only for stereo', () => {
  const mono = listenParams({ model: 'nova-3', language: 'en', rate: 48000, channels: 1 });
  assert.equal(mono.get('diarize'), 'true');
  assert.equal(mono.get('encoding'), 'linear16');
  assert.equal(mono.get('sample_rate'), '48000');
  assert.equal(mono.get('multichannel'), 'false');
  assert.equal(mono.get('interim_results'), 'true');
  const stereo = listenParams({ model: 'nova-3', language: 'multi', rate: 16000, channels: 2 });
  assert.equal(stereo.get('channels'), '2');
  assert.equal(stereo.get('multichannel'), 'true');
  assert.equal(stereo.get('language'), 'multi');
});

test('parseResult normalises Deepgram messages', () => {
  const words = [{ word: 'hi', start: 1, end: 1.2, speaker: 0 }];
  assert.deepEqual(
    parseResult({ type: 'Results', channel_index: [1, 2], is_final: true, start: 2, duration: 1.5,
      channel: { alternatives: [{ words }] } }),
    { channel: 1, words, isFinal: true, endSec: 3.5 },
  );
  assert.deepEqual(parseResult({ type: 'Results', channel: {} }), { channel: 0, words: [], isFinal: false, endSec: 0 });
  assert.equal(parseResult({ type: 'Metadata' }), null);
  assert.equal(parseResult(null), null);
});

test.describe('audio buffering', () => {
  const chunks = () => [0, 100, 200, 300].map(frame => ({ frame, frames: 100 }));

  test('trimByAge drops chunks older than the window', () => {
    assert.deepEqual(trimByAge(chunks(), 300, 150).map(c => c.frame), [200, 300]);
    assert.deepEqual(trimByAge([], 300, 150), []);
  });

  test('firstUnfinalisedFrame takes the slowest channel', () => {
    assert.equal(firstUnfinalisedFrame({ 0: 250, 1: 120 }, 0, 2), 120);
    assert.equal(firstUnfinalisedFrame({ 0: 250 }, 50, 2), 50, 'a channel with no finals yet needs all audio');
    assert.equal(firstUnfinalisedFrame({}, null, 1), 0);
  });

  test('chunksFrom keeps the chunk containing the frame and everything after', () => {
    assert.deepEqual(chunksFrom(chunks(), 150).map(c => c.frame), [100, 200, 300]);
    assert.deepEqual(chunksFrom(chunks(), 200).map(c => c.frame), [200, 300]);
    assert.deepEqual(chunksFrom(chunks(), 400), []);
  });
});

test.describe('PcmChunker', () => {
  test('emits fixed-size mono chunks and carries the remainder over', () => {
    const c = new PcmChunker(4);
    assert.equal(c.push([new Float32Array([0, 0.5, -0.5])]).length, 0);
    const [chunk] = c.push([new Float32Array([1, 0.25])]);
    assert.equal(chunk.frames, 4);
    assert.deepEqual([...new Int16Array(chunk.pcm)], [0, 16383, -16384, 32767]);
    const [next] = c.push([new Float32Array([0, 0, 0])]);
    assert.deepEqual([...new Int16Array(next.pcm)], [8191, 0, 0, 0], 'leftover sample starts the next chunk');
  });

  test('interleaves stereo and clips out-of-range samples', () => {
    const c = new PcmChunker(2);
    const [chunk] = c.push([new Float32Array([2, -3]), new Float32Array([-1, 0])]);
    assert.deepEqual([...new Int16Array(chunk.pcm)], [32767, -32768, -32768, 0]);
  });

  test('reports RMS level', () => {
    const c = new PcmChunker(2);
    const [chunk] = c.push([new Float32Array([0.5, -0.5])]);
    assert.ok(Math.abs(chunk.rms - 0.5) < 1e-9);
  });

  test('ignores empty input and gives each chunk its own buffer', () => {
    const c = new PcmChunker(1);
    assert.deepEqual(c.push(undefined), []);
    assert.deepEqual(c.push([]), []);
    const out = c.push([new Float32Array([0.1, 0.2])]);
    assert.equal(out.length, 2);
    assert.notEqual(out[0].pcm, out[1].pcm);
  });

  test('source is self-contained so it can be injected into the AudioWorklet', () => {
    const Rebuilt = new Function(`${PcmChunker}; return PcmChunker;`)();
    const [chunk] = new Rebuilt(1).push([new Float32Array([1])]);
    assert.deepEqual([...new Int16Array(chunk.pcm)], [32767]);
  });
});
