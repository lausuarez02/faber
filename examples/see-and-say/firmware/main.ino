// See and say: press the button, it takes a picture, asks a vision model what it sees, asks a
// text-to-speech model to say the answer, and plays it. Built only from general parts:
//   Seeed XIAO ESP32-S3 Sense (camera on its own pins, Wi-Fi), GC9A01 round screen (SPI),
//   MAX98357A I2S amplifier + 20 mm speaker, one button.
// No API key is in this file: every call goes through the project's relay (JumperRelay.h), which
// adds the keys. In Jumper the relay is the sandbox one and the APIs are mocks / a cassette.
//
// The two calls use the OpenAI-compatible shapes most providers accept:
//   vision: POST <VISION_HOST><VISION_PATH>  {"model", "messages": [{text, image_url: data:image/jpeg;base64,...}]}
//   speech: POST <SPEECH_HOST><SPEECH_PATH>  {"model", "voice", "input", "response_format": "pcm"}
//           -> raw 16-bit mono PCM at SPEECH_RATE, streamed into I2S as it arrives.
#include <WiFi.h>
#include <HTTPClient.h>
#include <NetworkClientSecure.h>
#include <SPI.h>
#include <Adafruit_GFX.h>
#include <Adafruit_GC9A01A.h>
#include <ESP_I2S.h>
#include <ArduinoJson.h>
#include "esp_camera.h"
#include "mbedtls/base64.h"
#include "JumperRelay.h"

// ---- the APIs (change these to the provider you use; the relay's allow list must name the hosts)
#define VISION_HOST "api.vision.example"
#define VISION_PATH "/v1/chat/completions"
#define VISION_MODEL "your-vision-model"
#define PROMPT "You are a cheeky little keychain. In one short sentence, roast what you see."
#define SPEECH_HOST "api.speech.example"
#define SPEECH_PATH "/v1/audio/speech"
#define SPEECH_MODEL "your-tts-model"
#define SPEECH_VOICE "alloy"
#define SPEECH_RATE 24000
#define VOLUME 0.5f  // the 0.5 W speaker on 5 V: keep samples at or below ~57 % (check_design)

// ---- pins (XIAO labels in brackets; the camera uses the Sense board's own GPIOs)
const int BUTTON = 1;                         // [D0] to GND, INPUT_PULLUP
const int I2S_BCLK = 2, I2S_LRC = 3, I2S_DIN = 4;  // [D1] [D2] [D3] -> MAX98357A
// D6 / D7 (GPIO43 / 44) stay free: they are UART0, which carries Serial in Jumper's simulation build.
const int TFT_SCK = 7, TFT_MOSI = 9, TFT_CS = 6, TFT_DC = 5, TFT_RST = -1;  // [D8] [D10] [D5] [D4]; RST tied to 3V3

Adafruit_GC9A01A tft(TFT_CS, TFT_DC, TFT_RST);
I2SClass i2s;
NetworkClientSecure tls;

static bool initCamera() {
  camera_config_t c = {};
  c.pin_pwdn = -1; c.pin_reset = -1; c.pin_xclk = 10;
  c.pin_sccb_sda = 40; c.pin_sccb_scl = 39;
  c.pin_d7 = 48; c.pin_d6 = 11; c.pin_d5 = 12; c.pin_d4 = 14;
  c.pin_d3 = 16; c.pin_d2 = 18; c.pin_d1 = 17; c.pin_d0 = 15;
  c.pin_vsync = 38; c.pin_href = 47; c.pin_pclk = 13;
  c.xclk_freq_hz = 20000000;
  c.ledc_timer = LEDC_TIMER_0; c.ledc_channel = LEDC_CHANNEL_0;
  c.pixel_format = PIXFORMAT_JPEG;
  c.frame_size = FRAMESIZE_QVGA;  // 320x240 is plenty for a vision model and keeps the upload small
  c.jpeg_quality = 14;
  c.fb_count = 1;
  c.fb_location = CAMERA_FB_IN_PSRAM;
  c.grab_mode = CAMERA_GRAB_LATEST;
  esp_err_t err = esp_camera_init(&c);
  if (err != ESP_OK) Serial.printf("camera init failed 0x%x\n", err);
  return err == ESP_OK;
}

static void face(const char *mood) {
  tft.fillScreen(GC9A01A_BLACK);
  int dy = strcmp(mood, "thinking") == 0 ? -18 : 0;
  tft.fillCircle(80, 110 + dy, 26, GC9A01A_WHITE);
  tft.fillCircle(160, 110 + dy, 26, GC9A01A_WHITE);
  tft.fillCircle(80, 114 + dy, 12, GC9A01A_BLACK);
  tft.fillCircle(160, 114 + dy, 12, GC9A01A_BLACK);
  if (strcmp(mood, "talking") == 0) tft.fillRoundRect(100, 160, 40, 18, 9, GC9A01A_RED);
}

static void caption(const String &text) {
  tft.fillRect(30, 180, 180, 40, GC9A01A_BLACK);
  tft.setTextColor(GC9A01A_WHITE);
  tft.setTextSize(1);
  tft.setCursor(36, 186);
  tft.print(text.substring(0, 60));
}

static void post(HTTPClient &http, const char *host, const char *path) {
  http.useHTTP10(true);  // the body arrives as plain bytes (no chunk framing to strip from audio)
  http.setTimeout(20000);
  http.begin(tls, jumperRelayUrl(host, path));
  http.addHeader(JUMPER_TOKEN_HEADER, JUMPER_DEVICE_TOKEN);
  http.addHeader("Content-Type", "application/json");
}

