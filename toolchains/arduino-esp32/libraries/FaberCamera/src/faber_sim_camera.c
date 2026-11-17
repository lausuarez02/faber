// Faber camera shim (simulation builds only), Apache-2.0.
//
// QEMU models neither the ESP32's I2S camera mode nor the ESP32-S3's LCD_CAM (DVP) block, so the
// official esp32-camera driver cannot capture anything in the emulator. In a simulation build of a
// sketch that includes esp_camera.h, Faber wraps the driver's API at link time (each __wrap_ below
// is a -Wl,--wrap target) and this file takes frames from Faber's camera port in the emulator
// (QEMU patch 0006, hw/misc/faber_camera.c): Faber renders the frame (a test image, a still the
// person dropped in, their webcam) at the size and format the sketch asked for and encodes it (JPEG,
// RGB565, grayscale, YUV422, RGB888). The real-device build links Espressif's driver unchanged.
//
// What behaves like the real driver: camera_config_t pins checked against the circuit (the camera
// must be wired to those GPIOs), sensor detection (PID, the sensor's largest frame size), frame
// buffers allocated at init in PSRAM or DRAM (ESP_ERR_NO_MEM when they do not fit, as on the board),
// fb_count buffers that must be returned, a JPEG larger than its buffer dropped (FB-OVF), capture
// time per frame size, sensor_t settings (frame size, format, quality, mirror / flip, brightness,
// contrast, saturation, special effects, colour bars) applied to the frames.
// Not emulated: the DVP bus timing and DMA, XCLK on its pin, SCCB register access (get_reg / set_reg
// keep values but change nothing), auto exposure / white balance dynamics, sensor noise, NVS save.
#include <string.h>
#include <stdlib.h>
#include <sys/time.h>
#include "sdkconfig.h"
#include "freertos/FreeRTOS.h"
#include "freertos/task.h"
#include "freertos/semphr.h"
#include "esp_err.h"
#include "esp_log.h"
#include "esp_heap_caps.h"
#include "esp_timer.h"
#include "esp_camera.h"
#include "sensor.h"

#define TAG "camera"
#define JCAM_BASE 0x21100000u
#define JCAM_REG(off) (*(volatile uint32_t *)(JCAM_BASE + (off)))
#define JCAM_ID 0x4d41434au
#define JCAM_WINDOW_REG 0x08
#define JCAM_ARG(i) (0x10 + 4 * (i))
#define JCAM_CMD 0x30
#define JCAM_RES(i) (0x40 + 4 * (i))

enum { JCAM_INIT = 1, JCAM_CAPTURE = 2, JCAM_DEINIT = 3 };
// Faber's answer codes (RES0).
enum { JCAM_OK = 0, JCAM_NOT_DETECTED = 1, JCAM_NOT_SUPPORTED = 2, JCAM_BAD_SIZE = 3, JCAM_NO_FABER = 0xffffffffu };

#define MAX_FB 4
#define FB_GET_TIMEOUT_MS 4000

typedef struct {
  camera_fb_t fb;
  size_t cap;
  bool out;  // given to the sketch, not returned yet
} jcam_fb_t;

static bool s_inited;
static camera_config_t s_cfg;
static sensor_t s_sensor;
static jcam_fb_t s_fbs[MAX_FB];
static size_t s_fb_count;
static framesize_t s_max_size = FRAMESIZE_UXGA;
static bool s_psram_mode = true;
static SemaphoreHandle_t s_lock;
static int s_regs[8];

static uint32_t jcam_cmd(uint32_t cmd, const uint32_t args[8]) {
  for (int i = 0; i < 8; i++) JCAM_REG(JCAM_ARG(i)) = args[i];
  JCAM_REG(JCAM_CMD) = cmd;
  return JCAM_REG(JCAM_RES(0));
}

static bool jcam_present(void) { return JCAM_REG(0x00) == JCAM_ID; }

static uint32_t pin8(int pin) { return pin < 0 || pin > 254 ? 0xffu : (uint32_t)pin; }

