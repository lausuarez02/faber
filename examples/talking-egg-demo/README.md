# Talking egg (Nano + DFPlayer Mini)

Press the button and it says something. The smallest device that talks in Faber.

| Part | Id | Notes |
| --- | --- | --- |
| Arduino Nano | `nano` | Runs `firmware/main.hex` (the golden build of `firmware/main.ino`). |
| DFPlayer Mini | `df` | MP3 player with a microSD card. Its `clips` prop holds what each track says. |
| Speaker 8 Ω 0.5 W | `spk` | On SPK_1 (+) and SPK_2 (-), the bridged amplifier outputs. |
| 1 kΩ resistor | `r1` | Between the Nano's TX pin (D11) and the DFPlayer's RX. |
| Push button | `btn1` | D2 to GND, `INPUT_PULLUP`. |

The sketch talks to the DFPlayer over SoftwareSerial on D10 (RX) / D11 (TX) at 9600 baud with a
ten-line frame helper (`dfSend`, no library). After start-up it says track 1 ("hi! I'm Eggy");
each press says the next of tracks 2 to 4. It prints `player online` and `done N` from the
DFPlayer's replies.

In the simulator the clips are text: the canvas shows a speech bubble next to the speaker, the
browser reads the words aloud (the mute button in the bubble is remembered), `read_speech` lists
what was said, and the tests check it with `{"said": "dizzy", "within_ms": 300}`.

## Tests

- `greets`: the module comes online and it says "Eggy".
- `talks-on-press`: a press says "whoa, I'm dizzy!", the module reports the track finished, the
  next press says "hehe, that tickles", and it does not repeat "dizzy".

`pnpm faber test -p examples/talking-egg-demo` (2/2).

## Making a real one

`export_manufacturing` writes `sd-card/`: one text file per clip (`mp3/0001.txt` …), `CLIPS.md`
(which file plays for which command, FAT32, copy order) and `make-clips.sh`, which turns the texts
into MP3s with a text-to-speech tool you install yourself (espeak-ng or piper, plus ffmpeg). Or
record your own voice as `mp3/0001.mp3` …

What the simulation does not check: the real voice and loudness, MP3 decoding, the card's file
order, clone modules that need a longer start-up delay (see `faber fidelity -p .`).
