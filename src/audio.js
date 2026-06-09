// All audio is synthesized with the Web Audio API — no sound files, in the
// same spirit as the procedural textures and geometry.

export class GameAudio {
  constructor() {
    this.ctx = null;
    this.started = false;
  }

  // Must be called from a user gesture (pointer lock click) — browsers
  // refuse to start an AudioContext otherwise.
  start() {
    if (this.started) return;
    this.started = true;

    const ctx = new (window.AudioContext || window.webkitAudioContext)();
    this.ctx = ctx;

    this.master = ctx.createGain();
    this.master.gain.value = 0.8;
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
}