static size_t fb_size_for(pixformat_t fmt, framesize_t size) {
  size_t w = resolution[size].width, h = resolution[size].height;
  switch (fmt) {
    case PIXFORMAT_JPEG: return s_cfg.jpeg_buffer_size ? s_cfg.jpeg_buffer_size : w * h / 5;
    case PIXFORMAT_GRAYSCALE: return w * h;
    case PIXFORMAT_RGB888: return w * h * 3;
    case PIXFORMAT_YUV420: return w * h * 3 / 2;
    default: return w * h * 2;
  }
}

static void free_fbs(void) {
  for (size_t i = 0; i < MAX_FB; i++) {
    if (s_fbs[i].fb.buf) heap_caps_free(s_fbs[i].fb.buf);
    memset(&s_fbs[i], 0, sizeof(s_fbs[i]));
  }
  s_fb_count = 0;
}

static esp_err_t alloc_fbs(void) {
  size_t n = s_cfg.fb_count < 1 ? 1 : (s_cfg.fb_count > MAX_FB ? MAX_FB : s_cfg.fb_count);
  size_t size = fb_size_for(s_sensor.pixformat, s_sensor.status.framesize);
  bool psram = s_cfg.fb_location == CAMERA_FB_IN_PSRAM && s_psram_mode;
#ifdef FABER_SIM_PSRAM_FALLBACK
  // The board has PSRAM, but the emulator does not (esp_psram_init fails in QEMU): frame buffers go
  // in internal RAM in the simulator only, so a sketch written for the board still runs.
  if (psram && heap_caps_get_total_size(MALLOC_CAP_SPIRAM) == 0) {
    static bool told;
    if (!told) ESP_LOGW(TAG, "Faber simulation: the board's PSRAM is not emulated, frame buffers are in internal RAM");
    told = true;
    psram = false;
  }
#endif
  free_fbs();
  for (size_t i = 0; i < n; i++) {
    uint8_t *buf = heap_caps_malloc(size, psram ? MALLOC_CAP_SPIRAM : (MALLOC_CAP_INTERNAL | MALLOC_CAP_8BIT));
    if (!buf) {
      ESP_LOGE("cam_hal", "frame buffer malloc failed (%u bytes in %s; %u free there)", (unsigned)size, psram ? "PSRAM" : "internal DRAM",
               (unsigned)heap_caps_get_free_size(psram ? MALLOC_CAP_SPIRAM : MALLOC_CAP_INTERNAL));
      if (psram && heap_caps_get_total_size(MALLOC_CAP_SPIRAM) == 0) ESP_LOGE("cam_hal", "this build has no PSRAM: enable it (Tools > PSRAM) or use CAMERA_FB_IN_DRAM with a small frame");
      free_fbs();
      return ESP_ERR_NO_MEM;
    }
    s_fbs[i].fb.buf = buf;
    s_fbs[i].cap = size;
  }
  s_fb_count = n;
  return ESP_OK;
}

