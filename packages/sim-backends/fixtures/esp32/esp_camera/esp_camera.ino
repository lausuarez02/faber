// Round 13 camera fixture: Espressif's esp32-camera API exactly as a sketch for a XIAO ESP32-S3
// Sense (its camera pins) or an AI-Thinker ESP32-CAM (on the ESP32) uses it. In Faber's simulation build the API is wrapped and the
// frames come from Faber (a test image); on the board the same source runs the real driver.
// Prints what it captured so a test can check sizes and bytes.
#include "esp_camera.h"

static camera_config_t cfg() {
  camera_config_t c = {};
#if CONFIG_IDF_TARGET_ESP32
  // AI-Thinker ESP32-CAM pins (an OV2640 module on an ESP32)
  c.pin_pwdn = 32; c.pin_reset = -1; c.pin_xclk = 0;
  c.pin_sccb_sda = 26; c.pin_sccb_scl = 27;
  c.pin_d7 = 35; c.pin_d6 = 34; c.pin_d5 = 39; c.pin_d4 = 36;
  c.pin_d3 = 21; c.pin_d2 = 19; c.pin_d1 = 18; c.pin_d0 = 5;
  c.pin_vsync = 25; c.pin_href = 23; c.pin_pclk = 22;
#else
  // Seeed XIAO ESP32-S3 Sense pins
  c.pin_pwdn = -1; c.pin_reset = -1; c.pin_xclk = 10;
  c.pin_sccb_sda = 40; c.pin_sccb_scl = 39;
  c.pin_d7 = 48; c.pin_d6 = 11; c.pin_d5 = 12; c.pin_d4 = 14;
  c.pin_d3 = 16; c.pin_d2 = 18; c.pin_d1 = 17; c.pin_d0 = 15;
  c.pin_vsync = 38; c.pin_href = 47; c.pin_pclk = 13;
#endif
  c.xclk_freq_hz = 20000000;
  c.ledc_timer = LEDC_TIMER_0; c.ledc_channel = LEDC_CHANNEL_0;
  c.pixel_format = PIXFORMAT_JPEG;
  c.frame_size = FRAMESIZE_QVGA;
  c.jpeg_quality = 12;
  c.fb_count = 1;
  c.fb_location = CAMERA_FB_IN_PSRAM;  // as the Sense examples do; the simulator falls back to DRAM
  c.grab_mode = CAMERA_GRAB_WHEN_EMPTY;
  return c;
}

static uint32_t sum32(const uint8_t *b, size_t n) {
  uint32_t s = 0;
  for (size_t i = 0; i < n; i++) s = s * 31 + b[i];
  return s;
}

static void shot(const char *what) {
  uint32_t t0 = millis();
  camera_fb_t *fb = esp_camera_fb_get();
  uint32_t dt = millis() - t0;
  if (!fb) {
    Serial.printf("%s none %u\n", what, (unsigned)dt);
    return;
  }
  size_t mid = (fb->height / 2) * fb->width + fb->width / 2;
  unsigned px = 0;
  if (fb->format == PIXFORMAT_RGB565) px = (fb->buf[2 * mid] << 8) | fb->buf[2 * mid + 1];
  else if (fb->format == PIXFORMAT_GRAYSCALE) px = fb->buf[mid];
  Serial.printf("%s len=%u size=%ux%u fmt=%d head=%02x%02x tail=%02x%02x sum=%08x px=%04x ms=%u\n", what, (unsigned)fb->len,
                (unsigned)fb->width, (unsigned)fb->height, (int)fb->format, fb->buf[0], fb->buf[1], fb->buf[fb->len - 2],
                fb->buf[fb->len - 1], (unsigned)sum32(fb->buf, fb->len), px, (unsigned)dt);
  esp_camera_fb_return(fb);
}

void setup() {
  Serial.begin(115200);
  delay(50);
  Serial.printf("psram %d\n", psramFound() ? 1 : 0);
  camera_config_t c = cfg();
  esp_err_t err = esp_camera_init(&c);
  sensor_t *s = esp_camera_sensor_get();
  Serial.printf("cam init %d pid=%x\n", (int)err, s ? s->id.PID : 0);
  if (err != ESP_OK) return;
  shot("jpeg");
  shot("jpeg2");
  // A new pixel format needs a new init (the frame buffers are sized at init, as on the board).
  esp_camera_deinit();
  c.pixel_format = PIXFORMAT_RGB565;
  c.frame_size = FRAMESIZE_96X96;
  c.fb_location = CAMERA_FB_IN_DRAM;
  Serial.printf("reinit %d\n", (int)esp_camera_init(&c));
  s = esp_camera_sensor_get();
  shot("rgb565");
  s->set_framesize(s, FRAMESIZE_QQVGA);  // 38400 bytes: larger than the 18432-byte buffers
  shot("too-big");
  esp_camera_deinit();
  c.pixel_format = PIXFORMAT_GRAYSCALE;
  c.frame_size = FRAMESIZE_QQVGA;
  Serial.printf("reinit %d\n", (int)esp_camera_init(&c));
  s = esp_camera_sensor_get();
  s->set_vflip(s, 1);
  shot("gray");
  Serial.println("done");
}

void loop() { delay(1000); }
