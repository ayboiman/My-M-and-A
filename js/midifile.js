// Чтение стандартных MIDI-файлов (.mid) в список нот.
'use strict';

function parseMidiFile(buffer) {
  const d = new DataView(buffer);
  let p = 0;
  const u8 = () => d.getUint8(p++);
  const u16 = () => { const v = d.getUint16(p); p += 2; return v; };
  const u32 = () => { const v = d.getUint32(p); p += 4; return v; };
  const str = (n) => { let s = ''; for (let i = 0; i < n; i++) s += String.fromCharCode(u8()); return s; };
  const vlq = () => { let v = 0, b; do { b = u8(); v = (v << 7) | (b & 0x7f); } while (b & 0x80); return v; };

  if (str(4) !== 'MThd') throw new Error('Это не MIDI-файл');
  const hlen = u32();
  u16(); // format
  const ntrks = u16();
  const division = u16();
  p = 8 + hlen;
  if (division & 0x8000) throw new Error('MIDI-файлы с SMPTE-временем не поддерживаются');

  const tempos = [{ tick: 0, uspq: 500000 }];
  const raw = [];
  const names = [];

  for (let tr = 0; tr < ntrks && p < d.byteLength; tr++) {
    if (str(4) !== 'MTrk') throw new Error('Повреждённый MIDI-файл');
    const len = u32();
    const end = p + len;
    let tick = 0, running = 0;
    const open = new Map();
    while (p < end) {
      tick += vlq();
      let st = d.getUint8(p);
      if (st & 0x80) p++; else st = running;
      if (st === 0xff) {
        const type = u8();
        const l = vlq();
        if (type === 0x51 && l === 3) {
          tempos.push({ tick, uspq: (d.getUint8(p) << 16) | (d.getUint8(p + 1) << 8) | d.getUint8(p + 2) });
        } else if (type === 0x03 && !names[tr]) {
          let s = ''; for (let i = 0; i < l; i++) s += String.fromCharCode(d.getUint8(p + i));
          names[tr] = s;
        }
        p += l;
      } else if (st === 0xf0 || st === 0xf7) {
        p += vlq();
      } else {
        running = st;
        const type = st & 0xf0, ch = st & 0x0f;
        const a = u8();
        const b = (type === 0xc0 || type === 0xd0) ? 0 : u8();
        const key = ch * 128 + a;
        if (type === 0x90 && b > 0) {
          if (!open.has(key)) open.set(key, []);
          open.get(key).push({ tick, vel: b });
        } else if (type === 0x80 || (type === 0x90 && b === 0)) {
          const stack = open.get(key);
          if (stack && stack.length) {
            const on = stack.shift();
            if (ch !== 9) raw.push({ track: tr, ch, midi: a, t0: on.tick, t1: tick, vel: on.vel });
          }
        }
      }
    }
    p = end;
  }

  tempos.sort((x, y) => x.tick - y.tick);
  const segs = [];
  let sec = 0;
  for (let i = 0; i < tempos.length; i++) {
    const tp = tempos[i];
    if (i > 0) sec += (tp.tick - tempos[i - 1].tick) * tempos[i - 1].uspq / 1e6 / division;
    segs.push({ tick: tp.tick, sec, uspq: tp.uspq });
  }
  const toSec = (tick) => {
    let s = segs[0];
    for (const x of segs) { if (x.tick <= tick) s = x; else break; }
    return s.sec + (tick - s.tick) * s.uspq / 1e6 / division;
  };

  // Распределяем партии по рукам: верхние голоса — правая, нижние — левая.
  const parts = new Map();
  for (const n of raw) {
    const k = n.track + ':' + n.ch;
    if (!parts.has(k)) parts.set(k, []);
    parts.get(k).push(n);
  }
  const avg = (arr) => arr.reduce((s, n) => s + n.midi, 0) / arr.length;
  const partList = [...parts.values()].sort((x, y) => avg(y) - avg(x));
  const notes = [];
  for (let i = 0; i < partList.length; i++) {
    for (const n of partList[i]) {
      let hand;
      if (partList.length === 1) hand = n.midi >= 60 ? 'R' : 'L';
      else hand = i === 0 ? 'R' : 'L';
      const start = toSec(n.t0);
      notes.push({ midi: n.midi, start, dur: Math.max(0.05, toSec(n.t1) - start), hand, vel: n.vel / 127 });
    }
  }
  notes.sort((x, y) => x.start - y.start || x.midi - y.midi);
  // Убираем тишину в начале файла.
  const first = notes.length ? notes[0].start : 0;
  for (const n of notes) n.start -= first;
  return { notes, names };
}

window.parseMidiFile = parseMidiFile;
