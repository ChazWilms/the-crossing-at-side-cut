// All audio is synthesized with the Web Audio API — no sound files, in the
// same spirit as the procedural textures and geometry.

export class GameAudio {
  constructor() {
    this.ctx = null;
    this.started = false;
    this.volumeScale = parseFloat(localStorage.getItem('sidecut-volume') ?? '1');
  }

  /** 0..1 — scales both the WebAudio graph and the HTML music tracks. */
  setMasterVolume(v) {
    this.volumeScale = Math.min(1.5, Math.max(0, v));
    localStorage.setItem('sidecut-volume', String(this.volumeScale));
    if (this.master) this.master.gain.value = 0.8 * this.volumeScale;
  }

  // Must be called from a user gesture (pointer lock click) — browsers
  // refuse to start an AudioContext otherwise.
  start() {
    if (this.started) return;
    this.started = true;

    const ctx = new (window.AudioContext || window.webkitAudioContext)();
    this.ctx = ctx;

    this.master = ctx.createGain();
    this.master.gain.value = 0.8 * this.volumeScale;
    this.master.connect(ctx.destination);

    // Shared looping noise source material.
    this.noiseBuf = this.makeNoiseBuffer(4);

    // --- Wind: band-filtered noise, slowly breathing via two offset LFOs ---
    this.windGain = this.startLoop({
      filterType: 'bandpass',
      frequency: 480,
      q: 0.6,
      gain: 0.0,
    });
    this.addLfo(this.windGain.gain, 0.07, 0.045);
    this.addLfo(this.windGain.gain, 0.19, 0.02);

    // --- River: deep filtered rush, gain driven by proximity each frame ---
    const river = this.startLoop({
      filterType: 'lowpass',
      frequency: 320,
      q: 0.8,
      gain: 0.0,
    });
    this.riverGain = river;
    this.addLfo(river.filterNode.frequency, 0.31, 70);

    // --- Dread: two barely-audible detuned sines beating against each other ---
    const droneGain = ctx.createGain();
    droneGain.gain.value = 0.012;
    droneGain.connect(this.master);
    for (const f of [55, 55.7]) {
      const osc = ctx.createOscillator();
      osc.frequency.value = f;
      osc.connect(droneGain);
      osc.start();
    }

    this.windTarget = 0.09;
    this.riverTarget = 0;

    this.startMusic();
    this.startTracks();
    this.startWildlife();
    this.startHeartbeat();
  }

  // Crickets and a distant owl — the park still sounds alive, until it isn't.
  startWildlife() {
    const ctx = this.ctx;
    this.cricketGain = ctx.createGain();
    this.cricketGain.gain.value = 0.5;
    this.cricketGain.connect(this.master);

    const chirp = () => {
      const t = ctx.currentTime + 0.02;
      const pulses = 3 + Math.floor(Math.random() * 3);
      const f = 4100 + Math.random() * 600;
      for (let i = 0; i < pulses; i++) {
        const osc = ctx.createOscillator();
        osc.type = 'sine';
        osc.frequency.value = f;
        const g = ctx.createGain();
        const start = t + i * 0.045;
        g.gain.setValueAtTime(0, start);
        g.gain.linearRampToValueAtTime(0.018, start + 0.008);
        g.gain.linearRampToValueAtTime(0, start + 0.035);
        osc.connect(g).connect(this.cricketGain);
        osc.start(start);
        osc.stop(start + 0.05);
      }
      setTimeout(chirp, 350 + Math.random() * 1200);
    };
    chirp();

    const owl = () => {
      if (this.cricketGain.gain.value > 0.05) {
        const t = ctx.currentTime + 0.02;
        for (const [f0, delay, dur] of [[335, 0, 0.45], [300, 0.55, 0.7]]) {
          const osc = ctx.createOscillator();
          osc.type = 'sine';
          osc.frequency.setValueAtTime(f0, t + delay);
          osc.frequency.linearRampToValueAtTime(f0 - 18, t + delay + dur);
          const g = ctx.createGain();
          g.gain.setValueAtTime(0, t + delay);
          g.gain.linearRampToValueAtTime(0.05, t + delay + 0.12);
          g.gain.linearRampToValueAtTime(0, t + delay + dur);
          osc.connect(g).connect(this.master);
          osc.start(t + delay);
          osc.stop(t + delay + dur + 0.05);
        }
      }
      setTimeout(owl, 30000 + Math.random() * 45000);
    };
    setTimeout(owl, 15000);
  }

