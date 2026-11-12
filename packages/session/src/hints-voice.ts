import type { Usage } from "./hints.ts";

/**
 * Round 7 (voice): get_part hints for the DFPlayer Mini and the speaker. The example uses no
 * library: a 10-byte frame helper (dfSend) so no third-party licence question arises. (The common
 * DFRobotDFPlayerMini library says "GNU Lesser General Public License" in its header; it works in
 * Jumper too if the person installs it, but Jumper does not ship or require it.)
 */

/** The frame helper, shared by the hint and the docs. */
export const DFPLAYER_HELPER = `// DFPlayer Mini: one command = 10 bytes at 9600 baud, no library needed.
// 7E FF 06 CMD 00 PARAM_H PARAM_L CHK_H CHK_L EF, CHK = 0 - (FF + 06 + CMD + 00 + PARAM_H + PARAM_L)
void dfSend(Stream &port, uint8_t cmd, uint16_t param) {
  uint8_t f[10] = {0x7E, 0xFF, 0x06, cmd, 0x00, (uint8_t)(param >> 8), (uint8_t)(param & 0xFF), 0, 0, 0xEF};
  uint16_t sum = 0;
  for (int i = 1; i < 7; i++) sum += f[i];
  uint16_t chk = (uint16_t)(0 - sum);
  f[7] = chk >> 8;
  f[8] = chk & 0xFF;
  port.write(f, 10);
}
// dfSend(port, 0x06, 20);  volume 0..30
// dfSend(port, 0x03, 2);   play track 2 (says clip "2: ...")
// dfSend(port, 0x12, 2);   play /mp3/0002.mp3 by name
// dfSend(port, 0x0E, 0);   pause    dfSend(port, 0x16, 0); stop`;

const AVR_EXAMPLE = `#include <SoftwareSerial.h>
SoftwareSerial dfSerial(10, 11);  // RX <- DFPlayer TX, TX -> 1k -> DFPlayer RX

${DFPLAYER_HELPER}

void setup() {
  pinMode(2, INPUT_PULLUP);       // button to GND
  dfSerial.begin(9600);
  delay(1500);                    // it scans its card for ~1 s after power-up
  dfSend(dfSerial, 0x06, 22);     // volume
  dfSend(dfSerial, 0x03, 1);      // say clip 1
}

void loop() {
  if (digitalRead(2) == LOW) { dfSend(dfSerial, 0x03, 2); delay(300); }
}`;

export const VOICE_HINTS: Record<string, Usage> = {
  "dfplayer-mini": {
    wiring:
      "Makes the device talk. VCC → 5V / VBUS (or the battery after its switch; 3.3 V works but quieter), GND.1 → GND, RX ← the board's serial TX through a 1 kΩ resistor, TX → the board's serial RX (only needed to read replies), SPK_1 → speaker +, SPK_2 → speaker - (SPK_2 is NOT ground). Uno / Nano: SoftwareSerial on D10 (RX) / D11 (TX), leaving D0 / D1 for the USB serial monitor (hardware Serial on D0 / D1 also reaches it). XIAO RP2040: Serial1, TX = D6 (GP0) → 1 kΩ → RX, RX = D7 (GP1) ← TX; Serial1.begin(9600). Pico: Serial1 on GP0 / GP1. 9600 baud 8N1, wait ~1.5 s after power-up before the first command. What it says is its \"clips\" prop: one \"N: words\" line per track, e.g. set_part_property {\"id\": \"df1\", \"prop\": \"clips\", \"value\": \"1: hi! I'm Eggy\\n2: whoa, I'm dizzy!\"} (a JSON object works too); playing track N says those words (speech bubble, read_speech, the {\"said\": \"dizzy\"} test step). export_manufacturing writes the microSD files to sd-card/.",
    connect: ["df1.VCC -> uno.5V", "df1.GND.1 -> uno.GND", "uno.D11 -> r1.1", "r1.2 -> df1.RX", "df1.TX -> uno.D10", "df1.SPK_1 -> spk1.+", "df1.SPK_2 -> spk1.-"],
    example: AVR_EXAMPLE,
    controls:
      'State: saying (words playing now), speaking (heard through a wired speaker), lastSaid, track, volume, playing, busy, badFrames, lastCommand. read_speech lists everything it said with times. In scenarios: {"said": "dizzy", "within_ms": 500} or {"expect_part": "df1.speaking", "value": true}. interact set track = N plays a clip by hand.',
  },
  speaker: {
    wiring: "+ → the amplifier's + output, - → its - output: DFPlayer SPK_1 / SPK_2, or an I2S amplifier's OUT+ / OUT- (MAX98357A, for audio the board makes or downloads). Both are bridged amplifiers: neither lead goes to GND. Never wire a speaker straight to a board pin or a supply: 8 Ω pulls 600 mA from 5 V. Mount it facing the case's grille.",
    connect: ["spk1.+ -> df1.SPK_1", "spk1.- -> df1.SPK_2"],
    controls: "State: sounding, volume (0..1 of its rated power), powerW, currentmA.",
  },
};
