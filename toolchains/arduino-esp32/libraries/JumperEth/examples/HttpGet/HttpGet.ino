// JumperEth example: networking through QEMU's OpenCores Ethernet + slirp, HTTP GET to the host and the internet.
#include <Network.h>
#include <HTTPClient.h>
#include <NetworkClientSecure.h>
#include <jumper_eth.h>
#ifndef HOST_URL
#define HOST_URL "http://host.docker.internal:8765/hello"
#endif
static void get(const char *url, bool tls) {
  HTTPClient http; NetworkClientSecure sc; NetworkClient c;
  uint32_t t = millis();
  if (tls) { sc.setInsecure(); http.begin(sc, url); } else http.begin(c, url);
  int code = http.GET();
  String body = code > 0 ? http.getString() : http.errorToString(code);
  Serial.printf("GET %s -> %d in %lu ms, %u bytes: %.60s\n", url, code, (unsigned long)(millis() - t), body.length(), body.c_str());
  http.end();
}
void setup() {
  Serial.begin(115200);
  Network.begin();
  esp_netif_t *n = jumper_eth_begin();
  Serial.printf("eth netif %p\n", n);
  esp_netif_ip_info_t ip = {};
  uint32_t t = millis();
  while (n && ip.ip.addr == 0 && millis() - t < 10000) { delay(50); esp_netif_get_ip_info(n, &ip); }
  Serial.printf("ip " IPSTR " gw " IPSTR " after %lu ms\n", IP2STR(&ip.ip), IP2STR(&ip.gw), (unsigned long)(millis() - t));
  get(HOST_URL, false);
  get("http://example.com/", false);
  get("https://example.com/", true);
  Serial.println("eth done");
}
void loop() { delay(1000); }