  // A lub-dub that rises with exhaustion and the chase. Level set per frame.
  startHeartbeat() {
    this.heartLevel = 0;
    const beat = () => {
      if (this.heartLevel > 0.03) {
        const g = 0.3 * this.heartLevel;
        this.knock({ freq: 58, freqEnd: 40, dur: 0.1, gain: g });
        this.knock({ freq: 52, freqEnd: 36, dur: 0.09, gain: g * 0.7, delay: 0.18 });
      }
      setTimeout(beat, 1000 - 350 * Math.min(1, this.heartLevel));
    };
    beat();
  }

  setHeartbeat(level) {
    this.heartLevel = Math.min(1, Math.max(0, level));
  }

  /** A shorter ragged screech used mid-chase. */
  creatureCry() {
    if (!this.started) return;
    const t = this.ctx.currentTime + 0.02;
    for (const det of [-14, 11]) {
      const osc = this.ctx.createOscillator();
      osc.type = 'sawtooth';
      osc.frequency.setValueAtTime(430 + det * 2, t);
      osc.frequency.exponentialRampToValueAtTime(130, t + 0.5);
      osc.detune.value = det;
      const g = this.ctx.createGain();
      g.gain.setValueAtTime(0, t);
      g.gain.linearRampToValueAtTime(0.09, t + 0.03);
      g.gain.exponentialRampToValueAtTime(0.001, t + 0.6);
      osc.connect(g).connect(this.master);
      osc.start(t);
      osc.stop(t + 0.7);
    }
  }

  // Real background music (Kevin MacLeod, CC-BY — credited in the README):
  // a dark ambient bed for exploring and a pounding track for the chase,
  // crossfaded by mode. The synth pads keep playing quietly underneath.
  startTracks() {
    const base = import.meta.env?.BASE_URL ?? '/';
    const mkTrack = (file, max) => {
      const el = new Audio(base + 'assets/' + file);
      el.loop = true;
      el.volume = 0;
      el.play().catch(() => {});
      return { el, target: 0, max };
    };
    this.tracks = {
      ambient: mkTrack('ambient.mp3', 0.5),
      chase: mkTrack('chase.mp3', 0.75),
    };
    this.tracks.ambient.target = this.tracks.ambient.max;
    setInterval(() => {
      for (const t of Object.values(this.tracks)) {
        const goal = t.target * this.volumeScale;
        const v = t.el.volume + (goal - t.el.volume) * 0.1;
        t.el.volume = Math.min(1, Math.max(0, v));
        // Keep paused-by-autoplay tracks retrying until they can start.
        if (t.el.paused && t.target > 0) t.el.play().catch(() => {});
      }
    }, 120);
  }

