// Faber deep-sleep shim (simulation builds only), MIT.
//
// QEMU does not model the ESP32's RTC sleep controller, so esp_deep_sleep_start() cannot sleep and
// wake in the emulator. In a simulation build of a sketch that deep-sleeps, Faber wraps the sleep
// API at link time (each __wrap_ below is a -Wl,--wrap target):
//
//  - the wake-up sources the sketch arms (timer, ext0, ext1, the C3 / C6 GPIO wake-up) are noted;
//  - esp_deep_sleep_start() saves what the chip keeps through deep sleep (RTC memory: every
//    RTC_DATA_ATTR / RTC_NOINIT_ATTR variable, and the system time) in a record in the last 8 KB of
//    flash, prints one line on the console ("[faber:sleep] {...}") and stops;
//  - Faber stops running the firmware (virtual time then passes as fast as the circuit allows),
//    wakes it on the timer or when a wake pin reaches its level, writes the wake cause and how long
//    it slept into that record, and reboots the board with its flash kept;
//  - at boot (a constructor, before setup()) the record is read back: RTC memory is restored, the
//    clock moved on by the time slept, and esp_sleep_get_wakeup_cause() / esp_reset_reason() /
//    esp_sleep_get_ext1_wakeup_status() / esp_sleep_get_gpio_wakeup_status() answer as on the chip.
//
// Not emulated: the RTC slow clock's drift (the timer is exact), the ULP coprocessor, touch-pad
// wake-up, RTC peripherals powered on during sleep, the boot time after a wake (QEMU boots from
// the start), the sleep current (estimate_power has the datasheet figures).
#include <string.h>
#include <stdint.h>
#include <stdio.h>
#include <sys/time.h>
#include "sdkconfig.h"
#include "soc/soc_caps.h"
#include "esp_err.h"
#include "esp_sleep.h"
#include "esp_system.h"
#include "esp_flash.h"
#include "esp_rom_sys.h"
#include "freertos/FreeRTOS.h"
#include "freertos/task.h"

#define JSLP_MAGIC 0x504c534au /* "JSLP" */
#define JSLP_VERSION 1u
#define JSLP_REGION 8192u
#define JSLP_ASLEEP 1u
#define JSLP_WOKEN 2u

// The record's header: Faber (packages/sim-backends/src/qemu-esp/sleep-record.ts) patches state,
// cause, wake_gpio and slept_us at these offsets. Keep the two in step.
typedef struct {
  uint32_t magic;      // 0
  uint32_t version;    // 4
  uint32_t state;      // 8  JSLP_ASLEEP (written here) / JSLP_WOKEN (written by Faber)
  uint32_t cause;      // 12 esp_sleep_source_t of the wake (Faber)
  int32_t wake_gpio;   // 16 the GPIO that woke it, or -1 (Faber)
  uint32_t pad;        // 20
  uint64_t slept_us;   // 24 how long it slept (Faber)
  int64_t tv_sec;      // 32 system time when it went to sleep
  int32_t tv_usec;     // 40
  uint32_t n_regions;  // 44
  uint32_t len[4];     // 48 bytes saved per RTC region
} jslp_header_t;       // 64 bytes

extern char _rtc_data_start __attribute__((weak));
extern char _rtc_data_end __attribute__((weak));
extern char _rtc_bss_start __attribute__((weak));
extern char _rtc_bss_end __attribute__((weak));
extern char _rtc_noinit_start __attribute__((weak));
extern char _rtc_noinit_end __attribute__((weak));
extern char _rtc_force_slow_start __attribute__((weak));
extern char _rtc_force_slow_end __attribute__((weak));

static void region(int i, char **start, size_t *len) {
  char *s = 0, *e = 0;
  if (i == 0) { s = &_rtc_data_start; e = &_rtc_data_end; }
  if (i == 1) { s = &_rtc_bss_start; e = &_rtc_bss_end; }
  if (i == 2) { s = &_rtc_noinit_start; e = &_rtc_noinit_end; }
  if (i == 3) { s = &_rtc_force_slow_start; e = &_rtc_force_slow_end; }
  *start = s;
  *len = (s && e && e > s) ? (size_t)(e - s) : 0;
}

static uint64_t s_timer_us;
static int s_ext0_gpio = -1, s_ext0_level;
static uint64_t s_ext1_mask;
static int s_ext1_mode;
static uint64_t s_gpio_mask;
static uint64_t s_gpio_high; // pins of s_gpio_mask that wake on HIGH (the rest wake on LOW)
static int s_woke;
static uint32_t s_cause;
static int s_wake_gpio = -1;

static uint32_t record_addr(void) {
  uint32_t size = 0;
  if (esp_flash_get_size(NULL, &size) != ESP_OK || size < 2 * JSLP_REGION) return 0;
  return size - JSLP_REGION;
}

// ---------------------------------------------------------------- what the sketch arms

esp_err_t __real_esp_sleep_enable_timer_wakeup(uint64_t time_in_us);
esp_err_t __wrap_esp_sleep_enable_timer_wakeup(uint64_t time_in_us) {
  s_timer_us = time_in_us;
  return __real_esp_sleep_enable_timer_wakeup(time_in_us);
}

