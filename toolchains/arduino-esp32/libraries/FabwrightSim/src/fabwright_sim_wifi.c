// Jumper Wi-Fi shim (simulation builds only), Apache-2.0.
//
// QEMU has no Wi-Fi radio. This file replaces the closed Wi-Fi driver at link time (each esp_wifi_*
// below is a -Wl,--wrap target) with one that uses the emulated OpenCores Ethernet card:
//   - The Wi-Fi station netif stays the one the sketch uses (WiFi.localIP(), events, DHCP); only its
//     driver changes: esp_wifi_internal_tx sends the frame on the Ethernet card, and frames from the
//     card go to the rx callback the netif registered.
//   - Join / drop / RSSI / scan are asked of Jumper's sandbox network over EtherType 0x88B5
//     ("JWIFI/1" text lines, see packages/device-net/src/netstack/wifi.ts), and posted as the usual
//     WIFI_EVENT_* events, so Arduino's WiFi class, its auto-reconnect and the sketch's own event
//     handlers behave as on a real board.
//   - Without Jumper's netstack on the other end (QEMU user networking), a join succeeds after 3 s.
// Not emulated: the radio (signal, interference, roaming, power save), soft-AP clients, ESP-NOW,
// promiscuous mode, WPS, enterprise auth, FTM, CSI.
#include <string.h>
#include <stdio.h>
#include <stdlib.h>
#include "sdkconfig.h"
#include "freertos/FreeRTOS.h"
#include "freertos/task.h"
#include "freertos/semphr.h"
#include "freertos/queue.h"
#include "esp_err.h"
#include "esp_log.h"
#include "esp_mac.h"
#include "esp_event.h"
#include "esp_wifi.h"
#include "esp_private/wifi.h"
#include "esp_eth_driver.h"
#include "jumper_eth.h"
#include "JumperSim.h"

#define TAG "jumper_wifi"
#define ETH_JUMPER 0x88b5
#define MAX_APS 16
#define MAGIC "JWIFI/1"

void jumper_sim_set_ca(const uint8_t *der, size_t len);

static esp_eth_handle_t s_eth;
static SemaphoreHandle_t s_tx_lock;
static QueueHandle_t s_ctrl;
static SemaphoreHandle_t s_scan_done;
static wifi_rxcb_t s_rxcb[WIFI_IF_MAX];
static wifi_mode_t s_mode = WIFI_MODE_NULL;
static bool s_inited, s_started, s_eth_ok;
static volatile bool s_joined, s_connecting, s_jumper_seen;
static volatile uint32_t s_connect_gen;
static wifi_config_t s_sta_cfg, s_ap_cfg;
static wifi_ap_record_t s_ap;
static volatile int8_t s_rssi = -55;
static wifi_ap_record_t s_scan[MAX_APS];
static uint16_t s_scan_n;
static wifi_ps_type_t s_ps = WIFI_PS_MIN_MODEM;
static wifi_storage_t s_storage = WIFI_STORAGE_FLASH;
static uint8_t s_protocol[WIFI_IF_MAX] = {7, 7};
static wifi_bandwidth_t s_bw[WIFI_IF_MAX] = {WIFI_BW_HT20, WIFI_BW_HT20};
static int8_t s_tx_power = 80;
static uint16_t s_inactive[WIFI_IF_MAX] = {6, 300};
static wifi_country_t s_country = {.cc = "01", .schan = 1, .nchan = 11, .max_tx_power = 20, .policy = WIFI_COUNTRY_POLICY_AUTO};
static uint8_t s_mac_override[WIFI_IF_MAX][6];
static bool s_mac_set[WIFI_IF_MAX];

typedef struct {
  uint16_t len;
  char text[];
} ctrl_msg_t;

int jumper_sim_wifi_joined(void) { return s_joined; }

// ------------------------------------------------------------------ control channel

static void read_mac(wifi_interface_t ifx, uint8_t mac[6]) {
  if (ifx < WIFI_IF_MAX && s_mac_set[ifx]) {
    memcpy(mac, s_mac_override[ifx], 6);
    return;
  }
  esp_read_mac(mac, ifx == WIFI_IF_AP ? ESP_MAC_WIFI_SOFTAP : ESP_MAC_WIFI_STA);
}