  // Generative score: slow chord pads crossfading into each other, with a
  // sparse bell note now and then. Three moods — the overworld's uneasy
  // minor wander, the basement's dissonant半-step clusters, and the
  // chase's pounding pulse. Synthesized like everything else.
  startMusic() {
    const ctx = this.ctx;
    this.musicMode = 'overworld';
    const out = ctx.createGain();
    out.gain.value = 0.12;
    this.musicOut = out;
    const filter = ctx.createBiquadFilter();
    filter.type = 'lowpass';
    filter.frequency.value = 750;
    this.musicFilter = filter;
    filter.connect(out);
    out.connect(this.master);

    // A natural-minor wander that never resolves.
    const OVERWORLD = [
      [55.0, 82.41, 110.0, 130.81], // Am
      [43.65, 65.41, 87.31, 130.81], // F
      [49.0, 73.42, 98.0, 123.47], // G
      [41.2, 61.74, 82.41, 123.47], // Em
    ];
    // Semitone clusters — wrongness as harmony.
    const UNDERGROUND = [
      [55.0, 58.27, 82.41, 87.31],
      [51.91, 55.0, 77.78, 82.41],
      [58.27, 61.74, 87.31, 92.5],
      [49.0, 51.91, 73.42, 77.78],
    ];
    const HOLD = 16;
    const STEP = 12;

    let idx = 0;
    const playChord = (freqs) => {
      const t = ctx.currentTime + 0.05;
      const drift = this.musicMode !== 'overworld';
      for (const f of freqs) {
        for (const detune of [-5, 4]) {
          const osc = ctx.createOscillator();
          osc.type = 'triangle';
          osc.frequency.value = f;
          osc.detune.value = detune;
          if (drift) {
            // Slow queasy pitch drift underground / during the chase.
            osc.detune.linearRampToValueAtTime(detune + (Math.random() - 0.5) * 45, t + HOLD);
          }
          const g = ctx.createGain();
          g.gain.setValueAtTime(0, t);
          g.gain.linearRampToValueAtTime(0.28, t + 4.5);
          g.gain.setValueAtTime(0.28, t + HOLD - 5);
          g.gain.linearRampToValueAtTime(0, t + HOLD);
          osc.connect(g).connect(filter);
          osc.start(t);
          osc.stop(t + HOLD + 0.2);
        }
      }
    };
    playChord(OVERWORLD[0]);
    setInterval(() => {
      idx = (idx + 1) % 4;
      playChord(this.musicMode === 'overworld' ? OVERWORLD[idx] : UNDERGROUND[idx]);
    }, STEP * 1000);

    // The bell: a quiet high note at irregular, long intervals.
    const NOTES = [220, 246.94, 261.63, 329.63, 392.0];
    const bell = () => {
      const t = ctx.currentTime + 0.05;
      const osc = ctx.createOscillator();
      osc.type = 'sine';
      // Underground the bell goes sour — a quarter-tone flat.
      const sour = this.musicMode === 'overworld' ? 1 : 0.972;
      osc.frequency.value = NOTES[Math.floor(Math.random() * NOTES.length)] * sour * (Math.random() < 0.35 ? 0.5 : 1);
      const g = ctx.createGain();
      g.gain.setValueAtTime(0, t);
      g.gain.linearRampToValueAtTime(0.5, t + 0.03);
      g.gain.exponentialRampToValueAtTime(0.001, t + 4.5);
      osc.connect(g).connect(filter);
      osc.start(t);
      osc.stop(t + 4.7);
      setTimeout(bell, 9000 + Math.random() * 14000);
    };
    setTimeout(bell, 7000);

    // Chase pulse: a heartbeat-turned-drum, started/stopped by mode.
    this.pulseTimer = null;
  }

  setMusicMode(mode) {
    if (!this.started || this.musicMode === mode) return;
    this.musicMode = mode;
    const t = this.ctx.currentTime;
    const settings = {
      overworld: { freq: 750, gain: 0.05 },
      underground: { freq: 420, gain: 0.13 },
      chase: { freq: 1800, gain: 0.1 },
    }[mode];
    this.musicFilter.frequency.setTargetAtTime(settings.freq, t, 1.5);
    this.musicOut.gain.setTargetAtTime(settings.gain, t, 1.5);

    // Crossfade the real tracks: ambient bed for exploring (ducked in the
    // basement so the dissonant pads own the space), full chase track when
    // the Not-Deer is on you.
    if (this.tracks) {
      this.tracks.ambient.target =
        mode === 'chase' ? 0 : mode === 'underground' ? 0.16 : this.tracks.ambient.max;
      this.tracks.chase.target = mode === 'chase' ? this.tracks.chase.max : 0;
    }

    if (mode === 'chase' && !this.pulseTimer) {
      const beat = () => {
        this.knock({ freq: 85, freqEnd: 40, dur: 0.12, gain: 0.45 });
        this.knock({ freq: 80, freqEnd: 38, dur: 0.1, gain: 0.3, delay: 0.2 });
        // Harsh noise on the off-beat for a chaotic feel
        this.burst({ dur: 0.08, type: 'bandpass', freq: 2200, q: 1.5, gain: 0.25, delay: 0.1 });
      };
      beat();
      this.pulseTimer = setInterval(beat, 400);
    } else if (mode !== 'chase' && this.pulseTimer) {
      clearInterval(this.pulseTimer);
      this.pulseTimer = null;
    }
  }

  /** Soft two-note chime + woody knock for picking up an effigy. */
  effigyPickup() {
    if (!this.started) return;
    const t = this.ctx.currentTime + 0.02;
    for (const [freq, delay] of [[523.25, 0], [659.25, 0.14]]) {
      const osc = this.ctx.createOscillator();
      osc.type = 'sine';
      osc.frequency.value = freq;
      const g = this.ctx.createGain();
      g.gain.setValueAtTime(0, t + delay);
      g.gain.linearRampToValueAtTime(0.22, t + delay + 0.02);
      g.gain.exponentialRampToValueAtTime(0.001, t + delay + 1.4);
      osc.connect(g).connect(this.master);
      osc.start(t + delay);
      osc.stop(t + delay + 1.5);
    }
    this.knock({ freq: 220, freqEnd: 90, dur: 0.1, gain: 0.12 });
  }