static int st_set_framesize(sensor_t *s, framesize_t size) {
  if (size >= FRAMESIZE_INVALID || size > s_max_size) return -1;
  s->status.framesize = size;
  if (s_inited && fb_size_for(s->pixformat, size) > s_fbs[0].cap && s->pixformat != PIXFORMAT_JPEG) {
    ESP_LOGW(TAG, "frame size %ux%u is larger than the frame buffers allocated at init; frames will be dropped", resolution[size].width, resolution[size].height);
  }
  return 0;
}
static int st_set_pixformat(sensor_t *s, pixformat_t f) {
  if (f != PIXFORMAT_JPEG && f != PIXFORMAT_RGB565 && f != PIXFORMAT_GRAYSCALE && f != PIXFORMAT_YUV422 && f != PIXFORMAT_RGB888) return -1;
  s->pixformat = f;
  return 0;
}
static int st_set_quality(sensor_t *s, int q) { s->status.quality = q < 0 ? 0 : (q > 63 ? 63 : q); return 0; }
static int clamp2(int v) { return v < -2 ? -2 : (v > 2 ? 2 : v); }
static int st_set_contrast(sensor_t *s, int v) { s->status.contrast = clamp2(v); return 0; }
static int st_set_brightness(sensor_t *s, int v) { s->status.brightness = clamp2(v); return 0; }
static int st_set_saturation(sensor_t *s, int v) { s->status.saturation = clamp2(v); return 0; }
static int st_set_sharpness(sensor_t *s, int v) { s->status.sharpness = clamp2(v); return 0; }
static int st_set_denoise(sensor_t *s, int v) { s->status.denoise = v; return 0; }
static int st_set_gainceiling(sensor_t *s, gainceiling_t v) { s->status.gainceiling = v; return 0; }
static int st_set_colorbar(sensor_t *s, int v) { s->status.colorbar = !!v; return 0; }
static int st_set_whitebal(sensor_t *s, int v) { s->status.awb = !!v; return 0; }
static int st_set_gain_ctrl(sensor_t *s, int v) { s->status.agc = !!v; return 0; }
static int st_set_exposure_ctrl(sensor_t *s, int v) { s->status.aec = !!v; return 0; }
static int st_set_hmirror(sensor_t *s, int v) { s->status.hmirror = !!v; return 0; }
static int st_set_vflip(sensor_t *s, int v) { s->status.vflip = !!v; return 0; }
static int st_set_aec2(sensor_t *s, int v) { s->status.aec2 = !!v; return 0; }
static int st_set_awb_gain(sensor_t *s, int v) { s->status.awb_gain = !!v; return 0; }
static int st_set_agc_gain(sensor_t *s, int v) { s->status.agc_gain = v; return 0; }
static int st_set_aec_value(sensor_t *s, int v) { s->status.aec_value = v; return 0; }
static int st_set_special_effect(sensor_t *s, int v) { if (v < 0 || v > 6) return -1; s->status.special_effect = v; return 0; }
static int st_set_wb_mode(sensor_t *s, int v) { s->status.wb_mode = v; return 0; }
static int st_set_ae_level(sensor_t *s, int v) { s->status.ae_level = clamp2(v); return 0; }
static int st_set_dcw(sensor_t *s, int v) { s->status.dcw = !!v; return 0; }
static int st_set_bpc(sensor_t *s, int v) { s->status.bpc = !!v; return 0; }
static int st_set_wpc(sensor_t *s, int v) { s->status.wpc = !!v; return 0; }
static int st_set_raw_gma(sensor_t *s, int v) { s->status.raw_gma = !!v; return 0; }
static int st_set_lenc(sensor_t *s, int v) { s->status.lenc = !!v; return 0; }
static int st_init_status(sensor_t *s) { return 0; }
static int st_reset(sensor_t *s) { return 0; }
static int st_get_reg(sensor_t *s, int reg, int mask) { return s_regs[reg & 7] & mask; }
static int st_set_reg(sensor_t *s, int reg, int mask, int value) {
  static bool told;
  if (!told) ESP_LOGW(TAG, "set_reg: sensor registers are not emulated in Faber (the value is kept, the image does not change)");
  told = true;
  s_regs[reg & 7] = (s_regs[reg & 7] & ~mask) | (value & mask);
  return 0;
}
static int st_set_res_raw(sensor_t *s, int a, int b, int c, int d, int e, int f, int g, int h, int i, int j, bool k, bool l) { return -1; }
static int st_set_pll(sensor_t *s, int a, int b, int c, int d, int e, int f, int g, int h) { return -1; }
static int st_set_xclk(sensor_t *s, int timer, int xclk) { s->xclk_freq_hz = xclk * 1000000; return 0; }