#if SOC_PM_SUPPORT_EXT0_WAKEUP
esp_err_t __real_esp_sleep_enable_ext0_wakeup(gpio_num_t gpio_num, int level);
esp_err_t __wrap_esp_sleep_enable_ext0_wakeup(gpio_num_t gpio_num, int level) {
  s_ext0_gpio = gpio_num;
  s_ext0_level = level ? 1 : 0;
  return __real_esp_sleep_enable_ext0_wakeup(gpio_num, level);
}
#endif

#if SOC_PM_SUPPORT_EXT1_WAKEUP
esp_err_t __real_esp_sleep_enable_ext1_wakeup(uint64_t io_mask, esp_sleep_ext1_wakeup_mode_t level_mode);
esp_err_t __wrap_esp_sleep_enable_ext1_wakeup(uint64_t io_mask, esp_sleep_ext1_wakeup_mode_t level_mode) {
  s_ext1_mask = io_mask;
  s_ext1_mode = (int)level_mode;
  return __real_esp_sleep_enable_ext1_wakeup(io_mask, level_mode);
}
#endif

#if SOC_GPIO_SUPPORT_DEEPSLEEP_WAKEUP
esp_err_t __real_esp_deep_sleep_enable_gpio_wakeup(uint64_t gpio_pin_mask, esp_deepsleep_gpio_wake_up_mode_t mode);
esp_err_t __wrap_esp_deep_sleep_enable_gpio_wakeup(uint64_t gpio_pin_mask, esp_deepsleep_gpio_wake_up_mode_t mode) {
  // As in ESP-IDF: each call adds its pins with their own level, so a sketch may arm one pin to wake
  // on HIGH and another on LOW with two calls (a pin armed again takes the newer level).
  esp_err_t err = __real_esp_deep_sleep_enable_gpio_wakeup(gpio_pin_mask, mode);
  if (err != ESP_OK) return err;
  s_gpio_mask |= gpio_pin_mask;
  if (mode == ESP_GPIO_WAKEUP_GPIO_HIGH) s_gpio_high |= gpio_pin_mask;
  else s_gpio_high &= ~gpio_pin_mask;
  return err;
}
#endif

esp_err_t __real_esp_sleep_disable_wakeup_source(esp_sleep_source_t source);
esp_err_t __wrap_esp_sleep_disable_wakeup_source(esp_sleep_source_t source) {
  if (source == ESP_SLEEP_WAKEUP_TIMER || source == ESP_SLEEP_WAKEUP_ALL) s_timer_us = 0;
  if (source == ESP_SLEEP_WAKEUP_EXT0 || source == ESP_SLEEP_WAKEUP_ALL) s_ext0_gpio = -1;
  if (source == ESP_SLEEP_WAKEUP_EXT1 || source == ESP_SLEEP_WAKEUP_ALL) s_ext1_mask = 0;
  if (source == ESP_SLEEP_WAKEUP_GPIO || source == ESP_SLEEP_WAKEUP_ALL) s_gpio_mask = s_gpio_high = 0;
  return __real_esp_sleep_disable_wakeup_source(source);
}

// ---------------------------------------------------------------- going to sleep

static void pins_json(char *out, size_t n, const char **src, int *any) {
  size_t k = 0;
  *src = "";
  *any = 1;
  k += snprintf(out + k, n - k, "[");
  int first = 1;
  if (s_ext0_gpio >= 0) {
    k += snprintf(out + k, n - k, "{\"gpio\":%d,\"level\":%d}", s_ext0_gpio, s_ext0_level);
    first = 0;
    *src = "ext0";
  }
  for (int g = 0; g < 64 && k < n - 32; g++) {
    if (s_ext1_mask & (1ULL << g)) {
      // ESP32: 0 = ALL_LOW, 1 = ANY_HIGH; the S3 and later: 0 = ANY_LOW, 1 = ANY_HIGH
      int level = s_ext1_mode ? 1 : 0;
      k += snprintf(out + k, n - k, "%s{\"gpio\":%d,\"level\":%d}", first ? "" : ",", g, level);
      first = 0;
      *src = "ext1";
#if CONFIG_IDF_TARGET_ESP32
      if (!s_ext1_mode) *any = 0;
#endif
    }
    if (s_gpio_mask & (1ULL << g)) {
      k += snprintf(out + k, n - k, "%s{\"gpio\":%d,\"level\":%d}", first ? "" : ",", g, (s_gpio_high & (1ULL << g)) ? 1 : 0);
      first = 0;
      *src = "gpio";
    }
  }
  snprintf(out + k, n - k, "]");
}

