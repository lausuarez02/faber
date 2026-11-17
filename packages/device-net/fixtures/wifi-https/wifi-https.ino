// A plain ESP32 Wi-Fi sketch, written for the real device (no Fabwright code in it): joins Wi-Fi,
// fetches JSON over HTTPS with the real root CA set (ISRG Root X1), then keeps reporting its
// Wi-Fi status and RSSI and fetches again after every reconnect. Fabwright's simulation build runs it
// unchanged: the Wi-Fi shim joins the sandbox network, the TLS shim also trusts the sandbox CA.
#include <WiFi.h>
#include <HTTPClient.h>
#include <WiFiClientSecure.h>

static const char *ROOT_CA =
"-----BEGIN CERTIFICATE-----\n"
"MIIFazCCA1OgAwIBAgIRAIIQz7DSQONZRGPgu2OCiwAwDQYJKoZIhvcNAQELBQAw\n"
"TzELMAkGA1UEBhMCVVMxKTAnBgNVBAoTIEludGVybmV0IFNlY3VyaXR5IFJlc2Vh\n"
"cmNoIEdyb3VwMRUwEwYDVQQDEwxJU1JHIFJvb3QgWDEwHhcNMTUwNjA0MTEwNDM4\n"
"WhcNMzUwNjA0MTEwNDM4WjBPMQswCQYDVQQGEwJVUzEpMCcGA1UEChMgSW50ZXJu\n"
"ZXQgU2VjdXJpdHkgUmVzZWFyY2ggR3JvdXAxFTATBgNVBAMTDElTUkcgUm9vdCBY\n"
"MTCCAiIwDQYJKoZIhvcNAQEBBQADggIPADCCAgoCggIBAK3oJHP0FDfzm54rVygc\n"
"h77ct984kIxuPOZXoHj3dcKi/vVqbvYATyjb3miGbESTtrFj/RQSa78f0uoxmyF+\n"
"0TM8ukj13Xnfs7j/EvEhmkvBioZxaUpmZmyPfjxwv60pIgbz5MDmgK7iS4+3mX6U\n"
"A5/TR5d8mUgjU+g4rk8Kb4Mu0UlXjIB0ttov0DiNewNwIRt18jA8+o+u3dpjq+sW\n"
"T8KOEUt+zwvo/7V3LvSye0rgTBIlDHCNAymg4VMk7BPZ7hm/ELNKjD+Jo2FR3qyH\n"
"B5T0Y3HsLuJvW5iB4YlcNHlsdu87kGJ55tukmi8mxdAQ4Q7e2RCOFvu396j3x+UC\n"
"B5iPNgiV5+I3lg02dZ77DnKxHZu8A/lJBdiB3QW0KtZB6awBdpUKD9jf1b0SHzUv\n"
"KBds0pjBqAlkd25HN7rOrFleaJ1/ctaJxQZBKT5ZPt0m9STJEadao0xAH0ahmbWn\n"
"OlFuhjuefXKnEgV4We0+UXgVCwOPjdAvBbI+e0ocS3MFEvzG6uBQE3xDk3SzynTn\n"
"jh8BCNAw1FtxNrQHusEwMFxIt4I7mKZ9YIqioymCzLq9gwQbooMDQaHWBfEbwrbw\n"
"qHyGO0aoSCqI3Haadr8faqU9GY/rOPNk3sgrDQoo//fb4hVC1CLQJ13hef4Y53CI\n"
"rU7m2Ys6xt0nUW7/vGT1M0NPAgMBAAGjQjBAMA4GA1UdDwEB/wQEAwIBBjAPBgNV\n"
"HRMBAf8EBTADAQH/MB0GA1UdDgQWBBR5tFnme7bl5AFzgAiIyBpY9umbbjANBgkq\n"
"hkiG9w0BAQsFAAOCAgEAVR9YqbyyqFDQDLHYGmkgJykIrGF1XIpu+ILlaS/V9lZL\n"
"ubhzEFnTIZd+50xx+7LSYK05qAvqFyFWhfFQDlnrzuBZ6brJFe+GnY+EgPbk6ZGQ\n"
"3BebYhtF8GaV0nxvwuo77x/Py9auJ/GpsMiu/X1+mvoiBOv/2X/qkSsisRcOj/KK\n"
"NFtY2PwByVS5uCbMiogziUwthDyC3+6WVwW6LLv3xLfHTjuCvjHIInNzktHCgKQ5\n"
"ORAzI4JMPJ+GslWYHb4phowim57iaztXOoJwTdwJx4nLCgdNbOhdjsnvzqvHu7Ur\n"
"TkXWStAmzOVyyghqpZXjFaH3pO3JLF+l+/+sKAIuvtd7u+Nxe5AW0wdeRlN8NwdC\n"
"jNPElpzVmbUq4JUagEiuTDkHzsxHpFKVK7q4+63SM1N95R1NbdWhscdCb+ZAJzVc\n"
"oyi3B43njTOQ5yOf+1CceWxG1bQVs5ZufpsMljq4Ui0/1lvh+wjChP4kqKOJ2qxq\n"
"4RgqsahDYVvTH9w7jXbyLeiNdd8XM2w9U/t7y0Ff/9yi0GE44Za4rF2LN9d11TPA\n"
"mRGunUHBcnWEvgJBQl9nJEiU0Zsnvgc/ubhPgXRR4Xq37Z0j4r7g1SgEEzwxA57d\n"
"emyPxgcYxn/eR44/KJ4EBs+lVDR3veyJm+kXQ99b21/+jh5Xos1AnX5iItreGCc=\n"
"-----END CERTIFICATE-----\n";

