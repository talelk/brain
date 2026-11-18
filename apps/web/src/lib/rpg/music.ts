/**
 * Quiet village music, made by Web Audio while it plays (nothing is downloaded): a soft plucked arpeggio over a pad and a bass,
 * with a melody that wanders in the pentatonic scale. By day it is in C major at a walking pace; at night in A minor, slower and
 * sparser. It is made only after the person turns it on, and it rests while the tab is hidden.
 */

const midi = (note: number): number => 440 * 2 ** ((note - 69) / 12);
const DAY = { tempo: 84, chords: [[60, 64, 67], [57, 60, 64], [53, 57, 60], [55, 59, 62]], scale: [72, 74, 76, 79, 81, 84] };
const NIGHT = { tempo: 62, chords: [[57, 60, 64], [53, 57, 60], [48, 52, 55], [55, 59, 62]], scale: [69, 72, 74, 76, 79, 81] };

export interface Music { setNight(night: boolean): void; pause(paused: boolean): void; close(): void }

export function startMusic(volume = 0.05): Music {
  const audio = new AudioContext();
  const master = audio.createGain();
  master.gain.value = 0;
  master.gain.linearRampToValueAtTime(volume, audio.currentTime + 2);
  const tone = audio.createBiquadFilter();
  tone.type = "lowpass";
  tone.frequency.value = 2600;
  // A short echo gives the plucks some room.
  const delay = audio.createDelay(1);
  delay.delayTime.value = 0.32;
  const feedback = audio.createGain();
  feedback.gain.value = 0.28;
  delay.connect(feedback).connect(delay);
  tone.connect(master);
  delay.connect(master);
  master.connect(audio.destination);

  let night = false;
  let beat = 0;
  let next = audio.currentTime + 0.1;
  let melody = 2;
  const random = (): number => Math.random();

  const pluck = (frequency: number, at: number, length: number, gain: number, type: OscillatorType = "triangle"): void => {
    const osc = audio.createOscillator();
    const env = audio.createGain();
    osc.type = type;
    osc.frequency.value = frequency;
    env.gain.setValueAtTime(0.0001, at);
    env.gain.exponentialRampToValueAtTime(gain, at + 0.012);
    env.gain.exponentialRampToValueAtTime(0.0001, at + length);
    osc.connect(env);
    env.connect(tone);
    env.connect(delay);
    osc.start(at);
    osc.stop(at + length + 0.05);
  };
  const pad = (notes: readonly number[], at: number, length: number): void => {
    for (const note of notes) for (const detune of [-6, 6]) {
      const osc = audio.createOscillator();
      const env = audio.createGain();
      osc.type = "sine";
      osc.frequency.value = midi(note);
      osc.detune.value = detune;
      env.gain.setValueAtTime(0.0001, at);
      env.gain.linearRampToValueAtTime(0.05, at + length * 0.35);
      env.gain.linearRampToValueAtTime(0.0001, at + length);
      osc.connect(env).connect(tone);
      osc.start(at);
      osc.stop(at + length + 0.05);
    }
  };

  const schedule = (): void => {
    const song = night ? NIGHT : DAY;
    const step = 60 / song.tempo / 2; // eighth notes
    while (next < audio.currentTime + 0.6) {
      const bar = Math.floor(beat / 8) % song.chords.length;
      const chord = song.chords[bar] as number[];
      const inBar = beat % 8;
      if (inBar === 0) { pad(chord.map((n) => n - 12), next, step * 8); pluck(midi((chord[0] as number) - 24), next, step * 6, 0.12, "sine"); }
      // The arpeggio: up and down the chord, softer at night.
      if (!night || inBar % 2 === 0) pluck(midi((chord[[0, 1, 2, 1, 0, 1, 2, 1][inBar] as number] as number) + 12), next, step * 2.5, night ? 0.05 : 0.07);
      // The melody: a walk in the scale with rests.
      if ((inBar === 0 || inBar === 3 || inBar === 6) && random() < (night ? 0.45 : 0.7)) {
        melody = Math.max(0, Math.min(song.scale.length - 1, melody + Math.round((random() - 0.5) * 3)));
        pluck(midi(song.scale[melody] as number), next, step * (night ? 5 : 3.5), 0.06, "sine");
      }
      beat += 1;
      next += step;
    }
  };
  const timer = setInterval(schedule, 150);
  schedule();

  return {
    setNight: (value) => { night = value; },
    pause: (paused) => { void (paused ? audio.suspend() : audio.resume()).catch(() => undefined); if (!paused) next = Math.max(next, audio.currentTime + 0.05); },
    close: () => { clearInterval(timer); master.gain.linearRampToValueAtTime(0, audio.currentTime + 0.4); setTimeout(() => { void audio.close().catch(() => undefined); }, 500); },
  };
}