static void sensor_setup(uint32_t pid, uint32_t mid, uint32_t ver, uint32_t addr) {
  memset(&s_sensor, 0, sizeof(s_sensor));
  s_sensor.id.PID = (uint16_t)pid;
  s_sensor.id.MIDH = (mid >> 8) & 0xff;
  s_sensor.id.MIDL = mid & 0xff;
  s_sensor.id.VER = (uint8_t)ver;
  s_sensor.slv_addr = (uint8_t)addr;
  s_sensor.pixformat = s_cfg.pixel_format;
  s_sensor.xclk_freq_hz = s_cfg.xclk_freq_hz;
  s_sensor.status.framesize = s_cfg.frame_size;
  s_sensor.status.quality = s_cfg.jpeg_quality;
  s_sensor.status.awb = s_sensor.status.awb_gain = s_sensor.status.aec = s_sensor.status.agc = 1;
  s_sensor.status.bpc = 0;
  s_sensor.status.wpc = s_sensor.status.raw_gma = s_sensor.status.lenc = s_sensor.status.dcw = 1;
  s_sensor.init_status = st_init_status;
  s_sensor.reset = st_reset;
  s_sensor.set_pixformat = st_set_pixformat;
  s_sensor.set_framesize = st_set_framesize;
  s_sensor.set_contrast = st_set_contrast;
  s_sensor.set_brightness = st_set_brightness;
  s_sensor.set_saturation = st_set_saturation;
  s_sensor.set_sharpness = st_set_sharpness;
  s_sensor.set_denoise = st_set_denoise;
  s_sensor.set_gainceiling = st_set_gainceiling;
  s_sensor.set_quality = st_set_quality;
  s_sensor.set_colorbar = st_set_colorbar;
  s_sensor.set_whitebal = st_set_whitebal;
  s_sensor.set_gain_ctrl = st_set_gain_ctrl;
  s_sensor.set_exposure_ctrl = st_set_exposure_ctrl;
  s_sensor.set_hmirror = st_set_hmirror;
  s_sensor.set_vflip = st_set_vflip;
  s_sensor.set_aec2 = st_set_aec2;
  s_sensor.set_awb_gain = st_set_awb_gain;
  s_sensor.set_agc_gain = st_set_agc_gain;
  s_sensor.set_aec_value = st_set_aec_value;
  s_sensor.set_special_effect = st_set_special_effect;
  s_sensor.set_wb_mode = st_set_wb_mode;
  s_sensor.set_ae_level = st_set_ae_level;
  s_sensor.set_dcw = st_set_dcw;
  s_sensor.set_bpc = st_set_bpc;
  s_sensor.set_wpc = st_set_wpc;
  s_sensor.set_raw_gma = st_set_raw_gma;
  s_sensor.set_lenc = st_set_lenc;
  s_sensor.get_reg = st_get_reg;
  s_sensor.set_reg = st_set_reg;
  s_sensor.set_res_raw = st_set_res_raw;
  s_sensor.set_pll = st_set_pll;
  s_sensor.set_xclk = st_set_xclk;
}

static void delay_us(uint32_t us) {
  if (!us) return;
  TickType_t t = pdMS_TO_TICKS((us + 999) / 1000);
  vTaskDelay(t ? t : 1);
}