static const char *SSID = "FabwrightNet";
static const char *PASS = "hunter22-wifi";
static const char *URL = "https://api.weather.test/v1/now?city=Lisbon";

static void fetch(const char *url, const char *tag) {
  WiFiClientSecure tls;
  tls.setCACert(ROOT_CA);
  HTTPClient http;
  unsigned long t = millis();
  if (!http.begin(tls, url)) {
    Serial.printf("%s begin failed\n", tag);
    return;
  }
  int code = http.GET();
  String body = code > 0 ? http.getString() : http.errorToString(code);
  Serial.printf("%s %d %lums %s\n", tag, code, (unsigned long)(millis() - t), body.c_str());
  http.end();
}

static wl_status_t last = WL_IDLE_STATUS;

void setup() {
  Serial.begin(115200);
  delay(50);
  Serial.println("boot");
  WiFi.mode(WIFI_STA);
  int n = WiFi.scanNetworks();
  Serial.printf("scan %d %s\n", n, n > 0 ? WiFi.SSID(0).c_str() : "-");
  WiFi.begin(SSID, PASS);
  unsigned long t = millis();
  while (WiFi.status() != WL_CONNECTED && millis() - t < 20000) delay(50);
  Serial.printf("wifi status=%d ip=%s gw=%s rssi=%d mac=%s\n", WiFi.status(), WiFi.localIP().toString().c_str(),
                WiFi.gatewayIP().toString().c_str(), WiFi.RSSI(), WiFi.macAddress().c_str());
  fetch(URL, "get1");
  fetch("https://blocked.example.test/", "blocked");
  last = WiFi.status();
}

void loop() {
  wl_status_t s = WiFi.status();
  if (s != last) {
    Serial.printf("status %d rssi %d\n", s, s == WL_CONNECTED ? WiFi.RSSI() : 0);
    if (s == WL_CONNECTED) fetch(URL, "again");
    last = s;
  }
  static unsigned long lastRssi = 0;
  if (millis() - lastRssi > 1000 && s == WL_CONNECTED) {
    lastRssi = millis();
    Serial.printf("rssi %d\n", WiFi.RSSI());
  }
  delay(20);
}
