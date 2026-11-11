// Jumper: emulated Ethernet bring-up (OpenCores MAC from ESP-IDF + an always-up PHY), Apache-2.0.
#include <string.h>
#include <stdlib.h>
#include "sdkconfig.h"
#include "soc/soc.h"
#include "esp_openeth.h"
#include "esp_log.h"
#include "esp_eth.h"
#include "esp_eth_netif_glue.h"
#include "esp_netif.h"
#include "jumper_eth.h"

esp_eth_mac_t *esp_eth_mac_new_openeth(const eth_mac_config_t *config);

typedef struct { esp_eth_phy_t parent; esp_eth_mediator_t *eth; uint32_t addr; } stub_phy_t;
#define STUB(p) __containerof(p, stub_phy_t, parent)
static esp_err_t ok(esp_eth_phy_t *p) { return ESP_OK; }
static esp_err_t set_mediator(esp_eth_phy_t *p, esp_eth_mediator_t *m) { STUB(p)->eth = m; return ESP_OK; }
static esp_err_t get_link(esp_eth_phy_t *p) {
  static bool up;
  if (!up) {
    esp_eth_mediator_t *m = STUB(p)->eth;
    eth_speed_t sp = ETH_SPEED_100M; eth_duplex_t dx = ETH_DUPLEX_FULL; eth_link_t l = ETH_LINK_UP;
    m->on_state_changed(m, ETH_STATE_SPEED, (void *)sp);
    m->on_state_changed(m, ETH_STATE_DUPLEX, (void *)dx);
    m->on_state_changed(m, ETH_STATE_LINK, (void *)l);
    up = true;
  }
  return ESP_OK;
}
static esp_err_t autonego(esp_eth_phy_t *p, eth_phy_autoneg_cmd_t c, bool *st) { if (st) *st = false; return ESP_OK; }
static esp_err_t pwrctl(esp_eth_phy_t *p, bool e) { return ESP_OK; }
static esp_err_t set_addr(esp_eth_phy_t *p, uint32_t a) { STUB(p)->addr = a; return ESP_OK; }
static esp_err_t get_addr(esp_eth_phy_t *p, uint32_t *a) { *a = STUB(p)->addr; return ESP_OK; }
static esp_err_t u32(esp_eth_phy_t *p, uint32_t v) { return ESP_OK; }
static esp_err_t b(esp_eth_phy_t *p, bool v) { return ESP_OK; }
static esp_err_t spd(esp_eth_phy_t *p, eth_speed_t s) { return ESP_OK; }
static esp_err_t dup(esp_eth_phy_t *p, eth_duplex_t d) { return ESP_OK; }
static esp_err_t lnk(esp_eth_phy_t *p, eth_link_t l) { return ESP_OK; }
static esp_err_t ioctl_(esp_eth_phy_t *p, int c, void *d) { return ESP_ERR_NOT_SUPPORTED; }
static esp_err_t del(esp_eth_phy_t *p) { free(STUB(p)); return ESP_OK; }

static esp_eth_phy_t *stub_phy_new(void) {
  stub_phy_t *s = calloc(1, sizeof(*s));
  esp_eth_phy_t *p = &s->parent;
  p->set_mediator = set_mediator; p->reset = ok; p->reset_hw = ok; p->init = ok; p->deinit = ok;
  p->autonego_ctrl = autonego; p->get_link = get_link; p->set_link = lnk; p->pwrctl = pwrctl;
  p->set_addr = set_addr; p->get_addr = get_addr; p->advertise_pause_ability = u32; p->loopback = b;
  p->set_speed = spd; p->set_duplex = dup; p->custom_ioctl = ioctl_; p->del = del;
  return p;
}

esp_netif_t *jumper_eth_begin(void) {
  if (REG_READ(DR_REG_EMAC_BASE) != 0xa000) {  /* OpenCores MODER reset value: only in the emulator */
    ESP_LOGW("jumper_eth", "no emulated Ethernet MAC here");
    return NULL;
  }
  esp_netif_config_t cfg = ESP_NETIF_DEFAULT_ETH();
  esp_netif_t *netif = esp_netif_new(&cfg);
  eth_mac_config_t mac_config = ETH_MAC_DEFAULT_CONFIG();
  esp_eth_mac_t *mac = esp_eth_mac_new_openeth(&mac_config);
  esp_eth_config_t config = ETH_DEFAULT_CONFIG(mac, stub_phy_new());
  esp_eth_handle_t h = NULL;
  if (esp_eth_driver_install(&config, &h) != ESP_OK) return NULL;
  esp_netif_attach(netif, esp_eth_new_netif_glue(h));
  esp_eth_start(h);
  return netif;
}
