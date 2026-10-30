// Маэстро — основная логика: режимы обучения, подключение синтезатора, отрисовка.
(() => {
  'use strict';

  const $ = (s) => document.querySelector(s);
  const NAMES = {
    ru: ['До', 'До♯', 'Ре', 'Ре♯', 'Ми', 'Фа', 'Фа♯', 'Соль', 'Соль♯', 'Ля', 'Ля♯', 'Си'],
    en: ['C', 'C♯', 'D', 'D♯', 'E', 'F', 'F♯', 'G', 'G♯', 'A', 'A♯', 'B'],
  };
  const HAND = {
    R: { main: '#34d399', dark: '#047857', glow: 'rgba(52,211,153,' },
    L: { main: '#60a5fa', dark: '#1d4ed8', glow: 'rgba(96,165,250,' },
  };
  const isBlack = (m) => [1, 3, 6, 8, 10].includes(m % 12);
  const noteName = (m) => (settings.labels === 'none' ? '' : NAMES[settings.labels][m % 12]);
  const LOOKAHEAD = 2.6;   // сколько секунд видно падающих нот
  const LEAD_IN = 2;       // секунд до первой ноты после старта
  const RANGES = { 49: [36, 84], 61: [36, 96], 76: [28, 103], 88: [21, 108] };
  // Клавиши ноутбука (по физическому положению — работает и в русской раскладке).
  const KBD = { KeyA: 0, KeyW: 1, KeyS: 2, KeyE: 3, KeyD: 4, KeyF: 5, KeyT: 6, KeyG: 7, KeyY: 8, KeyH: 9, KeyU: 10, KeyJ: 11, KeyK: 12, KeyO: 13, KeyL: 14, KeyP: 15, Semicolon: 16, Quote: 17 };
  const KBD_LABEL = { KeyA: 'A', KeyW: 'W', KeyS: 'S', KeyE: 'E', KeyD: 'D', KeyF: 'F', KeyT: 'T', KeyG: 'G', KeyY: 'Y', KeyH: 'H', KeyU: 'U', KeyJ: 'J', KeyK: 'K', KeyO: 'O', KeyL: 'L', KeyP: 'P', Semicolon: ';', Quote: "'" };

  // ---------- Хранилище ----------
  const store = {
    get(key, def) { try { const v = localStorage.getItem(key); return v ? JSON.parse(v) : def; } catch (e) { return def; } },
    set(key, val) { try { localStorage.setItem(key, JSON.stringify(val)); return true; } catch (e) { return false; } },
  };

  const settings = Object.assign({
    mode: 'magic', hands: 'both', speed: 1, labels: 'ru', range: 'auto', volume: 0.8,
    midiIn: 'all', midiOut: 'none', echo: false, kbdHints: true, octave: 4,
  }, store.get('maestro.settings', {}));
  const saveSettings = () => store.set('maestro.settings', settings);
  const progress = store.get('maestro.stars', {});

  const synth = new PianoSynth();
  synth.setVolume(settings.volume);

  // ---------- Состояние ----------
  const S = {
    song: null,
    notes: [],
    groups: [],
    groupIdx: 0,
    time: 0,
    end: 0,
    playing: false,
    waiting: false,
    finished: false,
    autoActive: [],
    pressed: new Map(),       // midi -> { state: 'good'|'bad'|'neutral', hand }
    magicHeld: new Map(),     // нажатая клавиша -> сыгранные ноты
    magicTarget: 0,
    stats: { hits: 0, wrong: 0, misses: 0, streak: 0, best: 0, total: 0 },
    trails: [],
    particles: [],
    flash: new Map(),         // midi -> время подсветки ошибки
  };
  let userSongs = [];

  const handOn = (h) => settings.hands === 'both' || (settings.hands === 'right' ? h === 'R' : h === 'L');

  function groupNotes(list) {
    const groups = [];
    for (const n of list) {
      const g = groups[groups.length - 1];
      if (g && Math.abs(n.start - g.start) < 0.04) g.notes.push(n);
      else groups.push({ start: n.start, notes: [n] });
    }
    return groups;
  }

  function prepare() {
    stopSounds();
    const mode = settings.mode;
    const src = S.song ? S.song.notes : [];
    S.notes = src.map((n, i) => ({ ...n, i, hit: false, missed: false, played: false, required: (mode === 'wait' || mode === 'play') && handOn(n.hand) }));
    S.end = S.notes.reduce((e, n) => Math.max(e, n.start + n.dur), 0);
    const active = mode === 'magic' ? S.notes.filter((n) => handOn(n.hand)) : S.notes.filter((n) => n.required);
    S.groups = groupNotes(active);
    S.groupIdx = 0;
    S.stats = { hits: 0, wrong: 0, misses: 0, streak: 0, best: 0, total: active.length };
    S.playing = false;
    S.waiting = false;
    S.finished = false;
    S.autoActive = [];
    S.magicHeld.clear();
    S.time = mode === 'magic' ? (S.groups[0] ? S.groups[0].start : 0) : -LEAD_IN * settings.speed;
    S.magicTarget = S.time;
    computeRange();
    updateHud();
    updateButtons();
    if (mode === 'free') showBanner('Играй что хочешь!', 'Свободная игра', 2000);
    else if (!S.song) showBanner('Выбери песню слева', '', 0);
    else if (S.song && !active.length) showBanner('Для этой руки здесь нет нот', 'Выбери другую руку', 2500);
    else if (mode === 'magic') showBanner('Нажимай любую клавишу!', 'Мелодия будет играть сама', 2500);
    else showBanner('Нажми «Играть» или пробел', mode === 'wait' ? 'Ноты будут ждать тебя' : 'Играй в темпе', 0);
  }

  function stopSounds() {
    synth.allOff();
    for (const n of S.autoActive) midi.send(0x80, n.midi, 0);
    for (const notes of S.magicHeld.values()) for (const n of notes) midi.send(0x80, n.midi, 0);
    S.autoActive = [];
  }

  // ---------- Управление воспроизведением ----------
  function play() {
    if (!S.song || settings.mode === 'free' || settings.mode === 'magic') return;
    synth.ensure();
    if (S.finished) prepare();
    S.playing = true;
    hideBanner();
    updateButtons();
  }

  function pause() {
    S.playing = false;
    for (const n of S.autoActive) { synth.noteOff('a' + n.i); midi.send(0x80, n.midi, 0); }
    S.autoActive = [];
    updateButtons();
  }

  function togglePlay() { S.playing ? pause() : play(); }

  function finish() {
    if (S.finished) return;
    S.finished = true;
    S.finishedAt = performance.now();
    S.playing = false;
    updateButtons();
    const st = S.stats;
    let acc;
    if (settings.mode === 'wait') acc = st.hits ? st.hits / (st.hits + st.wrong) : 0;
    else if (settings.mode === 'play') acc = st.total ? st.hits / st.total : 0;
    else acc = 1;
    const stars = acc >= 0.95 ? 3 : acc >= 0.8 ? 2 : acc >= 0.5 ? 1 : 0;
    if (S.song && stars > (progress[S.song.id] || 0)) {
      progress[S.song.id] = stars;
      store.set('maestro.stars', progress);
      renderLibrary();
    }
    $('#resStars').innerHTML = '★'.repeat(stars) + '<span class="off">' + '★'.repeat(3 - stars) + '</span>';
    $('#resTitle').textContent = ['Попробуй ещё раз!', 'Неплохо!', 'Здорово!', 'Великолепно!'][stars];
    $('#resText').textContent = settings.mode === 'magic'
      ? `Ты сыграл «${S.song.title}»! Теперь попробуй режим «Учусь».`
      : `Точность ${Math.round(acc * 100)}% · верных нот ${st.hits} · ошибок ${st.wrong + st.misses} · лучшая серия ${st.best}`;
    setTimeout(() => { if (S.finished && !$('#resultDlg').open) $('#resultDlg').showModal(); }, 700);
  }

  // ---------- Игровой цикл ----------
  function update(dt) {
    const mode = settings.mode;
    if (mode === 'magic') {
      S.time += (S.magicTarget - S.time) * Math.min(1, dt * 10);
      return;
    }
    if (mode === 'free' || !S.playing) return;

    let t = S.time + dt * settings.speed;
    const g = S.groups[S.groupIdx];
    if (mode === 'wait' && g && t >= g.start) {
      t = g.start;
      if (!S.waiting) { S.waiting = true; updateHud(); }
    }
    S.time = t;

    for (const n of S.notes) {
      if (n.start > t) break;
      if (!n.required && !n.played) {
        n.played = true;
        if (t - n.start < 0.25) {
          synth.noteOn(n.midi, n.vel * 0.85, 'a' + n.i);
          midi.send(0x90, n.midi, Math.round(n.vel * 100));
          S.autoActive.push(n);
        }
      }
    }
    S.autoActive = S.autoActive.filter((n) => {
      if (t >= n.start + n.dur) { synth.noteOff('a' + n.i); midi.send(0x80, n.midi, 0); return false; }
      return true;
    });

    if (mode === 'play') {
      const win = 0.22 * settings.speed;
      let changed = false;
      for (const n of S.notes) {
        if (n.start > t) break;
        if (n.required && !n.hit && !n.missed && t > n.start + win) {
          n.missed = true;
          S.stats.misses++;
          S.stats.streak = 0;
          changed = true;
        }
      }
      if (changed) updateHud();
    }

    if (t > S.end + 0.6) finish();
  }

  // ---------- Нажатия клавиш ----------
  function noteOn(m, vel, src) {
    synth.ensure();
    if (S.pressed.has(m)) noteOff(m, src);
    const mode = settings.mode;
    const entry = { state: 'neutral', hand: null };
    S.pressed.set(m, entry);
    const localSound = src !== 'midi' || settings.echo;

    if (mode === 'magic') {
      magicPress(m, vel);
      return;
    }
    if (localSound) synth.noteOn(m, vel, 'u' + m);
    if (mode === 'free') {
      S.trails.push({ midi: m, t0: performance.now(), t1: null });
      return;
    }
    if (!S.song) return;
    if (mode === 'wait' && !S.playing && !S.finished) play();

    if (mode === 'wait') {
      const g = S.groups[S.groupIdx];
      if (!g || (!S.waiting && g.start - S.time > 0.4 * settings.speed)) return;
      const n = g.notes.find((x) => !x.hit && x.midi === m);
      if (n) {
        registerHit(n, entry);
        if (g.notes.every((x) => x.hit)) { S.groupIdx++; S.waiting = false; }
      } else if (!g.notes.some((x) => x.midi === m)) {
        registerWrong(m, entry);
      }
    } else if (mode === 'play' && S.playing) {
      const win = 0.22 * settings.speed;
      let best = null;
      for (const n of S.notes) {
        if (n.start > S.time + win) break;
        if (n.required && !n.hit && !n.missed && n.midi === m && Math.abs(n.start - S.time) <= win) {
          if (!best || Math.abs(n.start - S.time) < Math.abs(best.start - S.time)) best = n;
        }
      }
      if (best) registerHit(best, entry); else registerWrong(m, entry);
    }
    updateHud();
  }

  function noteOff(m) {
    const entry = S.pressed.get(m);
    if (!entry) return;
    S.pressed.delete(m);
    synth.noteOff('u' + m);
    const held = S.magicHeld.get(m);
    if (held) {
      S.magicHeld.delete(m);
      for (const n of held) { synth.noteOff('m' + n.i); midi.send(0x80, n.midi, 0); }
    }
    const tr = S.trails.find((x) => x.midi === m && x.t1 === null);
    if (tr) tr.t1 = performance.now();
  }

  function registerHit(n, entry) {
    n.hit = true;
    entry.state = 'good';
    entry.hand = n.hand;
    S.stats.hits++;
    S.stats.streak++;
    S.stats.best = Math.max(S.stats.best, S.stats.streak);
    spawnParticles(n.midi, HAND[n.hand].main);
    if (S.stats.streak > 0 && S.stats.streak % 10 === 0) showBanner(`🔥 ${S.stats.streak} подряд!`, '', 1000);
  }

  function registerWrong(m, entry) {
    entry.state = 'bad';
    S.stats.wrong++;
    S.stats.streak = 0;
    S.flash.set(m, performance.now());
  }

  function magicPress(m, vel) {
    if (!S.song || $('#resultDlg').open) return;
    if (S.finished) {
      if (performance.now() - S.finishedAt < 1500) return;
      prepare();
    }
    const g = S.groups[S.groupIdx];
    if (!g) return;
    S.groupIdx++;
    hideBanner();
    const v = Math.max(0.35, vel);
    for (const n of g.notes) {
      n.hit = true;
      synth.noteOn(n.midi, v * (n.hand === 'R' ? 1 : 0.75), 'm' + n.i);
      midi.send(0x90, n.midi, Math.round(v * 110));
      spawnParticles(n.midi, HAND[n.hand].main);
    }
    S.stats.hits += g.notes.length;
    S.magicHeld.set(m, g.notes);
    const next = S.groups[S.groupIdx];
    S.magicTarget = next ? next.start : S.end;
    updateHud();
    if (!next) finish();
  }

  // ---------- Подключение синтезатора (Web MIDI) ----------
  const midi = {
    access: null,
    inputs: [],
    outputs: [],
    out: null,
    async init() {
      if (!navigator.requestMIDIAccess) {
        setMidiStatus('warn', '⚠️ Браузер не видит MIDI — откройте в Chrome или Edge');
        return;
      }
      try {
        this.access = await navigator.requestMIDIAccess({ sysex: false });
        this.access.onstatechange = () => this.refresh();
        this.refresh();
      } catch (e) {
        setMidiStatus('warn', '⚠️ Доступ к MIDI запрещён — разрешите в настройках сайта');
      }
    },
    refresh() {
      if (!this.access) return;
      this.inputs = [...this.access.inputs.values()].filter((i) => i.state !== 'disconnected');
      this.outputs = [...this.access.outputs.values()].filter((o) => o.state !== 'disconnected');
      for (const inp of this.access.inputs.values()) {
        inp.onmidimessage = (settings.midiIn === 'all' || settings.midiIn === inp.id) ? onMidiMessage : null;
      }
      this.out = this.outputs.find((o) => o.id === settings.midiOut) || null;
      const used = this.inputs.filter((i) => settings.midiIn === 'all' || settings.midiIn === i.id);
      if (used.length) setMidiStatus('ok', '🎹 ' + used.map((i) => i.name).join(', '));
      else setMidiStatus('', '🎹 Синтезатор не подключён');
      fillMidiSelects();
    },
    send(status, note, vel) {
      if (!this.out) return;
      try { this.out.send([status, note, vel]); } catch (e) { /* устройство отключено */ }
    },
  };

  function onMidiMessage(e) {
    const [st, a, b] = e.data;
    const type = st & 0xf0;
    if (type === 0x90 && b > 0) noteOn(a, b / 127, 'midi');
    else if (type === 0x80 || (type === 0x90 && b === 0)) noteOff(a);
  }

  function setMidiStatus(cls, text) {
    const el = $('#midiStatus');
    el.className = 'pill ' + cls;
    el.textContent = text;
  }

  function fillMidiSelects() {
    const selIn = $('#selIn'), selOut = $('#selOut');
    selIn.innerHTML = '<option value="all">Все подключённые</option>' +
      midi.inputs.map((i) => `<option value="${i.id}">${escapeHtml(i.name)}</option>`).join('');
    selIn.value = midi.inputs.some((i) => i.id === settings.midiIn) ? settings.midiIn : 'all';
    selOut.innerHTML = '<option value="none">Не отправлять</option>' +
      midi.outputs.map((o) => `<option value="${o.id}">${escapeHtml(o.name)}</option>`).join('');
    selOut.value = midi.outputs.some((o) => o.id === settings.midiOut) ? settings.midiOut : 'none';
  }

  const escapeHtml = (s) => String(s).replace(/[&<>"]/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[c]));

  // ---------- Клавиатура ноутбука ----------
  const kbdDown = new Map();
  window.addEventListener('keydown', (e) => {
    if (e.target.closest && e.target.closest('dialog, select, input')) return;
    if (e.code === 'Space') { e.preventDefault(); togglePlay(); return; }
    if (e.code === 'KeyR' && !e.repeat && !(e.code in KBD)) { prepare(); return; }
    if (e.code === 'KeyZ') { settings.octave = Math.max(1, settings.octave - 1); saveSettings(); return; }
    if (e.code === 'KeyX') { settings.octave = Math.min(7, settings.octave + 1); saveSettings(); return; }
    if (!(e.code in KBD) || e.repeat || e.ctrlKey || e.metaKey || e.altKey) return;
    e.preventDefault();
    const m = 12 * (settings.octave + 1) + KBD[e.code];
    kbdDown.set(e.code, m);
    noteOn(m, 0.8, 'kbd');
  });
  window.addEventListener('keyup', (e) => {
    const m = kbdDown.get(e.code);
    if (m === undefined) return;
    kbdDown.delete(e.code);
    noteOff(m);
  });
  window.addEventListener('blur', () => { for (const m of kbdDown.values()) noteOff(m); kbdDown.clear(); });

  // ---------- Отрисовка ----------
  const canvas = $('#canvas');
  const ctx = canvas.getContext('2d');
  let W = 0, H = 0, DPR = 1;
  let range = [48, 83];
  let layout = { keys: new Map(), whiteW: 0, keyH: 0, hitY: 0 };

  function computeRange() {
    if (settings.range !== 'auto' || settings.mode === 'free') {
      range = RANGES[settings.range === 'auto' ? 61 : settings.range].slice();
    } else {
      let lo = 60, hi = 83;
      if (S.notes.length) {
        lo = Math.min(...S.notes.map((n) => n.midi));
        hi = Math.max(...S.notes.map((n) => n.midi));
      }
      lo = lo - (lo % 12);            // до ближайшей «До» снизу
      hi = hi + (11 - (hi % 12));     // до ближайшей «Си» сверху
      while (hi - lo < 23) { if (lo > 36) lo -= 12; else hi += 12; }
      range = [Math.max(21, lo), Math.min(108, hi)];
    }
    computeLayout();
  }

  function computeLayout() {
    const [lo, hi] = range;
    const whites = [];
    for (let m = lo; m <= hi; m++) if (!isBlack(m)) whites.push(m);
    const whiteW = W / whites.length;
    const keyH = Math.min(Math.max(90, H * 0.26), whiteW * 6.5, 200);
    const keys = new Map();
    let wi = 0;
    for (let m = lo; m <= hi; m++) {
      if (!isBlack(m)) { keys.set(m, { x: wi * whiteW, w: whiteW, black: false }); wi++; }
      else { const bw = whiteW * 0.6; keys.set(m, { x: wi * whiteW - bw / 2, w: bw, black: true }); }
    }
    layout = { keys, whiteW, keyH, hitY: H - keyH };
  }

  function resize() {
    const r = canvas.getBoundingClientRect();
    DPR = window.devicePixelRatio || 1;
    W = r.width;
    H = r.height;
    canvas.width = Math.round(W * DPR);
    canvas.height = Math.round(H * DPR);
    ctx.setTransform(DPR, 0, 0, DPR, 0, 0);
    computeLayout();
  }
  new ResizeObserver(resize).observe($('#stage'));

  function roundRect(x, y, w, h, r) {
    r = Math.max(0, Math.min(r, w / 2, h / 2));
    ctx.beginPath();
    ctx.moveTo(x + r, y);
    ctx.arcTo(x + w, y, x + w, y + h, r);
    ctx.arcTo(x + w, y + h, x, y + h, r);
    ctx.arcTo(x, y + h, x, y, r);
    ctx.arcTo(x, y, x + w, y, r);
    ctx.closePath();
  }

  function spawnParticles(m, color) {
    const k = layout.keys.get(m);
    if (!k) return;
    for (let i = 0; i < 14; i++) {
      const a = -Math.PI / 2 + (Math.random() - 0.5) * 2.2;
      const sp = 120 + Math.random() * 260;
      S.particles.push({ x: k.x + k.w / 2, y: layout.hitY, vx: Math.cos(a) * sp, vy: Math.sin(a) * sp, life: 0.7 + Math.random() * 0.4, age: 0, color });
    }
  }

  function currentHints() {
    const hints = new Map();
    const mode = settings.mode;
    if (mode === 'wait' || mode === 'magic') {
      const g = S.groups[S.groupIdx];
      if (g && (mode === 'magic' || S.waiting || g.start - S.time < 0.6 * settings.speed)) {
        for (const n of g.notes) if (!n.hit) hints.set(n.midi, n.hand);
      }
    }
    return hints;
  }

  function draw(now, dt) {
    const { keys, keyH, hitY } = layout;
    const [lo, hi] = range;

    // фон
    const bg = ctx.createLinearGradient(0, 0, 0, hitY);
    bg.addColorStop(0, '#0b0c22');
    bg.addColorStop(1, '#1a1c45');
    ctx.fillStyle = bg;
    ctx.fillRect(0, 0, W, H);

    // направляющие линии на каждой «До» и «Фа»
    for (let m = lo; m <= hi; m++) {
      if (m % 12 === 0 || m % 12 === 5) {
        const k = keys.get(m);
        ctx.fillStyle = m % 12 === 0 ? 'rgba(255,255,255,0.09)' : 'rgba(255,255,255,0.04)';
        ctx.fillRect(Math.round(k.x), 0, 1, hitY);
      }
    }

    const hints = currentHints();
    // подсветка дорожек, где нужно нажать
    for (const [m, hand] of hints) {
      const k = keys.get(m);
      if (!k) continue;
      const pulse = 0.08 + 0.06 * Math.sin(now / 160);
      ctx.fillStyle = HAND[hand].glow + pulse + ')';
      ctx.fillRect(k.x, 0, k.w, hitY);
    }

    // падающие ноты
    if (settings.mode !== 'free') {
      const pps = (hitY - 10) / (LOOKAHEAD * settings.speed);
      ctx.font = '600 12px Nunito, system-ui, sans-serif';
      ctx.textAlign = 'center';
      ctx.textBaseline = 'bottom';
      for (const n of S.notes) {
        const yBottom = hitY - (n.start - S.time) * pps;
        if (yBottom < -5) break;
        const yTop = yBottom - n.dur * pps;
        if (yTop > hitY) continue;
        const k = keys.get(n.midi);
        if (!k) continue;
        const pad = k.black ? 1 : 3;
        const x = k.x + pad, w = k.w - pad * 2;
        const h = Math.max(6, yBottom - yTop - 2);
        const y = yBottom - h;
        const col = HAND[n.hand];
        const dim = settings.mode === 'magic' ? !handOn(n.hand) : !n.required && (settings.mode === 'wait' || settings.mode === 'play');
        ctx.globalAlpha = n.missed ? 0.25 : dim ? 0.35 : n.hit ? 0.55 : 1;
        ctx.fillStyle = k.black ? col.dark : col.main;
        roundRect(x, y, w, h, 6);
        ctx.fill();
        if (!n.hit && !dim) {
          ctx.strokeStyle = 'rgba(255,255,255,0.55)';
          ctx.lineWidth = 1.5;
          ctx.stroke();
        }
        ctx.globalAlpha = 1;
        const label = noteName(n.midi);
        if (label && h > 18 && w > 16) {
          ctx.fillStyle = 'rgba(10,12,30,0.85)';
          ctx.font = `700 ${Math.min(14, w * 0.42)}px Nunito, system-ui, sans-serif`;
          ctx.fillText(label, x + w / 2, Math.min(yBottom - 4, hitY - 4));
        }
      }
    }

    // свободный режим — «следы» от нажатых клавиш, улетающие вверх
    if (settings.mode === 'free') {
      const speedPx = 0.18; // px/мс
      S.trails = S.trails.filter((tr) => {
        const k = keys.get(tr.midi);
        const yTop = hitY - (now - tr.t0) * speedPx;
        const yBottom = tr.t1 === null ? hitY : hitY - (now - tr.t1) * speedPx;
        if (yBottom < 0) return false;
        if (!k) return true;
        const hue = (tr.midi * 30) % 360;
        ctx.fillStyle = `hsla(${hue},85%,65%,0.85)`;
        roundRect(k.x + 2, Math.max(0, yTop), k.w - 4, Math.max(4, yBottom - Math.max(0, yTop)), 6);
        ctx.fill();
        return true;
      });
    }

    // линия удара
    const lineGrad = ctx.createLinearGradient(0, 0, W, 0);
    lineGrad.addColorStop(0, '#f472b6');
    lineGrad.addColorStop(0.5, '#a78bfa');
    lineGrad.addColorStop(1, '#60a5fa');
    ctx.fillStyle = lineGrad;
    ctx.fillRect(0, hitY - 3, W, 3);

    // клавиатура
    const lit = new Map();
    for (const n of S.autoActive) lit.set(n.midi, HAND[n.hand].main);
    for (const notes of S.magicHeld.values()) for (const n of notes) lit.set(n.midi, HAND[n.hand].main);
    const userColor = (m) => {
      const p = S.pressed.get(m);
      if (!p || settings.mode === 'magic') return null;
      if (p.state === 'good') return HAND[p.hand].main;
      if (p.state === 'bad') return '#f87171';
      return '#a78bfa';
    };
    const kbdLabels = new Map();
    if (settings.kbdHints) {
      const base = 12 * (settings.octave + 1);
      for (const code in KBD) kbdLabels.set(base + KBD[code], KBD_LABEL[code]);
    }

    for (const pass of [false, true]) {
      for (const [m, k] of keys) {
        if (k.black !== pass) continue;
        const h = k.black ? keyH * 0.62 : keyH;
        let fill = k.black ? '#1c1f3b' : '#f6f7ff';
        const hint = hints.get(m);
        if (hint) fill = HAND[hint].glow + (0.45 + 0.3 * Math.sin(now / 160)) + ')';
        if (lit.has(m)) fill = lit.get(m);
        const uc = userColor(m);
        if (uc) fill = uc;
        const fl = S.flash.get(m);
        if (fl && now - fl < 300 && !uc) fill = '#f87171';

        ctx.fillStyle = fill;
        if (k.black) {
          roundRect(k.x, hitY, k.w, h, 4);
          ctx.fill();
          if (fill === '#1c1f3b') {
            ctx.fillStyle = 'rgba(255,255,255,0.12)';
            ctx.fillRect(k.x + 3, hitY + h - 10, k.w - 6, 5);
          }
        } else {
          ctx.fillRect(k.x + 0.5, hitY, k.w - 1, h);
          ctx.fillStyle = 'rgba(0,0,0,0.18)';
          ctx.fillRect(k.x + k.w - 1, hitY, 1, h);
        }

        // подписи
        if (!k.black) {
          ctx.textAlign = 'center';
          ctx.textBaseline = 'alphabetic';
          const fs = Math.max(9, Math.min(15, k.w * 0.36));
          const label = noteName(m);
          if (label) {
            ctx.fillStyle = m % 12 === 0 ? '#6d28d9' : '#5b6080';
            ctx.font = `${m % 12 === 0 ? 800 : 600} ${fs}px Nunito, system-ui, sans-serif`;
            ctx.fillText(label, k.x + k.w / 2, hitY + h - 10);
            if (m % 12 === 0 && k.w > 22) {
              ctx.font = `600 ${fs * 0.75}px Nunito, system-ui, sans-serif`;
              ctx.fillText(String(m / 12 - 1), k.x + k.w / 2, hitY + h - 10 - fs - 2);
            }
          }
          const kl = kbdLabels.get(m);
          if (kl && k.w > 18) {
            ctx.fillStyle = '#9aa0c8';
            ctx.font = `700 ${fs * 0.85}px system-ui, sans-serif`;
            ctx.fillText(kl, k.x + k.w / 2, hitY + h * 0.5);
          }
        } else {
          const kl = kbdLabels.get(m);
          if (kl && k.w > 14) {
            ctx.fillStyle = '#9aa0c8';
            ctx.textAlign = 'center';
            ctx.font = `700 ${Math.min(12, k.w * 0.5)}px system-ui, sans-serif`;
            ctx.fillText(kl, k.x + k.w / 2, hitY + h * 0.45);
          }
        }
      }
    }

    // частицы
    S.particles = S.particles.filter((p) => {
      p.age += dt;
      if (p.age > p.life) return false;
      p.vy += 500 * dt;
      p.x += p.vx * dt;
      p.y += p.vy * dt;
      ctx.globalAlpha = 1 - p.age / p.life;
      ctx.fillStyle = p.color;
      ctx.beginPath();
      ctx.arc(p.x, p.y, 3, 0, Math.PI * 2);
      ctx.fill();
      return true;
    });
    ctx.globalAlpha = 1;

    // отсчёт и подсказка «Нажми…»
    ctx.textAlign = 'center';
    ctx.textBaseline = 'middle';
    if (S.playing && S.time < 0) {
      const left = Math.ceil(-S.time / settings.speed);
      ctx.fillStyle = 'rgba(255,255,255,0.9)';
      ctx.font = '800 64px Nunito, system-ui, sans-serif';
      ctx.fillText(String(left), W / 2, hitY / 2);
    } else if ((settings.mode === 'wait' && S.waiting) || (settings.mode === 'magic' && S.song && !S.finished && hints.size)) {
      const names = [...hints.keys()].sort((a, b) => a - b).map((m) => NAMES[settings.labels === 'en' ? 'en' : 'ru'][m % 12]);
      if (names.length && settings.mode === 'wait') {
        ctx.fillStyle = 'rgba(255,255,255,0.92)';
        ctx.font = '800 26px Nunito, system-ui, sans-serif';
        ctx.fillText('Нажми: ' + names.join(' + '), W / 2, hitY - 40);
      }
    }
  }

  let last = performance.now();
  let hudTimer = 0;
  function frame(now) {
    const dt = Math.min(0.05, (now - last) / 1000);
    last = now;
    update(dt);
    if (W > 0 && H > 0) draw(now, dt);
    hudTimer += dt;
    if (hudTimer > 0.15) { hudTimer = 0; updateProgress(); }
    requestAnimationFrame(frame);
  }

  // ---------- Интерфейс ----------
  function updateHud() {
    const st = S.stats;
    $('#statHits').textContent = st.hits;
    $('#statWrong').textContent = st.wrong + st.misses;
    $('#statStreak').textContent = st.streak;
    let acc = '—';
    if (settings.mode === 'wait' && st.hits + st.wrong) acc = Math.round(st.hits / (st.hits + st.wrong) * 100) + '%';
    if (settings.mode === 'play' && st.hits + st.misses) acc = Math.round(st.hits / (st.hits + st.misses) * 100) + '%';
    $('#statAcc').textContent = acc;
  }

  function updateProgress() {
    const p = S.end > 0 ? Math.max(0, Math.min(1, S.time / S.end)) : 0;
    $('#progressFill').style.width = (settings.mode === 'free' ? 0 : p * 100) + '%';
  }

  function updateButtons() {
    const mode = settings.mode;
    for (const b of document.querySelectorAll('#modeSeg button')) b.classList.toggle('on', b.dataset.mode === mode);
    for (const b of document.querySelectorAll('#handSeg button')) {
      b.classList.toggle('on', b.dataset.hands === settings.hands);
      b.disabled = mode === 'free';
    }
    const playBtn = $('#btnPlay');
    playBtn.disabled = !S.song || mode === 'free' || mode === 'magic';
    playBtn.style.visibility = (mode === 'free' || mode === 'magic') ? 'hidden' : 'visible';
    playBtn.textContent = S.playing ? '⏸ Пауза' : '▶ Играть';
    $('#speed').value = settings.speed;
    $('#speedVal').textContent = Math.round(settings.speed * 100) + '%';
  }

  let bannerTimer = null;
  function showBanner(text, sub, ms) {
    const b = $('#banner');
    b.innerHTML = escapeHtml(text) + (sub ? `<small>${escapeHtml(sub)}</small>` : '');
    b.classList.add('show');
    clearTimeout(bannerTimer);
    if (ms) bannerTimer = setTimeout(hideBanner, ms);
  }
  function hideBanner() { $('#banner').classList.remove('show'); }

  function starsHtml(id) {
    const s = progress[id] || 0;
    return '★'.repeat(s) + '<span class="off">' + '★'.repeat(3 - s) + '</span>';
  }

  function renderLibrary() {
    const list = $('#songList');
    list.innerHTML = '';
    for (const song of SONGS) list.appendChild(songItem(song, false));
    const fl = $('#fileList');
    fl.innerHTML = '';
    if (!userSongs.length) fl.innerHTML = '<li class="empty">Пока пусто — загрузите файл от учителя</li>';
    for (const song of userSongs) fl.appendChild(songItem(song, true));
  }

  function songItem(song, removable) {
    const li = document.createElement('li');
    if (S.song && S.song.id === song.id) li.classList.add('active');
    li.innerHTML = `<div class="s-main"><div class="s-title">${escapeHtml(song.title)}</div><div class="s-sub">${escapeHtml(song.subtitle)}</div></div><div class="s-stars">${starsHtml(song.id)}</div>`;
    if (removable) {
      const del = document.createElement('button');
      del.className = 's-del';
      del.title = 'Удалить';
      del.textContent = '✕';
      del.onclick = (e) => { e.stopPropagation(); removeUserSong(song.id); };
      li.appendChild(del);
    }
    li.onclick = () => selectSong(song);
    return li;
  }

  function selectSong(song) {
    S.song = song;
    store.set('maestro.lastSong', song.id);
    $('#songTitle').textContent = song.title;
    renderLibrary();
    prepare();
  }

  function setMode(mode) {
    settings.mode = mode;
    saveSettings();
    prepare();
  }

  // ---------- MIDI-файлы пользователя ----------
  function bufToB64(buf) {
    let s = '';
    const bytes = new Uint8Array(buf);
    for (let i = 0; i < bytes.length; i++) s += String.fromCharCode(bytes[i]);
    return btoa(s);
  }
  function b64ToBuf(b64) {
    const s = atob(b64);
    const bytes = new Uint8Array(s.length);
    for (let i = 0; i < s.length; i++) bytes[i] = s.charCodeAt(i);
    return bytes.buffer;
  }

  function songFromMidi(name, buf, id) {
    const { notes } = parseMidiFile(buf);
    if (!notes.length) throw new Error('В файле нет нот');
    return { id, title: name.replace(/\.midi?$/i, ''), subtitle: 'MIDI-файл', notes };
  }

  function loadUserSongs() {
    const saved = store.get('maestro.files', []);
    userSongs = [];
    for (const f of saved) {
      try { userSongs.push(songFromMidi(f.name, b64ToBuf(f.b64), f.id)); } catch (e) { /* пропускаем битые */ }
    }
  }

  async function addFiles(files) {
    let lastSong = null;
    for (const file of files) {
      try {
        const buf = await file.arrayBuffer();
        const id = 'file:' + file.name + ':' + file.size;
        const song = songFromMidi(file.name, buf, id);
        userSongs = userSongs.filter((s) => s.id !== id);
        userSongs.push(song);
        const saved = store.get('maestro.files', []).filter((f) => f.id !== id);
        saved.push({ id, name: file.name, b64: bufToB64(buf) });
        if (!store.set('maestro.files', saved)) showBanner('Файл открыт, но не сохранён', 'Недостаточно места в браузере', 2500);
        lastSong = song;
      } catch (e) {
        showBanner('Не получилось открыть ' + file.name, e.message, 3000);
      }
    }
    if (lastSong) selectSong(lastSong);
    else renderLibrary();
  }

  function removeUserSong(id) {
    userSongs = userSongs.filter((s) => s.id !== id);
    store.set('maestro.files', store.get('maestro.files', []).filter((f) => f.id !== id));
    if (S.song && S.song.id === id) { S.song = null; $('#songTitle').textContent = 'Выбери песню'; prepare(); }
    renderLibrary();
  }

  // ---------- Мышь / сенсорный экран по клавиатуре на экране ----------
  const pointers = new Map();
  function keyAt(x, y) {
    if (y < layout.hitY) return null;
    for (const [m, k] of layout.keys) if (k.black && y < layout.hitY + layout.keyH * 0.62 && x >= k.x && x < k.x + k.w) return m;
    for (const [m, k] of layout.keys) if (!k.black && x >= k.x && x < k.x + k.w) return m;
    return null;
  }
  canvas.addEventListener('pointerdown', (e) => {
    const r = canvas.getBoundingClientRect();
    const m = keyAt(e.clientX - r.left, e.clientY - r.top);
    if (m === null) {
      if (settings.mode === 'wait' || settings.mode === 'play') togglePlay();
      return;
    }
    canvas.setPointerCapture(e.pointerId);
    pointers.set(e.pointerId, m);
    noteOn(m, 0.8, 'mouse');
  });
  canvas.addEventListener('pointermove', (e) => {
    if (!pointers.has(e.pointerId)) return;
    const r = canvas.getBoundingClientRect();
    const m = keyAt(e.clientX - r.left, e.clientY - r.top);
    const prev = pointers.get(e.pointerId);
    if (m !== null && m !== prev) {
      noteOff(prev);
      pointers.set(e.pointerId, m);
      noteOn(m, 0.8, 'mouse');
    }
  });
  const pointerEnd = (e) => {
    const m = pointers.get(e.pointerId);
    if (m === undefined) return;
    pointers.delete(e.pointerId);
    noteOff(m);
  };
  canvas.addEventListener('pointerup', pointerEnd);
  canvas.addEventListener('pointercancel', pointerEnd);

  // ---------- Привязка элементов ----------
  for (const b of document.querySelectorAll('#modeSeg button')) b.onclick = () => setMode(b.dataset.mode);
  for (const b of document.querySelectorAll('#handSeg button')) b.onclick = () => { settings.hands = b.dataset.hands; saveSettings(); prepare(); };
  $('#speed').oninput = (e) => { settings.speed = parseFloat(e.target.value); saveSettings(); updateButtons(); };
  $('#btnPlay').onclick = togglePlay;
  $('#btnRestart').onclick = () => prepare();
  $('#fileInput').onchange = (e) => { addFiles([...e.target.files]); e.target.value = ''; };

  window.addEventListener('dragover', (e) => e.preventDefault());
  window.addEventListener('drop', (e) => {
    e.preventDefault();
    const files = [...e.dataTransfer.files].filter((f) => /\.midi?$/i.test(f.name));
    if (files.length) addFiles(files);
  });

  const openSettings = () => { synth.ensure(); fillMidiSelects(); $('#settingsDlg').showModal(); };
  $('#btnSettings').onclick = openSettings;
  $('#midiStatus').onclick = openSettings;
  $('#selIn').onchange = (e) => { settings.midiIn = e.target.value; saveSettings(); midi.refresh(); };
  $('#selOut').onchange = (e) => { settings.midiOut = e.target.value; saveSettings(); midi.refresh(); };
  $('#chkEcho').checked = settings.echo;
  $('#chkEcho').onchange = (e) => { settings.echo = e.target.checked; saveSettings(); };
  $('#volume').value = settings.volume;
  $('#volume').oninput = (e) => { settings.volume = parseFloat(e.target.value); synth.setVolume(settings.volume); saveSettings(); };
  $('#selLabels').value = settings.labels;
  $('#selLabels').onchange = (e) => { settings.labels = e.target.value; saveSettings(); };
  $('#selRange').value = settings.range;
  $('#selRange').onchange = (e) => { settings.range = e.target.value; saveSettings(); computeRange(); };
  $('#chkKbd').checked = settings.kbdHints;
  $('#chkKbd').onchange = (e) => { settings.kbdHints = e.target.checked; saveSettings(); };

  $('#btnAgain').onclick = () => prepare();
  $('#btnNext').onclick = () => {
    const all = SONGS.concat(userSongs);
    const i = all.findIndex((s) => S.song && s.id === S.song.id);
    selectSong(all[(i + 1) % all.length]);
  };

  // ---------- Запуск ----------
  loadUserSongs();
  resize();
  const lastId = store.get('maestro.lastSong', null);
  const first = SONGS.concat(userSongs).find((s) => s.id === lastId) || SONGS[0];
  selectSong(first);
  midi.init();
  requestAnimationFrame(frame);

  window.maestro = { S, settings, noteOn, noteOff, selectSong, setMode };
})();
