import type { Usage } from "./hints.ts";

/**
 * Round 13 (audio): get_part hints for digital audio, generic over what the sound is (tones, clips,
 * speech an API returned): the MAX98357A I2S amplifier and the INMP441 I2S microphone (which also
 * stands in for a PDM microphone such as the XIAO ESP32-S3 Sense's). The examples use only
 * arduino-esp32's own ESP_I2S, HTTPClient and WiFi (the core's licences); the decoder choices and
 * their licences are spelled out so nothing GPL lands in a product by accident.
 */

const AMP_EXAMPLE = `// XIAO ESP32-S3 + MAX98357A: a tone, then whatever audio an API returns, straight to the speaker.
#include <WiFi.h>
#include <HTTPClient.h>
#include <ESP_I2S.h>
I2SClass i2s;

void tone1k(int ms) {             // 1 kHz at 25 % of full scale (keep small speakers within their watts)
  static int16_t buf[160];
  for (int i = 0; i < 160; i++) buf[i] = (int16_t)(8192 * sinf(2 * PI * i / 16.0f));
  for (int t = 0; t < ms; t += 10) i2s.write((uint8_t *)buf, sizeof(buf));
}

// Raw 16-bit mono PCM (or a WAV: skip = 44) from an API, played as it downloads.
size_t playUrl(const char *url, size_t skip) {
  HTTPClient http;
  http.useHTTP10(true);           // plain bytes until close: no chunk framing in the audio
  http.begin(url);
  if (http.GET() != 200) { http.end(); return 0; }
  WiFiClient *s = http.getStreamPtr();
  static uint8_t buf[1024];
  size_t total = 0, have = 0;
  while (http.connected() || s->available()) {
    int n = s->available();
    if (!n) { delay(1); continue; }
    have += s->readBytes(buf + have, min((size_t)n, sizeof(buf) - have));
    size_t k = min(skip, have); memmove(buf, buf + k, have - k); have -= k; skip -= k;
    size_t even = have & ~(size_t)1;
    total += i2s.write(buf, even);
    memmove(buf, buf + even, have - even); have -= even;
  }
  http.end();
  return total;
}

void setup() {
  Serial.begin(115200);
  i2s.setPins(D1, D2, D3);        // BCLK, LRC (WS), DIN
  i2s.begin(I2S_MODE_STD, 16000, I2S_DATA_BIT_WIDTH_16BIT, I2S_SLOT_MODE_MONO);
  tone1k(200);
  WiFi.begin("your-ssid", "your-password");
  while (WiFi.status() != WL_CONNECTED) delay(100);
  playUrl("http://your-api.example/say.pcm?text=hi", 0);   // ask the API for 16 kHz 16-bit mono
}
void loop() {}`;

const MIC_EXAMPLE = `// Record from an I2S microphone and print its level. INMP441 on standard I2S; the XIAO ESP32-S3
// Sense's onboard PDM mic: mic.setPinsPdmRx(42, 41) and I2S_MODE_PDM_RX instead (same read code).
#include <ESP_I2S.h>
I2SClass mic;
int16_t rec[1600];                // 0.1 s at 16 kHz
void setup() {
  Serial.begin(115200);
  mic.setPins(D1, D2, -1, D3);    // BCLK -> SCK, WS -> WS, DIN <- SD
  mic.begin(I2S_MODE_STD, 16000, I2S_DATA_BIT_WIDTH_16BIT, I2S_SLOT_MODE_MONO);
}
void loop() {
  size_t got = mic.readBytes((char *)rec, sizeof(rec));
  double sum = 0;
  for (int i = 0; i < 1600; i++) sum += (double)rec[i] * rec[i];
  Serial.printf("got %u rms %d\\n", (unsigned)got, (int)sqrt(sum / 1600));
}`;

/** Ways to play audio an API returns, with the licences that matter (also in docs/esp32-peripherals.md). */
export const API_AUDIO_NOTE =
  "Playing what an API returns: ask it for raw PCM (16 kHz, 16-bit, mono; 'audio/L16', 'pcm_16000') or WAV and stream the bytes into i2s.write() as they arrive (the example; HTTP/1.0 so no chunk framing ends up in the audio; a WebSocket works the same with the WebSockets library, LGPL-2.1). Buffer a few hundred ms before playing if the network is slow. MP3 on the device: ESP_I2S's playMP3() works (it decodes with libhelix-mp3, prebuilt in arduino-esp32 3.x, RealNetworks RPSL/RCSL: keep its notices); minimp3 (CC0, one header) is the decoder to bundle in your own code. ESP32-audioI2S, ESP8266Audio and arduino-audio-tools are GPL-3.0 (shipping them makes the firmware GPL); Jumper ships none of them.";

export const AUDIO_HINTS: Record<string, Usage> = {
  max98357a: {
    wiring:
      "Plays the samples the board sends over I2S (ESP32, ESP32-S3, ESP32-C3; other boards have no I2S in Jumper). VIN → 5V / VBUS (or the battery after its switch: 3.7 V works, a bit quieter), GND → GND, BCLK, LRC (word select) and DIN → three free GPIOs passed to i2s.setPins(bclk, lrc, din) (XIAO ESP32-S3: D1 / D2 / D3). SD floating or to VIN = left / mono, to GND = off. GAIN floating = 9 dB (to VIN 6 dB, to GND 12 dB). OUT+ / OUT- → speaker + / -: bridge-tied, neither is ground. A 0.5 W speaker takes about half of full scale at 5 V: scale the samples (check_design says how far). " +
      API_AUDIO_NOTE,
    connect: ["amp.VIN -> xiao.5V", "amp.GND -> xiao.GND", "amp.BCLK -> xiao.GPIO2", "amp.LRC -> xiao.GPIO3", "amp.DIN -> xiao.GPIO4", "amp.OUT+ -> spk.+", "amp.OUT- -> spk.-"],
    example: AMP_EXAMPLE,
    controls:
      'State: playing (audio in the last 100 ms), level (loudness 0..1 after gain), sampleRate, outVrms (across the speaker), blocks. A run reports "audio" when the board played anything and the page plays that sound (WebAudio; never in tests). Scenarios: {"expect_part": "amp.playing", "value": true}, {"expect_part": "amp.level", "op": ">", "value": 0.1}. The I2S stream is emulated in QEMU (DMA, sample rate, 8 to 48 kHz, 16/24/32 bit); the amp\'s sound quality is not.',
  },
  inmp441: {
    wiring:
      "An I2S microphone the board records from (ESP32, ESP32-S3, ESP32-C3). VDD → 3V3 (never 5 V), GND → GND, SCK → the I2S BCLK GPIO, WS → the WS GPIO, SD → the data-in GPIO, L/R → GND (left slot) or 3V3 (right). Pass them to i2s.setPins(bclk, ws, -1, din). In Jumper it also stands in for a PDM microphone (the XIAO ESP32-S3 Sense's onboard one: setPinsPdmRx(42, 41), I2S_MODE_PDM_RX): whatever source sits on the board's I2S bus answers the reads.",
    connect: ["mic.VDD -> xiao.3V3", "mic.GND -> xiao.GND", "mic.SCK -> xiao.GPIO2", "mic.WS -> xiao.GPIO3", "mic.SD -> xiao.GPIO4", "mic.L/R -> xiao.GND"],
    example: MIC_EXAMPLE,
    controls:
      'What it hears: set_part_property mic sound silence | tone | noise | clip, spl_db (94 dB SPL = -26 dBFS), tone_hz, clip_b64 (16-bit mono PCM at 16 kHz, base64). State: listening, levelDbfs, reads.',
  },
};