static void pct(char *out, size_t cap, const uint8_t *s, size_t n) {
  size_t o = 0;
  for (size_t i = 0; i < n && s[i] && o + 4 < cap; i++) {
    uint8_t c = s[i];
    if (c <= 0x20 || c == '%' || c == '=' || c >= 0x7f) o += snprintf(out + o, cap - o, "%%%02x", c);
    else out[o++] = (char)c;
  }
  out[o] = 0;
}

static void send_ctrl(const char *line) {
  if (!s_eth) return;
  size_t n = strlen(line);
  size_t len = 14 + n < 60 ? 60 : 14 + n;
  uint8_t *f = calloc(1, len);
  if (!f) return;
  memset(f, 0xff, 6);
  read_mac(WIFI_IF_STA, f + 6);
  f[12] = ETH_JUMPER >> 8;
  f[13] = ETH_JUMPER & 0xff;
  memcpy(f + 14, line, n);
  xSemaphoreTake(s_tx_lock, portMAX_DELAY);
  esp_eth_transmit(s_eth, f, len);
  xSemaphoreGive(s_tx_lock);
  free(f);
}

static const char *arg(const char *line, const char *key, char *out, size_t cap) {
  size_t kl = strlen(key);
  const char *p = line;
  while ((p = strstr(p, key)) != NULL) {
    if ((p == line || p[-1] == ' ') && p[kl] == '=') {
      p += kl + 1;
      size_t o = 0;
      while (*p && *p != ' ' && *p != '\n' && o + 1 < cap) {
        if (*p == '%' && p[1] && p[2]) {
          char h[3] = {p[1], p[2], 0};
          out[o++] = (char)strtol(h, NULL, 16);
          p += 3;
        } else {
          out[o++] = *p++;
        }
      }
      out[o] = 0;
      return out;
    }
    p += kl;
  }
  return NULL;
}

static int argi(const char *line, const char *key, int dflt) {
  char b[16];
  return arg(line, key, b, sizeof b) ? atoi(b) : dflt;
}

static void parse_bssid(const char *s, uint8_t out[6]) {
  unsigned v[6] = {0};
  if (sscanf(s, "%x:%x:%x:%x:%x:%x", &v[0], &v[1], &v[2], &v[3], &v[4], &v[5]) == 6)
    for (int i = 0; i < 6; i++) out[i] = (uint8_t)v[i];
}

static void fill_record(const char *line, wifi_ap_record_t *r) {
  char b[80];
  memset(r, 0, sizeof *r);
  if (arg(line, "ssid", b, sizeof b)) strncpy((char *)r->ssid, b, sizeof r->ssid - 1);
  if (arg(line, "bssid", b, sizeof b)) parse_bssid(b, r->bssid);
  r->primary = (uint8_t)argi(line, "channel", 6);
  r->rssi = (int8_t)argi(line, "rssi", -55);
  r->authmode = (wifi_auth_mode_t)argi(line, "auth", WIFI_AUTH_WPA2_PSK);
  r->pairwise_cipher = WIFI_CIPHER_TYPE_CCMP;
  r->group_cipher = WIFI_CIPHER_TYPE_CCMP;
  r->phy_11b = r->phy_11g = r->phy_11n = 1;
  r->country = s_country;
}

static void post_disconnected(uint8_t reason) {
  wifi_event_sta_disconnected_t ev = {0};
  size_t n = strnlen((const char *)s_sta_cfg.sta.ssid, sizeof s_sta_cfg.sta.ssid);
  memcpy(ev.ssid, s_sta_cfg.sta.ssid, n);
  ev.ssid_len = n;
  memcpy(ev.bssid, s_ap.bssid, 6);
  ev.reason = reason;
  ev.rssi = s_rssi;
  esp_event_post(WIFI_EVENT, WIFI_EVENT_STA_DISCONNECTED, &ev, sizeof ev, portMAX_DELAY);
}

static void on_connected(const char *line) {
  fill_record(line, &s_ap);
  s_rssi = s_ap.rssi;
  s_connecting = false;
  s_joined = true;
  wifi_event_sta_connected_t ev = {0};
  size_t n = strnlen((const char *)s_ap.ssid, sizeof ev.ssid);
  memcpy(ev.ssid, s_ap.ssid, n);
  ev.ssid_len = n;
  memcpy(ev.bssid, s_ap.bssid, 6);
  ev.channel = s_ap.primary;
  ev.authmode = s_ap.authmode;
  ev.aid = 1;
  esp_event_post(WIFI_EVENT, WIFI_EVENT_STA_CONNECTED, &ev, sizeof ev, portMAX_DELAY);
}