static void save_record(void) {
  uint32_t addr = record_addr();
  if (!addr) return;
  jslp_header_t h;
  memset(&h, 0, sizeof h);
  h.magic = JSLP_MAGIC;
  h.version = JSLP_VERSION;
  h.state = JSLP_ASLEEP;
  h.wake_gpio = -1;
  struct timeval tv;
  gettimeofday(&tv, NULL);
  h.tv_sec = tv.tv_sec;
  h.tv_usec = tv.tv_usec;
  h.n_regions = 4;
  uint32_t off = sizeof h;
  for (int i = 0; i < 4; i++) {
    char *s;
    size_t len;
    region(i, &s, &len);
    if (off + len > JSLP_REGION) len = 0; // too much RTC memory for the record: not kept (said on the console)
    h.len[i] = (uint32_t)len;
    off += len;
  }
  if (esp_flash_erase_region(NULL, addr, JSLP_REGION) != ESP_OK) return;
  esp_flash_write(NULL, &h, addr, sizeof h);
  off = sizeof h;
  for (int i = 0; i < 4; i++) {
    char *s;
    size_t len;
    region(i, &s, &len);
    if (h.len[i]) esp_flash_write(NULL, s, addr + off, h.len[i]);
    off += h.len[i];
  }
}

static void __attribute__((noreturn)) faber_sleep(void) {
  save_record();
  char pins[512];
  const char *src;
  int any;
  pins_json(pins, sizeof pins, &src, &any);
  // one line Faber reads (packages/sim-core/src/sleep.ts parseSleepMarker)
  if (s_timer_us)
    esp_rom_printf("\n[faber:sleep] {\"mode\":\"deep\",\"us\":%llu,\"pins\":%s,\"any\":%s,\"src\":\"%s\"}\n", (unsigned long long)s_timer_us, pins, any ? "true" : "false", src);
  else
    esp_rom_printf("\n[faber:sleep] {\"mode\":\"deep\",\"pins\":%s,\"any\":%s,\"src\":\"%s\"}\n", pins, any ? "true" : "false", src);
  esp_rom_delay_us(2000);
  for (;;) vTaskDelay(1000);
}

void __real_esp_deep_sleep_start(void);
void __wrap_esp_deep_sleep_start(void) { faber_sleep(); }

esp_err_t __real_esp_deep_sleep_try_to_start(void);
esp_err_t __wrap_esp_deep_sleep_try_to_start(void) { faber_sleep(); }

void __real_esp_deep_sleep(uint64_t time_in_us);
void __wrap_esp_deep_sleep(uint64_t time_in_us) {
  __wrap_esp_sleep_enable_timer_wakeup(time_in_us);
  faber_sleep();
}

// ---------------------------------------------------------------- waking up

static void __attribute__((constructor)) faber_sleep_boot(void) {
  uint32_t addr = record_addr();
  if (!addr) return;
  jslp_header_t h;
  if (esp_flash_read(NULL, &h, addr, sizeof h) != ESP_OK || h.magic != JSLP_MAGIC || h.version != JSLP_VERSION) return;
  if (h.state == JSLP_WOKEN) {
    uint32_t off = sizeof h;
    for (int i = 0; i < 4 && i < (int)h.n_regions; i++) {
      char *s;
      size_t len;
      region(i, &s, &len);
      if (h.len[i] && h.len[i] == len) esp_flash_read(NULL, s, addr + off, len);
      off += h.len[i];
    }
    uint64_t us = (uint64_t)h.tv_usec + h.slept_us;
    struct timeval tv = {.tv_sec = (time_t)(h.tv_sec + (int64_t)(us / 1000000ULL)), .tv_usec = (suseconds_t)(us % 1000000ULL)};
    settimeofday(&tv, NULL);
    s_woke = 1;
    s_cause = h.cause;
    s_wake_gpio = h.wake_gpio;
  }
  // used once: a later reset or power cycle is a plain boot
  esp_flash_erase_region(NULL, addr, JSLP_REGION);
}

esp_sleep_wakeup_cause_t __real_esp_sleep_get_wakeup_cause(void);
esp_sleep_wakeup_cause_t __wrap_esp_sleep_get_wakeup_cause(void) {
  return s_woke ? (esp_sleep_wakeup_cause_t)s_cause : ESP_SLEEP_WAKEUP_UNDEFINED;
}

esp_reset_reason_t __real_esp_reset_reason(void);
esp_reset_reason_t __wrap_esp_reset_reason(void) {
  return s_woke ? ESP_RST_DEEPSLEEP : __real_esp_reset_reason();
}

#if SOC_PM_SUPPORT_EXT1_WAKEUP
uint64_t __real_esp_sleep_get_ext1_wakeup_status(void);
uint64_t __wrap_esp_sleep_get_ext1_wakeup_status(void) {
  return s_woke && s_cause == ESP_SLEEP_WAKEUP_EXT1 && s_wake_gpio >= 0 ? (1ULL << s_wake_gpio) : 0;
}
#endif

#if SOC_GPIO_SUPPORT_DEEPSLEEP_WAKEUP
uint64_t __real_esp_sleep_get_gpio_wakeup_status(void);
uint64_t __wrap_esp_sleep_get_gpio_wakeup_status(void) {
  return s_woke && s_cause == ESP_SLEEP_WAKEUP_GPIO && s_wake_gpio >= 0 ? (1ULL << s_wake_gpio) : 0;
}
#endif
