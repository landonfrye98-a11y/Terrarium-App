// Optional generative ambience. Off by default. A low breathing drone, sparse
// kalimba-like notes when creatures do things, and a chime when a task blooms.
// Everything runs on WebAudio nodes (no samples); the context is suspended
// whenever the app is hidden or sound is off so it costs nothing idle.

const SCALE = [0, 3, 5, 7, 10, 12, 15, 17, 19, 22]; // minor pentatonic, two octaves

export class Soundscape {
  constructor() {
    this.ctx = null;
    this.on = false;
    this.volume = 0.6;
    this.nextNote = 0;
    this.root = 146.83; // D3
  }

  ensure() {
    if (this.ctx) return;
    const AC = window.AudioContext || window.webkitAudioContext;
    if (!AC) return;
    const ctx = (this.ctx = new AC({ latencyHint: 'playback' }));
    this.master = ctx.createGain();
    this.master.gain.value = 0;
    this.master.connect(ctx.destination);
    // a soft feedback delay gives the notes room to breathe
    this.delay = ctx.createDelay(1.5);
    this.delay.delayTime.value = 0.42;
    this.fb = ctx.createGain();
    this.fb.gain.value = 0.35;
    const damp = ctx.createBiquadFilter();
    damp.type = 'lowpass';
    damp.frequency.value = 1800;
    this.delay.connect(damp); damp.connect(this.fb); this.fb.connect(this.delay);
    damp.connect(this.master);
    this.fx = ctx.createGain();
    this.fx.gain.value = 0.5;
    this.fx.connect(this.delay);
    this.fx.connect(this.master);
    // drone: two detuned voices through a slowly breathing filter
    this.droneFilter = ctx.createBiquadFilter();
    this.droneFilter.type = 'lowpass';
    this.droneFilter.frequency.value = 320;
    this.droneFilter.Q.value = 3;
    this.droneGain = ctx.createGain();
    this.droneGain.gain.value = 0.05;
    this.droneFilter.connect(this.droneGain);
    this.droneGain.connect(this.master);
    this.voices = [];
    for (const [f, type] of [[this.root / 2, 'sine'], [this.root / 2 * 1.5, 'triangle'], [this.root * 1.003, 'sine']]) {
      const o = ctx.createOscillator();
      o.type = type; o.frequency.value = f;
      const g = ctx.createGain(); g.gain.value = type === 'triangle' ? 0.35 : 0.6;
      o.connect(g); g.connect(this.droneFilter); o.start();
      this.voices.push(o);
    }
    const lfo = ctx.createOscillator();
    lfo.frequency.value = 0.05;
    const lg = ctx.createGain(); lg.gain.value = 160;
    lfo.connect(lg); lg.connect(this.droneFilter.frequency); lfo.start();
  }

  async setOn(on) {
    this.on = on;
    if (on) {
      this.ensure();
      if (!this.ctx) return;
      await this.ctx.resume();
      this.master.gain.setTargetAtTime(this.volume * 0.5, this.ctx.currentTime, 1.5);
    } else if (this.ctx) {
      this.master.gain.setTargetAtTime(0, this.ctx.currentTime, 0.3);
      setTimeout(() => { if (!this.on) this.ctx.suspend(); }, 1200);
    }
  }

  setVolume(v) {
    this.volume = v;
    if (this.ctx && this.on) this.master.gain.setTargetAtTime(v * 0.5, this.ctx.currentTime, 0.2);
  }

  suspend() { if (this.ctx && this.ctx.state === 'running') this.ctx.suspend(); }
  resume() { if (this.ctx && this.on) this.ctx.resume(); }

  note(step, { dur = 2.4, gain = 0.12, type = 'sine', when = 0, octave = 1 } = {}) {
    if (!this.on || !this.ctx || this.ctx.state !== 'running') return;
    const ctx = this.ctx, t = ctx.currentTime + when;
    const f = this.root * octave * Math.pow(2, SCALE[step % SCALE.length] / 12);
    const o = ctx.createOscillator();
    o.type = type; o.frequency.value = f;
    const o2 = ctx.createOscillator();
    o2.type = 'sine'; o2.frequency.value = f * 4.01; // bell-ish partial
    const g = ctx.createGain();
    g.gain.setValueAtTime(0, t);
    g.gain.linearRampToValueAtTime(gain, t + 0.008);
    g.gain.exponentialRampToValueAtTime(0.0001, t + dur);
    const g2 = ctx.createGain();
    g2.gain.setValueAtTime(gain * 0.25, t);
    g2.gain.exponentialRampToValueAtTime(0.0001, t + dur * 0.3);
    o.connect(g); o2.connect(g2); g.connect(this.fx); g2.connect(this.fx);
    o.start(t); o2.start(t);
    o.stop(t + dur + 0.1); o2.stop(t + dur + 0.1);
  }

  // called about once a second from the main loop
  tick(world) {
    if (!this.on || !this.ctx) return;
    const night = world.night;
    this.droneGain.gain.setTargetAtTime(0.035 + night * 0.03, this.ctx.currentTime, 4);
    if (world.t > this.nextNote) {
      this.nextNote = world.t + 5 + Math.random() * (night > 0.5 ? 14 : 9);
      const s = Math.floor(Math.random() * 7);
      this.note(s, { gain: 0.05 + Math.random() * 0.04, octave: night > 0.5 ? 1 : 2 });
      if (Math.random() < 0.3) this.note(s + 2, { gain: 0.035, when: 0.35, octave: 2 });
    }
  }

  chime() {
    [0, 2, 4, 5, 7].forEach((s, i) => this.note(s, { when: i * 0.11, gain: 0.09, octave: 2, dur: 3 }));
  }
  plant() { this.note(0, { gain: 0.12, octave: 0.5, dur: 1.2, type: 'triangle' }); }
  pulse() { [0, 3, 7].forEach((s, i) => this.note(s, { when: i * 0.5, gain: 0.05, octave: 1, dur: 5 })); }
  birth() { this.note(5 + Math.floor(Math.random() * 3), { gain: 0.05, octave: 2 }); }
}