  /** Deep stone-grinding rumble for the tower door unsealing. */
  rumbleOpen() {
    if (!this.started) return;
    this.burst({ dur: 2.6, freq: 120, freqEnd: 60, gain: 0.4 });
    for (let i = 0; i < 5; i++) {
      this.knock({ freq: 55 + Math.random() * 20, freqEnd: 30, dur: 0.4, gain: 0.25, delay: i * 0.45 });
    }
  }

  // --- The Not-Deer's voice ---

  /** The moment it stands up: a tearing scream-dive. */
  creatureScream() {
    if (!this.started) return;
    const t = this.ctx.currentTime + 0.02;
    for (const det of [-18, 0, 23]) {
      const osc = this.ctx.createOscillator();
      osc.type = 'sawtooth';
      osc.frequency.setValueAtTime(640 + det * 3, t);
      osc.frequency.exponentialRampToValueAtTime(82, t + 1.3);
      osc.detune.value = det;
      const g = this.ctx.createGain();
      g.gain.setValueAtTime(0, t);
      g.gain.linearRampToValueAtTime(0.17, t + 0.04);
      g.gain.exponentialRampToValueAtTime(0.001, t + 1.5);
      osc.connect(g).connect(this.master);
      osc.start(t);
      osc.stop(t + 1.6);
    }
    this.burst({ dur: 1.1, type: 'highpass', freq: 1500, gain: 0.2 });
    this.burst({ dur: 0.5, freq: 250, gain: 0.3 });
  }

  /** Wrong clicking-chitter, volume scaled by proximity (0..1). */
  creatureNoise(proximity) {
    if (!this.started || proximity <= 0) return;
    const clicks = 5 + Math.floor(Math.random() * 5);
    for (let i = 0; i < clicks; i++) {
      this.burst({
        dur: 0.018,
        type: 'bandpass',
        freq: 1200 + Math.random() * 1300,
        q: 6,
        gain: 0.16 * proximity,
        delay: i * (0.028 + Math.random() * 0.02),
      });
    }
    this.knock({
      freq: 130 + Math.random() * 60,
      freqEnd: 55,
      dur: 0.3,
      gain: 0.1 * proximity,
      delay: clicks * 0.03 + 0.05,
    });
  }

  makeNoiseBuffer(seconds) {
    const rate = this.ctx.sampleRate;
    const buf = this.ctx.createBuffer(1, rate * seconds, rate);
    const data = buf.getChannelData(0);
    for (let i = 0; i < data.length; i++) data[i] = Math.random() * 2 - 1;
    return buf;
  }

  startLoop({ filterType, frequency, q, gain }) {
    const src = this.ctx.createBufferSource();
    src.buffer = this.noiseBuf;
    src.loop = true;
    const filter = this.ctx.createBiquadFilter();
    filter.type = filterType;
    filter.frequency.value = frequency;
    filter.Q.value = q;
    const g = this.ctx.createGain();
    g.gain.value = gain;
    src.connect(filter).connect(g).connect(this.master);
    src.start();
    g.filterNode = filter;
    return g;
  }

  addLfo(param, frequency, depth) {
    const osc = this.ctx.createOscillator();
    osc.frequency.value = frequency;
    const g = this.ctx.createGain();
    g.gain.value = depth;
    osc.connect(g).connect(param);
    osc.start();
  }

  /** windLevel/riverLevel are 0..1, smoothed here to avoid zipper noise. */
  setAmbience(windLevel, riverLevel) {
    if (!this.started) return;
    const t = this.ctx.currentTime;
    this.windGain.gain.setTargetAtTime(windLevel * 0.13, t, 0.8);
    this.riverGain.gain.setTargetAtTime(riverLevel * 0.3, t, 0.4);
    // Crickets live on the surface; underground (wind 0) they go silent.
    if (this.cricketGain) {
      this.cricketGain.gain.setTargetAtTime(windLevel > 0.01 ? 0.5 : 0, t, 1.2);
    }
  }

  // --- One-shot synthesis helpers ---