// Picture -> one sentence. Returns "" and prints why on failure.
static String describe(camera_fb_t *fb) {
  size_t b64len = 0;
  mbedtls_base64_encode(nullptr, 0, &b64len, fb->buf, fb->len);
  const char *head = "{\"model\":\"" VISION_MODEL "\",\"max_tokens\":60,\"messages\":[{\"role\":\"user\",\"content\":["
                     "{\"type\":\"text\",\"text\":\"" PROMPT "\"},"
                     "{\"type\":\"image_url\",\"image_url\":{\"url\":\"data:image/jpeg;base64,";
  const char *tail = "\"}}]}]}";
  size_t hl = strlen(head), tl = strlen(tail);
  uint8_t *body = (uint8_t *)ps_malloc(hl + b64len + tl + 1);
  if (!body) {
    Serial.println("vision error no-memory");
    return "";
  }
  memcpy(body, head, hl);
  size_t wrote = 0;
  mbedtls_base64_encode(body + hl, b64len, &wrote, fb->buf, fb->len);
  memcpy(body + hl + wrote, tail, tl);
  size_t n = hl + wrote + tl;

  HTTPClient http;
  post(http, VISION_HOST, VISION_PATH);
  int code = http.POST(body, n);
  free(body);
  String text;
  if (code == 200) {
    JsonDocument filter;
    filter["choices"][0]["message"]["content"] = true;
    JsonDocument doc;
    DeserializationError e = deserializeJson(doc, http.getStream(), DeserializationOption::Filter(filter));
    if (!e) text = doc["choices"][0]["message"]["content"].as<String>();
    if (e || text.length() == 0) Serial.printf("vision error bad-json %s\n", e.c_str());
  } else {
    Serial.printf("vision error %d\n", code);
  }
  http.end();
  text.trim();
  return text;
}

// Sentence -> speech, streamed into the amplifier as it arrives. Returns the bytes played.
static size_t say(const String &text) {
  JsonDocument req;
  req["model"] = SPEECH_MODEL;
  req["voice"] = SPEECH_VOICE;
  req["input"] = text;
  req["response_format"] = "pcm";
  String body;
  serializeJson(req, body);

  HTTPClient http;
  post(http, SPEECH_HOST, SPEECH_PATH);
  int code = http.POST(body);
  size_t total = 0;
  if (code == 200) {
    WiFiClient *s = http.getStreamPtr();
    int left = http.getSize();  // -1 when the API does not say
    static int16_t buf[512];
    uint8_t *raw = (uint8_t *)buf;
    size_t have = 0;
    uint32_t idle = millis();
    while ((http.connected() || s->available()) && (left > 0 || left == -1) && millis() - idle < 15000) {
      size_t a = s->available();
      if (!a) {
        delay(1);
        continue;
      }
      idle = millis();
      int c = s->readBytes(raw + have, min(a, sizeof(buf) - have));
      if (left > 0) left -= c;
      have += c;
      size_t even = have & ~(size_t)1;
      if (even) {
        for (size_t i = 0; i < even / 2; i++) buf[i] = (int16_t)(buf[i] * VOLUME);
        total += i2s.write(raw, even);
        memmove(raw, raw + even, have - even);
        have -= even;
      }
    }
  } else {
    Serial.printf("speech error %d\n", code);
  }
  http.end();
  return total;
}

void setup() {
  Serial.begin(115200);
  pinMode(BUTTON, INPUT_PULLUP);
  SPI.begin(TFT_SCK, -1, TFT_MOSI, TFT_CS);
  tft.begin();
  face("idle");
  i2s.setPins(I2S_BCLK, I2S_LRC, I2S_DIN);
  if (!i2s.begin(I2S_MODE_STD, SPEECH_RATE, I2S_DATA_BIT_WIDTH_16BIT, I2S_SLOT_MODE_MONO)) Serial.println("i2s failed");
  if (!initCamera()) return;
  if (!jumperRelayReady()) {
    Serial.println(jumperRelayWhy());
    caption("no relay: see README");
    return;
  }
  WiFi.begin(JUMPER_WIFI_SSID, JUMPER_WIFI_PASSWORD);
  for (int i = 0; i < 150 && WiFi.status() != WL_CONNECTED; i++) delay(100);
  if (WiFi.status() != WL_CONNECTED) {
    Serial.println("wifi failed");
    caption("no wifi");
    return;
  }
  tls.setCACert(JUMPER_RELAY_ROOT_CA);
  Serial.println("ready");
}

void loop() {
  static int last = HIGH;
  int now = digitalRead(BUTTON);
  bool pressed = last == HIGH && now == LOW;
  last = now;
  if (!pressed) {
    delay(10);
    return;
  }
  camera_fb_t *fb = esp_camera_fb_get();
  if (!fb) {
    Serial.println("no frame");
    return;
  }
  Serial.printf("photo %u bytes %ux%u\n", (unsigned)fb->len, (unsigned)fb->width, (unsigned)fb->height);
  face("thinking");
  String text = describe(fb);
  esp_camera_fb_return(fb);
  if (text.length() == 0) {
    face("idle");
    caption("hmm, no idea");
    return;
  }
  Serial.printf("said: %s\n", text.c_str());
  face("talking");
  caption(text);
  size_t n = say(text);
  Serial.printf("played %u bytes\n", (unsigned)n);
  face("idle");
}