static void handle_line(const char *line) {
  char verb[16] = {0};
  if (strncmp(line, MAGIC " ", sizeof MAGIC) != 0) return;
  sscanf(line + sizeof MAGIC, "%15s", verb);
  s_jumper_seen = true;
  if (!strcmp(verb, "connected")) {
    if (s_connecting) on_connected(line);
  } else if (!strcmp(verb, "failed")) {
    if (!s_connecting) return;
    uint32_t gen = s_connect_gen;
    // A real station spends this long scanning / handshaking before it gives up.
    vTaskDelay(pdMS_TO_TICKS(argi(line, "after_ms", 2000)));
    if (!s_connecting || gen != s_connect_gen) return;
    s_connecting = false;
    post_disconnected((uint8_t)argi(line, "reason", WIFI_REASON_NO_AP_FOUND));
  } else if (!strcmp(verb, "lost")) {
    if (!s_joined) return;
    s_joined = false;
    post_disconnected((uint8_t)argi(line, "reason", WIFI_REASON_BEACON_TIMEOUT));
  } else if (!strcmp(verb, "rssi")) {
    s_rssi = (int8_t)argi(line, "v", s_rssi);
    s_ap.rssi = s_rssi;
  } else if (!strcmp(verb, "ap")) {
    if (s_scan_n < MAX_APS) fill_record(line, &s_scan[s_scan_n++]);
  } else if (!strcmp(verb, "scan_done")) {
    wifi_event_sta_scan_done_t ev = {.status = 0, .number = s_scan_n, .scan_id = 0};
    esp_event_post(WIFI_EVENT, WIFI_EVENT_SCAN_DONE, &ev, sizeof ev, portMAX_DELAY);
    xSemaphoreGive(s_scan_done);
  } else if (!strcmp(verb, "ca")) {
    const char *p = strstr(line, " der=");
    if (!p) return;
    p += 5;
    size_t n = 0;
    while (p[n] && p[n] != ' ' && p[n] != '\n') n++;
    uint8_t *der = malloc(n / 2 + 1);
    if (!der) return;
    for (size_t i = 0; i + 1 < n; i += 2) {
      char h[3] = {p[i], p[i + 1], 0};
      der[i / 2] = (uint8_t)strtol(h, NULL, 16);
    }
    jumper_sim_set_ca(der, n / 2);
    free(der);
  }
}

static void ctrl_task(void *arg) {
  ctrl_msg_t *m;
  for (;;) {
    if (xQueueReceive(s_ctrl, &m, portMAX_DELAY) != pdTRUE) continue;
    char *save = NULL;
    for (char *l = strtok_r(m->text, "\n", &save); l; l = strtok_r(NULL, "\n", &save)) handle_line(l);
    free(m);
  }
}

// Frames from the Ethernet card: control frames to the shim, the rest to the Wi-Fi station netif.
static esp_err_t eth_input(esp_eth_handle_t h, uint8_t *buf, uint32_t len, void *priv) {
  if (len >= 14 && buf[12] == (ETH_JUMPER >> 8) && buf[13] == (ETH_JUMPER & 0xff)) {
    ctrl_msg_t *m = malloc(sizeof(ctrl_msg_t) + len - 14 + 1);
    if (m) {
      m->len = len - 14;
      memcpy(m->text, buf + 14, len - 14);
      m->text[len - 14] = 0;
      if (xQueueSend(s_ctrl, &m, 0) != pdTRUE) free(m);
    }
    free(buf);
    return ESP_OK;
  }
  if (s_joined && s_rxcb[WIFI_IF_STA]) return s_rxcb[WIFI_IF_STA](buf, (uint16_t)len, buf);
  free(buf);
  return ESP_OK;
}