  burst({ dur = 0.1, type = 'lowpass', freq = 800, q = 1, gain = 0.2, delay = 0, freqEnd = null }) {
    const t = this.ctx.currentTime + delay;
    const src = this.ctx.createBufferSource();
    src.buffer = this.noiseBuf;
    // Random offset so consecutive steps never sound identical.
    const offset = Math.random() * (this.noiseBuf.duration - dur - 0.05);
    const filter = this.ctx.createBiquadFilter();
    filter.type = type;
    filter.frequency.setValueAtTime(freq, t);
    if (freqEnd) filter.frequency.exponentialRampToValueAtTime(freqEnd, t + dur);
    filter.Q.value = q;
    const g = this.ctx.createGain();
    g.gain.setValueAtTime(0, t);
    g.gain.linearRampToValueAtTime(gain, t + 0.008);
    g.gain.exponentialRampToValueAtTime(0.001, t + dur);
    src.connect(filter).connect(g).connect(this.master);
    src.start(t, offset, dur + 0.05);
  }

  knock({ freq = 120, freqEnd = 60, dur = 0.08, gain = 0.15, delay = 0 }) {
    const t = this.ctx.currentTime + delay;
    const osc = this.ctx.createOscillator();
    osc.type = 'triangle';
    osc.frequency.setValueAtTime(freq, t);
    osc.frequency.exponentialRampToValueAtTime(freqEnd, t + dur);
    const g = this.ctx.createGain();
    g.gain.setValueAtTime(0, t);
    g.gain.linearRampToValueAtTime(gain, t + 0.005);
    g.gain.exponentialRampToValueAtTime(0.001, t + dur);
    osc.connect(g).connect(this.master);
    osc.start(t);
    osc.stop(t + dur + 0.02);
  }

  footstep(surface, sprinting) {
    if (!this.started) return;
    const v = sprinting ? 1.35 : 1.0;
    switch (surface) {
      case 'grass':
        this.burst({ dur: 0.11, freq: 750 + Math.random() * 350, gain: 0.16 * v });
        break;
      case 'dirt':
        this.burst({ dur: 0.13, freq: 520 + Math.random() * 180, gain: 0.2 * v });
        this.knock({ freq: 95, freqEnd: 55, dur: 0.07, gain: 0.07 * v });
        break;
      case 'asphalt':
        this.burst({ dur: 0.06, type: 'bandpass', freq: 1700 + Math.random() * 500, q: 1.2, gain: 0.12 * v });
        this.knock({ freq: 150, freqEnd: 80, dur: 0.05, gain: 0.06 * v });
        break;
      case 'wetstone':
        this.knock({ freq: 230 + Math.random() * 50, freqEnd: 110, dur: 0.09, gain: 0.14 * v });
        this.burst({ dur: 0.05, type: 'bandpass', freq: 2600, q: 2, gain: 0.07 * v });
        this.burst({ dur: 0.16, freq: 420, gain: 0.06 * v, delay: 0.02 });
        break;
      case 'riverrock': {
        // Three staggered micro-bursts read as rocks shifting underfoot.
        for (let i = 0; i < 3; i++) {
          this.burst({
            dur: 0.04,
            type: 'bandpass',
            freq: 1100 + Math.random() * 1400,
            q: 1.5,
            gain: (0.1 - i * 0.02) * v,
            delay: i * 0.035 + Math.random() * 0.015,
          });
        }
        this.knock({ freq: 110, freqEnd: 70, dur: 0.06, gain: 0.05 * v });
        break;
      }
      case 'water':
        this.burst({ dur: 0.28, freq: 460, freqEnd: 900, gain: 0.22 * v });
        this.burst({ dur: 0.1, type: 'highpass', freq: 2400, gain: 0.05 * v, delay: 0.04 });
        break;
      default:
        this.burst({ dur: 0.1, freq: 800, gain: 0.14 * v });
    }
  }

  land(surface) {
    if (!this.started) return;
    this.knock({ freq: 85, freqEnd: 45, dur: 0.12, gain: 0.22 });
    this.footstep(surface, true);
  }

  gameOver() {
    if (!this.started) return;
    // Massive low thud + noise burst
    this.knock({ freq: 150, freqEnd: 20, dur: 1.5, gain: 0.6 });
    this.burst({ dur: 0.8, type: 'lowpass', freq: 400, gain: 0.8 });
    this.setMusicMode('overworld');
  }
}
