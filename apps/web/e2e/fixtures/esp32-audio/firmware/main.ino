// XIAO ESP32-S3 + MAX98357A + a 20 mm speaker: a steady 1 kHz tone at 25 % of full scale.
#include <ESP_I2S.h>
I2SClass i2s;
int16_t buf[160];
void setup() {
  Serial.begin(115200);
  i2s.setPins(D1, D2, D3);  // BCLK, LRC (WS), DIN
  if (!i2s.begin(I2S_MODE_STD, 16000, I2S_DATA_BIT_WIDTH_16BIT, I2S_SLOT_MODE_MONO)) Serial.println("i2s failed");
  for (int i = 0; i < 160; i++) buf[i] = (int16_t)(8192 * sinf(2 * PI * 1000 * i / 16000.0f));
  Serial.println("tone on");
}
void loop() {
  i2s.write((uint8_t *)buf, sizeof(buf));
}