static bool eth_up(void) {
  if (s_eth) return true;
  if (!s_tx_lock) s_tx_lock = xSemaphoreCreateMutex();
  if (!s_ctrl) {
    s_ctrl = xQueueCreate(16, sizeof(ctrl_msg_t *));
    s_scan_done = xSemaphoreCreateBinary();
    xTaskCreate(ctrl_task, "jumper_wifi", 4096, NULL, 19, NULL);
  }
  uint8_t mac[6];
  static const uint8_t zero[6] = {0};
  read_mac(WIFI_IF_STA, mac);
  // QEMU's eFuse has no MAC (all zero): use the one the emulator gave the network card instead,
  // so every board on the sandbox LAN has its own address.
  bool from_nic = memcmp(mac, zero, 6) == 0;
  s_eth = jumper_eth_install(from_nic ? NULL : mac);
  if (!s_eth) {
    ESP_LOGE(TAG, "this simulation has no network card: Wi-Fi cannot join (start the board with networking on)");
    return false;
  }
  if (from_nic && esp_eth_ioctl(s_eth, ETH_CMD_G_MAC_ADDR, mac) == ESP_OK && memcmp(mac, zero, 6) != 0) {
    memcpy(s_mac_override[WIFI_IF_STA], mac, 6);
    s_mac_set[WIFI_IF_STA] = true;
    memcpy(s_mac_override[WIFI_IF_AP], mac, 6);
    s_mac_override[WIFI_IF_AP][5] ^= 0x01;
    s_mac_set[WIFI_IF_AP] = true;
  }
  esp_eth_update_input_path(s_eth, eth_input, NULL);
  esp_eth_start(s_eth);
  s_eth_ok = true;
  char hello[96];
  snprintf(hello, sizeof hello, MAGIC " hello chip=%s shim=1\n", CONFIG_IDF_TARGET);
  send_ctrl(hello);
  return true;
}

// Without Jumper's netstack (plain QEMU user networking) nobody answers: join after 3 s anyway.
static void fallback_task(void *arg) {
  uint32_t gen = (uint32_t)(uintptr_t)arg;
  vTaskDelay(pdMS_TO_TICKS(3000));
  if (s_connecting && gen == s_connect_gen && !s_jumper_seen) {
    char line[160], ss[100];
    pct(ss, sizeof ss, s_sta_cfg.sta.ssid, sizeof s_sta_cfg.sta.ssid);
    snprintf(line, sizeof line, MAGIC " connected ssid=%s channel=1 rssi=-55 auth=3", ss);
    on_connected(line);
  }
  vTaskDelete(NULL);
}

// ------------------------------------------------------------------ the wrapped driver API

esp_err_t __wrap_esp_wifi_init(const wifi_init_config_t *config) {
  s_inited = true;
  return ESP_OK;
}

esp_err_t __wrap_esp_wifi_deinit(void) {
  if (!s_inited) return ESP_ERR_WIFI_NOT_INIT;
  s_inited = false;
  return ESP_OK;
}

esp_err_t __wrap_esp_wifi_set_mode(wifi_mode_t mode) {
  if (!s_inited) return ESP_ERR_WIFI_NOT_INIT;
  s_mode = mode;
  return ESP_OK;
}

esp_err_t __wrap_esp_wifi_get_mode(wifi_mode_t *mode) {
  if (!s_inited) return ESP_ERR_WIFI_NOT_INIT;
  if (!mode) return ESP_ERR_INVALID_ARG;
  *mode = s_mode;
  return ESP_OK;
}

esp_err_t __wrap_esp_wifi_start(void) {
  if (!s_inited) return ESP_ERR_WIFI_NOT_INIT;
  if (s_started) return ESP_OK;
  s_started = true;
  eth_up();
  if (s_mode & WIFI_MODE_STA) esp_event_post(WIFI_EVENT, WIFI_EVENT_STA_START, NULL, 0, portMAX_DELAY);
  // A soft AP starts, but no station can join it: soft-AP clients are not emulated.
  if (s_mode & WIFI_MODE_AP) esp_event_post(WIFI_EVENT, WIFI_EVENT_AP_START, NULL, 0, portMAX_DELAY);
  return ESP_OK;
}

esp_err_t __wrap_esp_wifi_stop(void) {
  if (!s_inited) return ESP_ERR_WIFI_NOT_INIT;
  if (!s_started) return ESP_OK;
  if (s_joined) {
    s_joined = false;
    send_ctrl(MAGIC " disconnect\n");
    post_disconnected(WIFI_REASON_ASSOC_LEAVE);
  }
  s_connecting = false;
  s_started = false;
  if (s_mode & WIFI_MODE_STA) esp_event_post(WIFI_EVENT, WIFI_EVENT_STA_STOP, NULL, 0, portMAX_DELAY);
  if (s_mode & WIFI_MODE_AP) esp_event_post(WIFI_EVENT, WIFI_EVENT_AP_STOP, NULL, 0, portMAX_DELAY);
  return ESP_OK;
}

