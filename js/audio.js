// Встроенный «пианино»-синтезатор на Web Audio API.
// Нужен, чтобы звучали аккомпанемент, «волшебный» режим и игра мышкой/клавиатурой ноутбука.
'use strict';

class PianoSynth {
  constructor() {
    this.ctx = null;
    this.voices = new Map();
    this.volume = 0.8;
  }

  ensure() {
    if (!this.ctx) {
      const Ctx = window.AudioContext || window.webkitAudioContext;
      if (!Ctx) return false;
      this.ctx = new Ctx();
      this.master = this.ctx.createGain();
      this.master.gain.value = this.volume;
      const comp = this.ctx.createDynamicsCompressor();
      comp.threshold.value = -14;
      comp.ratio.value = 4;
      this.master.connect(comp);
      comp.connect(this.ctx.destination);

      // Спектр, похожий на струну: много гармоник, быстро затухающих по высоте.
      const n = 16;
      const real = new Float32Array(n);
      const imag = new Float32Array(n);
      for (let i = 1; i < n; i++) imag[i] = Math.pow(0.62, i - 1) * (i % 2 ? 1 : 0.7);
      this.wave = this.ctx.createPeriodicWave(real, imag);
    }
    if (this.ctx.state === 'suspended') this.ctx.resume();
    return true;
  }

  setVolume(v) {
    this.volume = v;
    if (this.master) this.master.gain.value = v;
  }

  noteOn(midi, velocity = 0.8, key = 'n' + midi) {
    if (!this.ensure()) return;
    this.noteOff(key, 0.03);
    const ctx = this.ctx;
    const t = ctx.currentTime;
    const f = 440 * Math.pow(2, (midi - 69) / 12);
    const vel = Math.max(0.05, Math.min(1, velocity));
    const peak = 0.22 * vel;

    const out = ctx.createGain();
    out.gain.setValueAtTime(0, t);
    out.gain.linearRampToValueAtTime(peak, t + 0.006);
    // Низкие ноты звучат дольше, высокие — короче, как у фортепиано.
    const tau = Math.max(0.35, 2.4 - (midi - 36) * 0.03);
    out.gain.setTargetAtTime(peak * 0.35, t + 0.01, 0.12);
    out.gain.setTargetAtTime(0, t + 0.25, tau);

    const filter = ctx.createBiquadFilter();
    filter.type = 'lowpass';
    filter.Q.value = 0.7;
    filter.frequency.setValueAtTime(Math.min(16000, f * (6 + vel * 10)), t);
    filter.frequency.setTargetAtTime(Math.min(12000, f * 2.5), t + 0.02, 0.4);

    const osc1 = ctx.createOscillator();
    osc1.setPeriodicWave(this.wave);
    osc1.frequency.value = f;
    const osc2 = ctx.createOscillator();
    osc2.setPeriodicWave(this.wave);
    osc2.frequency.value = f;
    osc2.detune.value = 6;
    const g2 = ctx.createGain();
    g2.gain.value = 0.5;

    osc1.connect(filter);
    osc2.connect(g2).connect(filter);
    filter.connect(out).connect(this.master);
    osc1.start(t);
    osc2.start(t);
    const stopAt = t + tau * 6 + 0.5;
    osc1.stop(stopAt);
    osc2.stop(stopAt);

    const voice = { out, oscs: [osc1, osc2] };
    osc1.onended = () => { if (this.voices.get(key) === voice) this.voices.delete(key); out.disconnect(); };
    this.voices.set(key, voice);
  }

  noteOff(key, release = 0.12) {
    const v = this.voices.get(key);
    if (!v || !this.ctx) return;
    this.voices.delete(key);
    const t = this.ctx.currentTime;
    v.out.gain.cancelScheduledValues(t);
    v.out.gain.setTargetAtTime(0, t, release / 3);
    for (const o of v.oscs) { try { o.stop(t + release * 3); } catch (e) { /* уже остановлен */ } }
  }

  allOff() {
    for (const key of [...this.voices.keys()]) this.noteOff(key, 0.05);
  }
}

window.PianoSynth = PianoSynth;
