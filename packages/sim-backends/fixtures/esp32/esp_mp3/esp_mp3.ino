// Round 13 (audio): MP3 decoded ON the device and played through I2S, the way a sketch plays an MP3
// an API returned. arduino-esp32 3.x's ESP_I2S::playMP3() decodes with libhelix-mp3 (RealNetworks
// RPSL / RCSL, prebuilt in the core), so this sketch is built at test time and its image is not
// committed (Fabwright ships no RPSL code). minimp3 (CC0) is the decoder to bundle in your own code.
#include <ESP_I2S.h>
#include "tone_mp3.h"

#if CONFIG_IDF_TARGET_ESP32S3 || CONFIG_IDF_TARGET_ESP32C3
const int BCLK = 2, WS = 3, DOUT = 4;
#else
const int BCLK = 26, WS = 25, DOUT = 22;
#endif

I2SClass out;

void setup() {
  Serial.begin(115200);
  out.setPins(BCLK, WS, DOUT);
  Serial.printf("mp3 begin %d\n", out.begin(I2S_MODE_STD, 16000, I2S_DATA_BIT_WIDTH_16BIT, I2S_SLOT_MODE_MONO));
  uint32_t t0 = millis();
  bool ok = out.playMP3(tone_mp3, sizeof(tone_mp3));
  Serial.printf("mp3 played %d in %lu ms\n", ok, millis() - t0);
  delay(300);
  Serial.println("mp3 done");
}

void loop() {
  delay(100);
}