esp_err_t __wrap_esp_wifi_restore(void) {
  memset(&s_sta_cfg, 0, sizeof s_sta_cfg);
  memset(&s_ap_cfg, 0, sizeof s_ap_cfg);
  return ESP_OK;
}

esp_err_t __wrap_esp_wifi_connect(void) {
  if (!s_inited) return ESP_ERR_WIFI_NOT_INIT;
  if (!s_started) return ESP_ERR_WIFI_NOT_STARTED;
  if (!(s_mode & WIFI_MODE_STA)) return ESP_ERR_WIFI_MODE;
  if (s_joined) return ESP_OK;
  s_connecting = true;
  uint32_t gen = ++s_connect_gen;
  if (!s_eth_ok) {
    // No network card: behave like a station that finds no access point.
    s_connecting = false;
    post_disconnected(WIFI_REASON_NO_AP_FOUND);
    return ESP_OK;
  }
  char line[320], ss[100], pw[200];
  pct(ss, sizeof ss, s_sta_cfg.sta.ssid, sizeof s_sta_cfg.sta.ssid);
  pct(pw, sizeof pw, s_sta_cfg.sta.password, sizeof s_sta_cfg.sta.password);
  snprintf(line, sizeof line, MAGIC " connect ssid=%s pass=%s\n", ss, pw);
  send_ctrl(line);
  xTaskCreate(fallback_task, "jumper_join", 2560, (void *)(uintptr_t)gen, 5, NULL);
  return ESP_OK;
}

esp_err_t __wrap_esp_wifi_disconnect(void) {
  if (!s_inited) return ESP_ERR_WIFI_NOT_INIT;
  bool was = s_joined || s_connecting;
  s_connecting = false;
  s_connect_gen++;
  if (s_joined) send_ctrl(MAGIC " disconnect\n");
  s_joined = false;
  if (was) post_disconnected(WIFI_REASON_ASSOC_LEAVE);
  return ESP_OK;
}

esp_err_t __wrap_esp_wifi_clear_fast_connect(void) { return ESP_OK; }

esp_err_t __wrap_esp_wifi_scan_start(const wifi_scan_config_t *config, bool block) {
  if (!s_inited) return ESP_ERR_WIFI_NOT_INIT;
  if (!s_started) return ESP_ERR_WIFI_NOT_STARTED;
  s_scan_n = 0;
  if (!s_eth_ok) {
    wifi_event_sta_scan_done_t ev = {.status = 0, .number = 0};
    esp_event_post(WIFI_EVENT, WIFI_EVENT_SCAN_DONE, &ev, sizeof ev, portMAX_DELAY);
    return ESP_OK;
  }
  xSemaphoreTake(s_scan_done, 0);
  send_ctrl(MAGIC " scan\n");
  if (block) xSemaphoreTake(s_scan_done, pdMS_TO_TICKS(4000));
  return ESP_OK;
}

esp_err_t __wrap_esp_wifi_scan_stop(void) { return ESP_OK; }

esp_err_t __wrap_esp_wifi_scan_get_ap_num(uint16_t *number) {
  if (!number) return ESP_ERR_INVALID_ARG;
  *number = s_scan_n;
  return ESP_OK;
}

esp_err_t __wrap_esp_wifi_scan_get_ap_records(uint16_t *number, wifi_ap_record_t *ap_records) {
  if (!number || !ap_records) return ESP_ERR_INVALID_ARG;
  uint16_t n = *number < s_scan_n ? *number : s_scan_n;
  memcpy(ap_records, s_scan, n * sizeof(wifi_ap_record_t));
  *number = n;
  s_scan_n = 0;
  return ESP_OK;
}

esp_err_t __wrap_esp_wifi_scan_get_ap_record(wifi_ap_record_t *ap_record) {
  if (!ap_record) return ESP_ERR_INVALID_ARG;
  if (!s_scan_n) return ESP_FAIL;
  *ap_record = s_scan[0];
  memmove(s_scan, s_scan + 1, (--s_scan_n) * sizeof(wifi_ap_record_t));
  return ESP_OK;
}

esp_err_t __wrap_esp_wifi_clear_ap_list(void) {
  s_scan_n = 0;
  return ESP_OK;
}