esp_err_t __wrap_esp_camera_init(const camera_config_t *config) {
  if (!config) return ESP_ERR_INVALID_ARG;
  if (s_inited) {
    ESP_LOGE(TAG, "Camera already initialized");
    return ESP_ERR_INVALID_STATE;
  }
  if (!jcam_present()) {
    ESP_LOGE(TAG, "Faber: this emulator has no camera port. Fix: run `faber setup esp32` again (it builds the emulator with the camera), then Run.");
    return ESP_ERR_NOT_FOUND;
  }
  if (!s_lock) s_lock = xSemaphoreCreateMutex();
  s_cfg = *config;
  if (s_cfg.frame_size >= FRAMESIZE_INVALID) return ESP_ERR_INVALID_ARG;
  uint32_t a[8] = {
    pin8(config->pin_pwdn) | pin8(config->pin_reset) << 8 | pin8(config->pin_xclk) << 16 | pin8(config->pin_sccb_sda) << 24,
    pin8(config->pin_sccb_scl) | pin8(config->pin_vsync) << 8 | pin8(config->pin_href) << 16 | pin8(config->pin_pclk) << 24,
    pin8(config->pin_d0) | pin8(config->pin_d1) << 8 | pin8(config->pin_d2) << 16 | pin8(config->pin_d3) << 24,
    pin8(config->pin_d4) | pin8(config->pin_d5) << 8 | pin8(config->pin_d6) << 16 | pin8(config->pin_d7) << 24,
    (uint32_t)config->xclk_freq_hz,
    (uint32_t)config->pixel_format | (uint32_t)config->frame_size << 8 | (uint32_t)(config->jpeg_quality & 0xff) << 16 | (uint32_t)(config->fb_count & 0xff) << 24,
    (uint32_t)config->fb_location | (uint32_t)config->grab_mode << 8 | (uint32_t)(config->sccb_i2c_port & 0xff) << 16,
    (uint32_t)config->jpeg_buffer_size,
  };
  uint32_t r = jcam_cmd(JCAM_INIT, a);
  if (r == JCAM_NO_FABER) {
    ESP_LOGE(TAG, "Faber: no simulator is listening on the camera port");
    return ESP_ERR_NOT_FOUND;
  }
  delay_us(JCAM_REG(JCAM_RES(6)));
  if (r == JCAM_NOT_DETECTED) {
    ESP_LOGE(TAG, "Camera probe failed with error 0x%x(ESP_ERR_NOT_FOUND)", ESP_ERR_NOT_FOUND);
    ESP_LOGE(TAG, "Faber: no camera answers on these pins (see Faber's design checks for which pins the camera is wired to)");
    return ESP_ERR_NOT_FOUND;
  }
  if (r != JCAM_OK) {
    ESP_LOGE(TAG, "Camera init failed (Faber said %u)", (unsigned)r);
    return r == JCAM_BAD_SIZE ? ESP_ERR_CAMERA_FAILED_TO_SET_FRAME_SIZE : ESP_ERR_CAMERA_NOT_SUPPORTED;
  }
  s_max_size = (framesize_t)JCAM_REG(JCAM_RES(4));
  sensor_setup(JCAM_REG(JCAM_RES(1)), JCAM_REG(JCAM_RES(2)), JCAM_REG(JCAM_RES(3)), JCAM_REG(JCAM_RES(5)));
  if (s_cfg.frame_size > s_max_size) {
    ESP_LOGE(TAG, "Failed to set frame size (the sensor's largest is %ux%u)", resolution[s_max_size].width, resolution[s_max_size].height);
    return ESP_ERR_CAMERA_FAILED_TO_SET_FRAME_SIZE;
  }
  ESP_LOGI(TAG, "Detected camera PID=0x%x (Faber simulation: frames come from Faber, not a sensor)", s_sensor.id.PID);
  esp_err_t e = alloc_fbs();
  if (e != ESP_OK) return e;
  s_inited = true;
  return ESP_OK;
}

esp_err_t __wrap_esp_camera_deinit(void) {
  if (!s_inited) return ESP_ERR_INVALID_STATE;
  uint32_t a[8] = {0};
  jcam_cmd(JCAM_DEINIT, a);
  free_fbs();
  s_inited = false;
  return ESP_OK;
}

esp_err_t __wrap_esp_camera_reconfigure(const camera_config_t *config) {
  if (s_inited) __wrap_esp_camera_deinit();
  return __wrap_esp_camera_init(config);
}

static jcam_fb_t *free_slot(void) {
  for (size_t i = 0; i < s_fb_count; i++)
    if (!s_fbs[i].out) return &s_fbs[i];
  return NULL;
}

