"""Render the three LAST OXYGEN music tracks: Python 3 + numpy (build-time only)."""
from pathlib import Path
import json
import wave
import numpy as np

ROOT = Path(__file__).resolve().parents[1] / 'apps/web/audio'
ROOT.mkdir(parents=True, exist_ok=True)
RATE = 44100
TAU = 2 * np.pi


def hz(midi):
    return 440 * 2 ** ((midi - 69) / 12)


def layer(out, start, duration, midi, level, attack, release, pan=0,
          color='sine', end_midi=None, loop=False):
    t = np.arange(round(duration * RATE)) / RATE
    envelope = np.sin(np.minimum(1, np.minimum(t / attack,
        (len(t) - 1 - np.arange(len(t))) / (RATE * release))).clip(0) * np.pi / 2) ** 2
    frequency = hz(midi)
    if end_midi is not None:
        phase = TAU * (frequency * t + (hz(end_midi) - frequency) * t*t / (2 * duration))
    else:
        phase = TAU * frequency * t
    if color == 'bell':
        signal = (np.sin(phase) + 0.18 * np.sin(phase * 2.002) * np.exp(-t * 1.4)) * np.exp(-t * 0.65)
    else:
        signal = np.sin(phase)
    signal *= envelope * level
    indices = np.arange(len(t)) + round(start * RATE)
    if loop:
        indices %= len(out)
    else:
        valid = indices < len(out)
        indices, signal = indices[valid], signal[valid]
    out[indices, 0] += signal * np.sqrt((1 - pan) / 2)
    out[indices, 1] += signal * np.sqrt((1 + pan) / 2)


def write(name, out, loop, peak=0.5):
    # Diffuse stereo tails are mixed circularly so notes cross the loop boundary.
    wet = out.copy()
    for delay, gain in ((0.193, 0.16), (0.317, 0.12), (0.479, 0.08), (0.719, 0.05)):
        shifted = np.roll(out[:, ::-1], round(delay * RATE), axis=0)
        if not loop:
            shifted[:round(delay * RATE)] = 0
        wet += shifted * gain
    wet *= peak / np.max(np.abs(wet))
    if not loop:
        count = round(RATE * 0.04)
        wet[-count:] *= np.linspace(1, 0, count)[:, None]
    pcm = np.rint(wet * 32767).astype('<i2')
    with wave.open(str(ROOT / f'{name}.wav'), 'wb') as wav:
        wav.setparams((2, 2, RATE, 0, 'NONE', 'not compressed'))
        wav.writeframes(pcm.tobytes())
    seam = np.max(np.abs(pcm[0].astype(float) - pcm[-1].astype(float))) / 32768
    assert np.max(np.abs(pcm.astype(float))) < 32767
    edge_slope = max(np.max(np.abs(np.diff(edge.astype(float), axis=0)))
                     for edge in (pcm[-1024:], pcm[:1024])) / 32768
    assert not loop or seam <= edge_slope * 1.1
    return dict(file=f'{name}.wav', seconds=len(out) / RATE, loop=loop,
                peakDbfs=round(float(20*np.log10(np.max(np.abs(wet)))), 2),
                boundaryStep=round(float(seam), 6))


# 64 BPM, 24 bars: six four-bar phrases. D minor with suspended resolutions.
music = np.zeros((90 * RATE, 2), dtype=np.float64)
chords = ((50, 57, 60, 64), (46, 53, 57, 62), (53, 57, 60, 67),
          (48, 55, 62, 64), (43, 50, 57, 58), (45, 52, 55, 62))
motifs = ((74, 69, 76, 77), (74, 72, 69), (77, 79, 76, 72),
          (76, 74, 67), (74, 77, 81, 77), (76, 74, 69))
for phrase, chord in enumerate(chords):
    start = phrase * 15
    for voice, midi in enumerate(chord):
        # Short, quiet chord accents above middle C leave space between phrases.
        while midi < 60:
            midi += 12
        layer(music, start + 0.9375, 6, midi, 0.006,
              attack=1.5, release=4, pan=(voice - 1.5) * 0.24, loop=True)
    for note, midi in enumerate(motifs[phrase]):
        layer(music, start + 2.8125 + note * 2.8125, 5.5, midi,
              0.014 if phrase in (2, 4) else 0.010, 0.12, 4.5,
              pan=(-0.28 if note % 2 else 0.28), color='bell', loop=True)
    # Quiet answer phrases leave space for reading and planning.
    if phrase in (1, 3, 5):
        layer(music, start + 11.25, 6, chord[2] + 12, 0.008, 1.8, 4,
              pan=-0.35, loop=True)
report = [write('bgm-exploration', music, True, peak=0.32)]

# Preserve the selected endings' original short motifs and durations.
for name, seconds, notes in (
    ('rescue-success', 4.3, [(i * 0.28, 3.2, midi, None, 0.05, 0.08, 2.5)
                           for i, midi in enumerate((62, 65, 69, 76))]),
    ('mission-failure', 3.4, [(0, 2.9, 50, 38, 0.07, 0.12, 1.5),
                            (0.2, 2.7, 57, 45, 0.04, 0.1, 1.5)]),
):
    out = np.zeros((round(seconds * RATE), 2))
    for start, duration, midi, end_midi, level, attack, release in notes:
        layer(out, start, duration, midi, level, attack, release,
              color='sine', end_midi=end_midi)
    report.append(write(name, out, False, peak=0.5))
print(json.dumps(report, ensure_ascii=False, indent=2))