esp_err_t __wrap_esp_wifi_sta_get_ap_info(wifi_ap_record_t *ap_info) {
  if (!ap_info) return ESP_ERR_INVALID_ARG;
  if (!s_joined) return ESP_ERR_WIFI_NOT_CONNECT;
  s_ap.rssi = s_rssi;
  *ap_info = s_ap;
  return ESP_OK;
}

esp_err_t __wrap_esp_wifi_sta_get_rssi(int *rssi) {
  if (!rssi) return ESP_ERR_INVALID_ARG;
  if (!s_joined) return ESP_ERR_WIFI_NOT_CONNECT;
  *rssi = s_rssi;
  return ESP_OK;
}

esp_err_t __wrap_esp_wifi_sta_get_aid(uint16_t *aid) {
  if (!aid) return ESP_ERR_INVALID_ARG;
  *aid = s_joined ? 1 : 0;
  return ESP_OK;
}

esp_err_t __wrap_esp_wifi_set_ps(wifi_ps_type_t type) {
  s_ps = type;
  return ESP_OK;
}

esp_err_t __wrap_esp_wifi_get_ps(wifi_ps_type_t *type) {
  if (!type) return ESP_ERR_INVALID_ARG;
  *type = s_ps;
  return ESP_OK;
}

esp_err_t __wrap_esp_wifi_set_protocol(wifi_interface_t ifx, uint8_t bitmap) {
  if (ifx >= WIFI_IF_MAX) return ESP_ERR_INVALID_ARG;
  s_protocol[ifx] = bitmap;
  return ESP_OK;
}

esp_err_t __wrap_esp_wifi_get_protocol(wifi_interface_t ifx, uint8_t *bitmap) {
  if (ifx >= WIFI_IF_MAX || !bitmap) return ESP_ERR_INVALID_ARG;
  *bitmap = s_protocol[ifx];
  return ESP_OK;
}

esp_err_t __wrap_esp_wifi_set_bandwidth(wifi_interface_t ifx, wifi_bandwidth_t bw) {
  if (ifx >= WIFI_IF_MAX) return ESP_ERR_INVALID_ARG;
  s_bw[ifx] = bw;
  return ESP_OK;
}

esp_err_t __wrap_esp_wifi_get_bandwidth(wifi_interface_t ifx, wifi_bandwidth_t *bw) {
  if (ifx >= WIFI_IF_MAX || !bw) return ESP_ERR_INVALID_ARG;
  *bw = s_bw[ifx];
  return ESP_OK;
}

esp_err_t __wrap_esp_wifi_set_channel(uint8_t primary, wifi_second_chan_t second) { return ESP_OK; }

esp_err_t __wrap_esp_wifi_get_channel(uint8_t *primary, wifi_second_chan_t *second) {
  if (primary) *primary = s_joined ? s_ap.primary : 1;
  if (second) *second = WIFI_SECOND_CHAN_NONE;
  return ESP_OK;
}

esp_err_t __wrap_esp_wifi_set_country(const wifi_country_t *country) {
  if (!country) return ESP_ERR_INVALID_ARG;
  s_country = *country;
  return ESP_OK;
}

esp_err_t __wrap_esp_wifi_get_country(wifi_country_t *country) {
  if (!country) return ESP_ERR_INVALID_ARG;
  *country = s_country;
  return ESP_OK;
}

esp_err_t __wrap_esp_wifi_set_country_code(const char *country, bool ieee80211d_enabled) {
  if (!country) return ESP_ERR_INVALID_ARG;
  memcpy(s_country.cc, country, 2);
  return ESP_OK;
}

esp_err_t __wrap_esp_wifi_get_country_code(char *country) {
  if (!country) return ESP_ERR_INVALID_ARG;
  memcpy(country, s_country.cc, 2);
  country[2] = 0;
  return ESP_OK;
}

esp_err_t __wrap_esp_wifi_set_mac(wifi_interface_t ifx, const uint8_t mac[6]) {
  if (ifx >= WIFI_IF_MAX || !mac) return ESP_ERR_INVALID_ARG;
  memcpy(s_mac_override[ifx], mac, 6);
  s_mac_set[ifx] = true;
  if (s_eth && ifx == WIFI_IF_STA) esp_eth_ioctl(s_eth, ETH_CMD_S_MAC_ADDR, (void *)mac);
  return ESP_OK;
}

esp_err_t __wrap_esp_wifi_get_mac(wifi_interface_t ifx, uint8_t mac[6]) {
  if (ifx >= WIFI_IF_MAX || !mac) return ESP_ERR_INVALID_ARG;
  read_mac(ifx, mac);
  return ESP_OK;
}

