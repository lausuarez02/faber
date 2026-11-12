// Round 13 (audio): I2S through arduino-esp32's ESP_I2S on any ESP chip, written for the real board.
//  1. a 1 kHz sine, 16 kHz mono 16-bit, 0.4 s (write() returns the bytes; the time it takes is the
//     DMA pacing the samples out at the sample rate)
//  2. a WAV from flash (440 Hz, 16 kHz mono 16-bit) through playWAV()
//  3. the same 1 kHz tone at 8 kHz, 22.05 kHz and 44.1 kHz, then 48 kHz stereo 32-bit (left only)
//  4. a microphone: PDM (the XIAO ESP32-S3 Sense's mic pins, GPIO42 clock / GPIO41 data) on the S3,
//     standard I2S (an INMP441) elsewhere; prints the level and the frequency it heard
#include <ESP_I2S.h>
#include "tone_wav.h"

#if CONFIG_IDF_TARGET_ESP32S3
const int BCLK = 2, WS = 3, DOUT = 4, DIN = 5;
#elif CONFIG_IDF_TARGET_ESP32C3
const int BCLK = 2, WS = 3, DOUT = 4, DIN = 5;
#else
const int BCLK = 26, WS = 25, DOUT = 22, DIN = 35;
#endif

I2SClass out;

// One sine period in a table, stepped with a 32-bit phase accumulator: cheap enough for any chip
// (the C3 has no FPU; sinf() per sample would starve the DMA there, on the chip as in the emulator).
static int16_t SINE[1024];

static size_t tone(uint32_t rate, uint32_t frames, bool stereo32) {
  size_t total = 0;
  static int32_t buf[256];
  uint32_t phase = 0, inc = (uint32_t)(((uint64_t)1000 << 32) / rate);
  uint32_t n = 0;
  while (n < frames) {
    uint32_t k = 0;
    for (; k < 128 && n < frames; k++, n++, phase += inc) {
      int16_t s = SINE[phase >> 22];
      if (stereo32) {
        buf[2 * k] = (int32_t)s << 16;  // left, half scale
        buf[2 * k + 1] = 0;             // right
      } else {
        ((int16_t *)buf)[k] = s;
      }
    }
    total += out.write((uint8_t *)buf, stereo32 ? k * 8 : k * 2);
  }
  return total;
}

void setup() {
  Serial.begin(115200);
  for (int i = 0; i < 1024; i++) SINE[i] = (int16_t)lroundf(16384.0f * sinf(2.0f * (float)PI * i / 1024.0f));
  out.setPins(BCLK, WS, DOUT);
  bool ok = out.begin(I2S_MODE_STD, 16000, I2S_DATA_BIT_WIDTH_16BIT, I2S_SLOT_MODE_MONO);
  Serial.printf("audio begin %d\n", ok);
  uint32_t t0 = millis();
  size_t n = tone(16000, 6400, false);
  Serial.printf("sine wrote %u in %lu ms\n", (unsigned)n, millis() - t0);
  delay(200);
  out.playWAV(tone_wav, sizeof(tone_wav));
  Serial.println("wav done");
  delay(200);
  const uint32_t rates[] = {8000, 22050, 44100};
  for (uint32_t r : rates) {
    out.configureTX(r, I2S_DATA_BIT_WIDTH_16BIT, I2S_SLOT_MODE_MONO);
    t0 = millis();
    n = tone(r, r / 10, false);
    Serial.printf("rate %lu wrote %u in %lu ms\n", (unsigned long)r, (unsigned)n, millis() - t0);
    delay(250);  // the DMA ring still holds up to 1440 frames: let it play out before reconfiguring
  }
  out.configureTX(48000, I2S_DATA_BIT_WIDTH_32BIT, I2S_SLOT_MODE_STEREO);
  n = tone(48000, 4800, true);
  Serial.printf("stereo32 wrote %u\n", (unsigned)n);
  delay(100);
  out.end();

  I2SClass mic;
#if CONFIG_IDF_TARGET_ESP32S3
  mic.setPinsPdmRx(42, 41);
  ok = mic.begin(I2S_MODE_PDM_RX, 16000, I2S_DATA_BIT_WIDTH_16BIT, I2S_SLOT_MODE_MONO);
#else
  mic.setPins(BCLK, WS, -1, DIN);
  ok = mic.begin(I2S_MODE_STD, 16000, I2S_DATA_BIT_WIDTH_16BIT, I2S_SLOT_MODE_MONO);
#endif
  Serial.printf("mic begin %d\n", ok);
  static int16_t rec[1600];
  mic.readBytes((char *)rec, sizeof(rec));  // settle
  size_t got = mic.readBytes((char *)rec, sizeof(rec));
  double sum = 0;
  int crossings = 0;
  for (int i = 0; i < 1600; i++) {
    sum += (double)rec[i] * rec[i];
    if (i && (rec[i - 1] < 0) != (rec[i] < 0)) crossings++;
  }
  Serial.printf("mic got %u rms=%d hz=%d\n", (unsigned)got, (int)sqrt(sum / 1600), crossings * 16000 / 1600 / 2);
  mic.end();
  Serial.println("audio done");
}

void loop() {
  delay(100);
}
