// ============================================================================
// audio: procedural underwater ambience (no sample files)
//
// `source/src/audio.js` from https://github.com/Noniv/abyssal-garden (MIT, see
// LICENSE-abyssal), ported to run outside the page:
// - the camera position comes from setPosition() instead of upstream's global
//   F array (the renderer moved to a Worker, so the main thread's camera drives
//   the water rush and the surface wash)
// - the graph is built by start() on the first click / key / touch, and on
//   mount when the browser already allows audio
// - everything else (layers, levels, random streams, timing) is unchanged
//
// A fixed Web Audio graph, built once and driven by a 10 Hz timer, not the
// frame loop. Layers: rumble, surface wash, water rush (follows camera speed),
// drone, bubbles, chimes and distant whale calls.
// ============================================================================
const VOL = 0.78 // master level: about -18.5 LUFS, peaks near -5.5 dBFS
const { min, pow, exp } = Math
const clamp = (x, a, b) => (x < a ? a : x > b ? b : x)
const rnd = Math.random
const rr = (a, b) => a + (b - a) * rnd()
const dist = (x, y, z) => Math.sqrt(x * x + y * y + z * z)

export function createAbyssalAudio({ volume: initialVolume = 1, muted: initialMuted = false } = {}) {
  let AC = null, OUT = null, timer = 0, muted = initialMuted
  let volume = clamp(initialVolume, 0, 1)
  let x = 0, y = 0, z = 0
  let onVisibility = null

  // ミュートは音量を 0 にするのではなく、マスターの目標値を 0 にする（戻したとき同じ音量へ）
  const level = () => (muted ? 0 : VOL * volume)

  function mkSound(ac) {
    const sr = ac.sampleRate
    // node of class C with options o, connected to every node / param in `to`; sources start at once
    const N = (C, o, ...to) => { const n = new C(ac, o); for (const d of to) n.connect(d); if (n.start) n.start(); return n; }
    const G = (gain, ...to) => N(GainNode, { gain }, ...to)
    const BQ = (type, frequency, Q, ...to) => N(BiquadFilterNode, { type, frequency, Q }, ...to)
    const lfo = (frequency, depth, to) => N(OscillatorNode, { frequency }, G(depth, to))
    const noise = (secs, f) => { const n = sr * secs | 0, b = new AudioBuffer({ length: n, numberOfChannels: 2, sampleRate: sr }); f(b.getChannelData(0), n); f(b.getChannelData(1), n); return b; }
    // seamless brown noise loop (the end cross-fades into the start)
    const nb = noise(11, (d, n) => { for (let i = 0, b = 0; i < n + 4096; i++) { b = (b + 0.02 * (rnd() * 2 - 1)) / 1.02; if (i < n) d[i] = b * 3.5; else { const k = (i - n) / 4096; d[i - n] = d[i - n] * k + b * 3.5 * (1 - k); } } });
    // reverb impulse: 5 s of noise that fades out and gets darker
    const ir = noise(5, (d, n) => { for (let i = 0, b = 0; i < n; i++) { const t = i / sr; b += (rnd() * 2 - 1 - b) * (0.04 + 0.5 * exp(-t * 2)); d[i] = b * (1 - exp(-t * 30)) * exp(-t * 1.5) * (1 - i / n); } });

    const lim = N(DynamicsCompressorNode, { threshold: -6, knee: 6, ratio: 20, attack: 0.003, release: 0.3 }, ac.destination);
    const out = OUT = G(0, lim), wet = N(ConvolverNode, { buffer: ir }, out);
    const src = (playbackRate, ...to) => N(AudioBufferSourceNode, { buffer: nb, loop: true, playbackRate }, ...to);
    // rumble
    const rum = G(0.34, out); src(1, BQ('lowpass', 150, 0.7, rum)); lfo(0.07, 0.11, rum.gain); lfo(0.113, 0.08, rum.gain);
    // surface wash + water rush: the same noise played at another speed, so the loops never line up
    const wash = G(0.25, out), wave = G(1, wash), rush = G(0, out), rushF = BQ('bandpass', 300, 0.9, rush);
    src(0.63, BQ('bandpass', 420, 0.5, wave), rushF); lfo(0.09, 0.3, wave.gain); lfo(0.151, 0.25, wave.gain);
    // drone: stacked fifths on D, each note a pair of slightly detuned sines that slowly beat
    const pad = G(1, out, G(1.5, wet));
    [73.42, 110, 164.81, 246.94, 369.99].forEach((f, i) => { const g = G(0.022 - i * 0.003, pad); N(OscillatorNode, { frequency: f }, g); N(OscillatorNode, { frequency: f + rr(0.03, 0.11) }, g); });
    // pooled voices: oscillator -> envelope -> pan -> dry + reverb
    const pool = (n, send, type) => Array.from({ length: n }, () => { const p = N(StereoPannerNode, {}, out, G(send, wet)), g = G(0, p); return { p, g, o: N(OscillatorNode, { type }, g) }; });
    const bub = pool(4, 0.12), chime = pool(3, 1.2), whale = pool(2, 2, 'triangle');
    // one note: pitch glides f0 -> f1 over dur, level rises to vol in att then dies away
    const play = (vs, t, f0, f1, dur, vol, att) => {
      const v = vs.shift(), f = v.o.frequency, g = v.g.gain; vs.push(v);
      v.p.pan.setValueAtTime(rr(-0.7, 0.7), t);
      f.setValueAtTime(f0, t); f.exponentialRampToValueAtTime(f1, t + dur);
      g.setValueAtTime(0, t); g.linearRampToValueAtTime(vol, t + att); g.setTargetAtTime(0, t + att, (dur - att) / 5);
    };
    const NOTES = [0, 2, 5, 7, 9, 12, 14, 17, 19]; // D major pentatonic, in semitones above A4
    let lt = ac.currentTime, tB = lt + 1.5, tC = lt + 5, tW = lt + 12, lx = x, ly = y, lz = z;
    out.gain.setTargetAtTime(level(), lt, 1);
    return () => {
      const now = ac.currentTime, t = now + 0.05, dt = now - lt;
      if (dt <= 0) return;
      let v = dist(x - lx, y - ly, z - lz) / dt; if (v > 60) v = 0; // ignore jumps to a viewpoint
      lt = now; lx = x; ly = y; lz = z;
      rush.gain.setTargetAtTime(0.5 * pow(min(v / 26, 1), 1.2), t, 0.3); rushF.frequency.setTargetAtTime(220 + v * 14, t, 0.3);
      const s = clamp(1 + ly / 30, 0, 1); wash.gain.setTargetAtTime(0.25 + 0.55 * s * s, t, 0.5);
      if (t > tB) { // a burst of 1-6 bubbles: short rising blips, smaller bubbles higher and shorter
        let tt = t;
        for (let n = 1 + rnd() * rnd() * 6 | 0; n--;) { const f = rr(380, 1300); play(bub, tt, f, f * rr(1.4, 2.2), 0.05 + 40 / f, rr(0.03, 0.08), 0.006); tt += rr(0.07, 0.2); }
        tB = tt + rr(0.5, 5);
      }
      if (t > tC) { const f = 440 * pow(2, NOTES[rnd() * 9 | 0] / 12); play(chime, t, f, f, 5, rr(0.02, 0.04), 0.03); tC = t + rr(2.5, 9); }
      if (t > tW) { // a phrase of 2-3 slow glides
        let tt = t;
        for (let n = 2 + rnd() * 2 | 0; n--;) { const f = rr(170, 380), d = rr(1.6, 3.2); play(whale, tt, f, f * rr(0.6, 1.7), d, 0.08, d * 0.4); tt += d * 0.8; }
        tW = tt + rr(20, 50);
      }
    };
  }

  /** カメラのワールド座標（水中の視点）。rush と wash がこれで動く */
  function setPosition(px, py, pz) {
    x = px; y = py; z = pz;
  }

  /** called on every click / key / touch: builds the graph once and resumes it when the browser allows */
  function start() {
    if (!AC) {
      AC = new AudioContext({ latencyHint: 'playback' });
      timer = setInterval(mkSound(AC), 100);
      onVisibility = () => { if (!AC) return; document.hidden ? AC.suspend() : AC.resume().catch(() => {}); };
      document.addEventListener('visibilitychange', onVisibility);
    }
    if (AC.state === 'suspended' && !document.hidden) AC.resume().catch(() => {});
  }

  function setMuted(value) {
    muted = Boolean(value);
    apply();
  }

  /** 0..1。上流のマスターレベル（0.78）に掛かる */
  function setVolume(value) {
    const next = Number(value);
    volume = Number.isFinite(next) ? clamp(next, 0, 1) : volume;
    apply();
  }

  function apply() {
    if (OUT && AC) OUT.gain.setTargetAtTime(level(), AC.currentTime, 0.08);
  }

  function toggleMute() {
    setMuted(!muted);
  }

  function dispose() {
    clearInterval(timer); timer = 0;
    if (onVisibility) document.removeEventListener('visibilitychange', onVisibility);
    onVisibility = null;
    if (AC) AC.close().catch(() => {});
    AC = OUT = null;
  }

  return {
    start,
    setPosition,
    setVolume,
    setMuted,
    toggleMute,
    dispose,
    get volume() { return volume },
    get muted() { return muted },
    get ready() { return AC !== null },
    get state() { return AC ? AC.state : 'closed' },
  }
}