esp_err_t __wrap_esp_wifi_set_storage(wifi_storage_t storage) {
  s_storage = storage;
  return ESP_OK;
}

esp_err_t __wrap_esp_wifi_set_config(wifi_interface_t interface, wifi_config_t *conf) {
  if (!conf) return ESP_ERR_INVALID_ARG;
  if (interface == WIFI_IF_STA) s_sta_cfg = *conf;
  else if (interface == WIFI_IF_AP) s_ap_cfg = *conf;
  else return ESP_ERR_INVALID_ARG;
  return ESP_OK;
}

esp_err_t __wrap_esp_wifi_get_config(wifi_interface_t interface, wifi_config_t *conf) {
  if (!conf) return ESP_ERR_INVALID_ARG;
  if (interface == WIFI_IF_STA) *conf = s_sta_cfg;
  else if (interface == WIFI_IF_AP) *conf = s_ap_cfg;
  else return ESP_ERR_INVALID_ARG;
  return ESP_OK;
}

esp_err_t __wrap_esp_wifi_ap_get_sta_list(wifi_sta_list_t *sta) {
  if (!sta) return ESP_ERR_INVALID_ARG;
  memset(sta, 0, sizeof *sta);
  return ESP_OK;
}

esp_err_t __wrap_esp_wifi_set_max_tx_power(int8_t power) {
  s_tx_power = power;
  return ESP_OK;
}

esp_err_t __wrap_esp_wifi_get_max_tx_power(int8_t *power) {
  if (!power) return ESP_ERR_INVALID_ARG;
  *power = s_tx_power;
  return ESP_OK;
}

esp_err_t __wrap_esp_wifi_set_inactive_time(wifi_interface_t ifx, uint16_t sec) {
  if (ifx >= WIFI_IF_MAX) return ESP_ERR_INVALID_ARG;
  s_inactive[ifx] = sec;
  return ESP_OK;
}

esp_err_t __wrap_esp_wifi_get_inactive_time(wifi_interface_t ifx, uint16_t *sec) {
  if (ifx >= WIFI_IF_MAX || !sec) return ESP_ERR_INVALID_ARG;
  *sec = s_inactive[ifx];
  return ESP_OK;
}

esp_err_t __wrap_esp_wifi_set_rssi_threshold(int32_t rssi) { return ESP_OK; }
esp_err_t __wrap_esp_wifi_set_event_mask(uint32_t mask) { return ESP_OK; }
esp_err_t __wrap_esp_wifi_set_promiscuous(bool en) { return en ? ESP_ERR_NOT_SUPPORTED : ESP_OK; }
esp_err_t __wrap_esp_wifi_set_dynamic_cs(bool enabled) { return ESP_OK; }

// ------------------------------------------------------------------ the netif's driver calls

esp_err_t __wrap_esp_wifi_internal_reg_rxcb(wifi_interface_t ifx, wifi_rxcb_t fn) {
  if (ifx >= WIFI_IF_MAX) return ESP_ERR_INVALID_ARG;
  s_rxcb[ifx] = fn;
  return ESP_OK;
}

int __wrap_esp_wifi_internal_tx(wifi_interface_t ifx, void *buffer, uint16_t len) {
  if (ifx != WIFI_IF_STA || !s_joined || !s_eth) return ESP_ERR_WIFI_NOT_CONNECT;
  xSemaphoreTake(s_tx_lock, portMAX_DELAY);
  esp_err_t r = esp_eth_transmit(s_eth, buffer, len);
  xSemaphoreGive(s_tx_lock);
  return r;
}

esp_err_t __wrap_esp_wifi_internal_tx_by_ref(wifi_interface_t ifx, void *buffer, size_t len, void *netstack_buf) {
  // The frame is copied into the card's buffer right away, so the netstack buffer is not kept.
  return __wrap_esp_wifi_internal_tx(ifx, buffer, (uint16_t)len);
}

void __wrap_esp_wifi_internal_free_rx_buffer(void *buffer) { free(buffer); }

esp_err_t __wrap_esp_wifi_internal_reg_netstack_buf_cb(wifi_netstack_buf_ref_cb_t ref, wifi_netstack_buf_free_cb_t fr) { return ESP_OK; }

esp_err_t __wrap_esp_wifi_internal_set_sta_ip(void) { return ESP_OK; }