camera_fb_t *__wrap_esp_camera_fb_get(void) {
  if (!s_inited) {
    ESP_LOGE(TAG, "Camera is not initialized");
    return NULL;
  }
  jcam_fb_t *slot = free_slot();
  if (!slot) {
    // As on the board: every buffer is still with the sketch (esp_camera_fb_return not called).
    vTaskDelay(pdMS_TO_TICKS(FB_GET_TIMEOUT_MS));
    ESP_LOGW("cam_hal", "Failed to get the frame on time! (all %u frame buffers are still out: call esp_camera_fb_return)", (unsigned)s_fb_count);
    return NULL;
  }
  const resolution_info_t *res = &resolution[s_sensor.status.framesize];
  camera_status_t *st = &s_sensor.status;
  uint32_t fx = (st->hmirror & 1) | (st->vflip & 1) << 1 | (st->colorbar & 1) << 2 | (uint32_t)(st->brightness + 2) << 4 |
                (uint32_t)(st->contrast + 2) << 8 | (uint32_t)(st->saturation + 2) << 12 | (uint32_t)(st->special_effect & 0xf) << 16 |
                (uint32_t)(st->ae_level + 2) << 20;
  uint32_t a[8] = {s_sensor.pixformat, res->width, res->height, st->quality, fx, (uint32_t)slot->cap, s_sensor.status.framesize, 0};
  xSemaphoreTake(s_lock, portMAX_DELAY);
  uint32_t r = jcam_cmd(JCAM_CAPTURE, a);
  uint32_t len = JCAM_REG(JCAM_RES(1)), w = JCAM_REG(JCAM_RES(2)), h = JCAM_REG(JCAM_RES(3)), fmt = JCAM_REG(JCAM_RES(4)), lat = JCAM_REG(JCAM_RES(5));
  int64_t t0 = esp_timer_get_time();
  if (r != JCAM_OK) {
    xSemaphoreGive(s_lock);
    ESP_LOGE("cam_hal", "capture failed (Faber said %u)", (unsigned)r);
    delay_us(lat);
    return NULL;
  }
  if (len > slot->cap) {
    xSemaphoreGive(s_lock);
    delay_us(lat);
    ESP_LOGW("cam_hal", "FB-OVF: a %u-byte frame does not fit the %u-byte frame buffer (raise jpeg_quality's number, or set jpeg_buffer_size)", (unsigned)len, (unsigned)slot->cap);
    return NULL;
  }
  memcpy(slot->fb.buf, (const void *)JCAM_REG(JCAM_WINDOW_REG), len);
  xSemaphoreGive(s_lock);
  slot->fb.len = len;
  slot->fb.width = w;
  slot->fb.height = h;
  slot->fb.format = (pixformat_t)fmt;
  slot->fb.timestamp.tv_sec = t0 / 1000000;
  slot->fb.timestamp.tv_usec = t0 % 1000000;
  slot->out = true;
  delay_us(lat);
  return &slot->fb;
}

void __wrap_esp_camera_fb_return(camera_fb_t *fb) {
  for (size_t i = 0; i < s_fb_count; i++)
    if (&s_fbs[i].fb == fb) s_fbs[i].out = false;
}

void __wrap_esp_camera_return_all(void) {
  for (size_t i = 0; i < s_fb_count; i++) s_fbs[i].out = false;
}

bool __wrap_esp_camera_available_frames(void) { return s_inited && free_slot() != NULL; }

sensor_t *__wrap_esp_camera_sensor_get(void) { return s_inited ? &s_sensor : NULL; }

esp_err_t __wrap_esp_camera_save_to_nvs(const char *key) {
  ESP_LOGW(TAG, "esp_camera_save_to_nvs is not emulated in Faber");
  return ESP_ERR_NOT_SUPPORTED;
}

esp_err_t __wrap_esp_camera_load_from_nvs(const char *key) {
  ESP_LOGW(TAG, "esp_camera_load_from_nvs is not emulated in Faber");
  return ESP_ERR_NOT_SUPPORTED;
}

esp_err_t __wrap_esp_camera_set_psram_mode(bool enable) {
  s_psram_mode = enable;
  return ESP_OK;
}

bool __wrap_esp_camera_get_psram_mode(void) { return s_psram_mode; }
