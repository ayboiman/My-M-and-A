// Встроенная библиотека песен.
// Нотация: "E4/1" — нота и длительность в долях (1 = четверть), без "/..." — четверть.
// "r/2" — пауза, "C3+E3+G3/2" — аккорд, "|" — тактовая черта (для удобства чтения).
'use strict';

const NOTE_BASE = { C: 0, D: 2, E: 4, F: 5, G: 7, A: 9, B: 11 };

function noteNameToMidi(name) {
  const m = /^([A-G])([#b]?)(-?\d)$/.exec(name);
  if (!m) throw new Error('Неизвестная нота: ' + name);
  const acc = m[2] === '#' ? 1 : m[2] === 'b' ? -1 : 0;
  return 12 * (parseInt(m[3], 10) + 1) + NOTE_BASE[m[1]] + acc;
}

function parseVoice(text, hand, secPerBeat) {
  const notes = [];
  let t = 0;
  for (const tok of text.trim().split(/\s+/)) {
    if (!tok || tok === '|') continue;
    const [pitch, d] = tok.split('/');
    const beats = d ? parseFloat(d) : 1;
    if (pitch !== 'r') {
      for (const name of pitch.split('+')) {
        notes.push({ midi: noteNameToMidi(name), start: t * secPerBeat, dur: beats * secPerBeat, hand, vel: hand === 'R' ? 0.8 : 0.6 });
      }
    }
    t += beats;
  }
  return notes;
}

function makeSong(def) {
  const spb = 60 / def.bpm;
  const notes = parseVoice(def.rh, 'R', spb).concat(def.lh ? parseVoice(def.lh, 'L', spb) : []);
  notes.sort((a, b) => a.start - b.start || a.midi - b.midi);
  return { id: def.id, title: def.title, subtitle: def.subtitle || '', level: def.level || 1, notes };
}

const SONG_DEFS = [
  {
    id: 'scale-c', title: 'Гамма До мажор', subtitle: 'Разминка для правой руки', level: 1, bpm: 80,
    rh: 'C4 D4 E4 F4 G4 A4 B4 C5/2 r/2 C5 B4 A4 G4 F4 E4 D4 C4/2',
    lh: 'C3/4 r/4 r/4 r/2 C3/2',
  },
  {
    id: 'mary', title: 'У Мэри был барашек', subtitle: 'Английская детская песенка', level: 1, bpm: 100,
    rh: 'E4 D4 C4 D4 | E4 E4 E4/2 | D4 D4 D4/2 | E4 G4 G4/2 | E4 D4 C4 D4 | E4 E4 E4 E4 | D4 D4 E4 D4 | C4/4',
    lh: 'C3/4 | C3/4 | G2/4 | C3/4 | C3/4 | C3/4 | G2/4 | C3/4',
  },
  {
    id: 'twinkle', title: 'Мерцай, звёздочка', subtitle: 'Французская народная мелодия', level: 1, bpm: 100,
    rh: 'C4 C4 G4 G4 | A4 A4 G4/2 | F4 F4 E4 E4 | D4 D4 C4/2 | G4 G4 F4 F4 | E4 E4 D4/2 | G4 G4 F4 F4 | E4 E4 D4/2 | C4 C4 G4 G4 | A4 A4 G4/2 | F4 F4 E4 E4 | D4 D4 C4/2',
    lh: 'C3/4 | F3/2 E3/2 | D3/2 C3/2 | G2/2 C3/2 | E3/2 D3/2 | C3/2 B2/2 | E3/2 D3/2 | C3/2 B2/2 | C3/4 | F3/2 E3/2 | D3/2 C3/2 | G2/2 C3/2',
  },
  {
    id: 'elochka', title: 'В лесу родилась ёлочка', subtitle: 'Л. Бекман (упрощённо)', level: 1, bpm: 100,
    rh: 'C4/0.5 A4/0.5 A4/0.5 G4/0.5 A4/0.5 F4/0.5 C4/0.5 C4/0.5 | C4/0.5 A4/0.5 A4/0.5 Bb4/0.5 G4/0.5 C5/1.5 | C5/0.5 D5/0.5 D5/0.5 Bb4/0.5 Bb4/0.5 A4/0.5 G4/0.5 F4/0.5 | C5/0.5 A4/0.5 A4/0.5 G4/0.5 A4/0.5 F4/1.5',
    lh: 'F3/2 F3/2 | F3/2 C3/2 | Bb2/2 F3/1 C3/1 | C3/2 F3/2',
  },
  {
    id: 'jingle', title: 'Бубенцы (Jingle Bells)', subtitle: 'Дж. Пьерпонт, припев', level: 2, bpm: 120,
    rh: 'E4 E4 E4/2 | E4 E4 E4/2 | E4 G4 C4 D4 | E4/4 | F4 F4 F4 F4 | F4 E4 E4 E4/0.5 E4/0.5 | E4 D4 D4 E4 | D4/2 G4/2 | E4 E4 E4/2 | E4 E4 E4/2 | E4 G4 C4 D4 | E4/4 | F4 F4 F4 F4 | F4 E4 E4 E4/0.5 E4/0.5 | G4 G4 F4 D4 | C4/4',
    lh: 'C3/4 | C3/4 | C3/4 | C3/4 | F2/4 | C3/4 | D3/2 G2/2 | G2/4 | C3/4 | C3/4 | C3/4 | C3/4 | F2/4 | C3/4 | G2/4 | C3/4',
  },
  {
    id: 'birthday', title: 'С днём рождения', subtitle: 'Happy Birthday', level: 2, bpm: 100,
    rh: 'G4/0.75 G4/0.25 A4 G4 C5 B4/2 | G4/0.75 G4/0.25 A4 G4 D5 C5/2 | G4/0.75 G4/0.25 G5 E5 C5 B4 A4/2 | F5/0.75 F5/0.25 E5 C5 D5 C5/2',
    lh: 'r/1 | C3/3 | G2/3 | G2/3 | C3/3 | C3/3 | F2/3 | C3/3 | G2/1 C3/2',
  },
  {
    id: 'ode', title: 'Ода к радости', subtitle: 'Л. ван Бетховен', level: 2, bpm: 100,
    rh: 'E4 E4 F4 G4 | G4 F4 E4 D4 | C4 C4 D4 E4 | E4/1.5 D4/0.5 D4/2 | E4 E4 F4 G4 | G4 F4 E4 D4 | C4 C4 D4 E4 | D4/1.5 C4/0.5 C4/2 | D4 D4 E4 C4 | D4 E4/0.5 F4/0.5 E4 C4 | D4 E4/0.5 F4/0.5 E4 D4 | C4 D4 G3/2 | E4 E4 F4 G4 | G4 F4 E4 D4 | C4 C4 D4 E4 | D4/1.5 C4/0.5 C4/2',
    lh: 'C3/4 | G2/4 | C3/4 | G2/4 | C3/4 | G2/4 | C3/4 | G2/2 C3/2 | G2/4 | G2/2 C3/2 | G2/2 C3/2 | A2/2 G2/2 | C3/4 | G2/4 | C3/4 | G2/2 C3/2',
  },
  {
    id: 'nachtmusik', title: 'Маленькая ночная серенада', subtitle: 'В. А. Моцарт, тема', level: 3, bpm: 110,
    rh: 'G4/1 r/0.5 D4/0.5 G4/1 r/0.5 D4/0.5 | G4/0.5 D4/0.5 G4/0.5 B4/0.5 D5/2 | C5/1 r/0.5 A4/0.5 C5/1 r/0.5 A4/0.5 | C5/0.5 A4/0.5 F#4/0.5 A4/0.5 D4/2',
    lh: 'G2+G3/1 r/1 G2+G3/1 r/1 | G2/2 B2/2 | D3/1 r/1 D3/1 r/1 | D3/2 D2/2',
  },
  {
    id: 'elise', title: 'К Элизе', subtitle: 'Л. ван Бетховен, начало', level: 3, bpm: 120,
    rh: 'E5/0.5 D#5/0.5 E5/0.5 D#5/0.5 E5/0.5 B4/0.5 D5/0.5 C5/0.5 | A4/1.5 C4/0.5 E4/0.5 A4/0.5 | B4/1.5 E4/0.5 G#4/0.5 B4/0.5 | C5/1.5 E4/0.5 | E5/0.5 D#5/0.5 E5/0.5 D#5/0.5 E5/0.5 B4/0.5 D5/0.5 C5/0.5 | A4/1.5 C4/0.5 E4/0.5 A4/0.5 | B4/1.5 E4/0.5 C5/0.5 B4/0.5 | A4/3',
    lh: 'r/4 | A2/0.5 E3/0.5 A3/0.5 r/1.5 | E2/0.5 E3/0.5 G#3/0.5 r/1.5 | A2/0.5 E3/0.5 A3/0.5 r/4.5 | A2/0.5 E3/0.5 A3/0.5 r/1.5 | E2/0.5 E3/0.5 G#3/0.5 r/1.5 | A2/3',
  },
];

window.SONGS = SONG_DEFS.map(makeSong);
