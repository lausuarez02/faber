// Round 13 (audio): play what an API returns. A plain WiFi.h + HTTPClient + ESP_I2S sketch written
// for the real board (no Jumper code): join Wi-Fi, GET raw 16-bit PCM and stream it into I2S as it
// arrives, then GET a WAV, read its header and stream the samples the same way. This is the shape of
// "ask a text-to-speech API, play the answer": the API's audio bytes go straight to the amplifier.
#include <WiFi.h>
#include <HTTPClient.h>
#include <ESP_I2S.h>

const int BCLK = 2, WS = 3, DOUT = 4;  // XIAO ESP32-S3 D1 / D2 / D3 -> MAX98357A BCLK / LRC / DIN
I2SClass i2s;

// Streams the body of an open GET into I2S, keeping sample alignment. Returns the bytes played.
static size_t stream(HTTPClient &http, size_t skip) {
  WiFiClient *s = http.getStreamPtr();
  int left = http.getSize();  // -1 when chunked
  static uint8_t buf[1024];
  size_t total = 0, have = 0;
  uint32_t idle = millis();
  while ((http.connected() || s->available()) && (left > 0 || left == -1) && millis() - idle < 3000) {
    size_t n = s->available();
    if (!n) {
      delay(1);
      continue;
    }
    idle = millis();
    int c = s->readBytes(buf + have, min(n, sizeof(buf) - have));
    if (left > 0) left -= c;
    have += c;
    if (skip) {  // a header to drop first (WAV)
      size_t k = min(skip, have);
      memmove(buf, buf + k, have - k);
      have -= k;
      skip -= k;
    }
    size_t even = have & ~(size_t)1;
    if (even) {
      total += i2s.write(buf, even);
      memmove(buf, buf + even, have - even);
      have -= even;
    }
  }
  return total;
}

void setup() {
  Serial.begin(115200);
  WiFi.begin("JumperNet", "hunter22-wifi");
  while (WiFi.status() != WL_CONNECTED) delay(100);
  Serial.printf("wifi ip=%s\n", WiFi.localIP().toString().c_str());
  i2s.setPins(BCLK, WS, DOUT);
  Serial.printf("i2s begin %d\n", i2s.begin(I2S_MODE_STD, 16000, I2S_DATA_BIT_WIDTH_16BIT, I2S_SLOT_MODE_MONO));

  HTTPClient http;
  // HTTP/1.0: the body arrives as plain bytes until the server closes (no chunk framing to strip;
  // HTTPClient's getStreamPtr() hands out the raw socket, so a chunked HTTP/1.1 body would carry
  // its chunk-size lines into the audio).
  http.useHTTP10(true);
  http.begin("http://audio.api.test/v1/say.pcm?text=hello");
  int code = http.GET();
  size_t n = code == 200 ? stream(http, 0) : 0;
  http.end();
  Serial.printf("pcm %d %u\n", code, (unsigned)n);
  delay(300);

  http.useHTTP10(true);
  http.begin("http://audio.api.test/v1/say.wav");
  code = http.GET();
  n = code == 200 ? stream(http, 44) : 0;
  http.end();
  Serial.printf("wav %d %u\n", code, (unsigned)n);
  delay(300);
  Serial.println("stream done");
}

void loop() {
  delay(100);
}
