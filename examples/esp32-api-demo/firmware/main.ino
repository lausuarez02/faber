// API demo for a Seeed XIAO ESP32-S3 with a 0.96" SSD1306 OLED: joins Wi-Fi, fetches the current
// weather as JSON over HTTPS (Open-Meteo, no key needed), shows it on the OLED, and posts a reading
// over MQTT. Written for the real board: the real root CA (ISRG Root X1, Open-Meteo is on Let's
// Encrypt), plain WiFi.h, HTTPClient, ArduinoJson, PubSubClient. In Jumper the same source runs
// in the emulator; the simulation build joins the sandbox Wi-Fi, and the tests answer from a
// recorded cassette (network/cassettes/open-meteo.json) and a mock broker (network/mocks.json).
#include <WiFi.h>
#include <HTTPClient.h>
#include <WiFiClientSecure.h>
#include <PubSubClient.h>
#include <ArduinoJson.h>
#include <Wire.h>
#include <Adafruit_GFX.h>
#include <Adafruit_SSD1306.h>

// Your network. On a real device put your own here (or load them from Preferences).
#define WIFI_SSID "JumperNet"
#define WIFI_PASS "change-me-123"

static const char *WEATHER_URL = "https://api.open-meteo.com/v1/forecast?latitude=38.72&longitude=-9.14&current=temperature_2m,wind_speed_10m";
static const char *MQTT_HOST = "test.mosquitto.org";
static const char *MQTT_TOPIC = "jumper-demo/xiao-s3/reading";
static const char *MQTT_ACK = "jumper-demo/xiao-s3/ack";
static const unsigned long FETCH_EVERY_MS = 60000;

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

Adafruit_SSD1306 oled(128, 64, &Wire, -1);
static bool haveOled = false;
static WiFiClient mqttNet;
static PubSubClient mqtt(mqttNet);
static float tempC = NAN, windKmh = NAN;
static unsigned long lastFetch = 0;
static wl_status_t lastStatus = WL_IDLE_STATUS;

static void show(const char *line1, const char *line2) {
  if (!haveOled) return;
  oled.clearDisplay();
  oled.setTextColor(SSD1306_WHITE);
  oled.setTextSize(1);
  oled.setCursor(0, 0);
  oled.print("Lisbon");
  oled.setCursor(84, 0);
  oled.print(WiFi.status() == WL_CONNECTED ? "wifi" : "----");
  oled.setTextSize(2);
  oled.setCursor(0, 20);
  oled.print(line1);
  oled.setTextSize(1);
  oled.setCursor(0, 50);
  oled.print(line2);
  oled.display();
}

static bool fetchWeather() {
  WiFiClientSecure tls;
  tls.setCACert(ROOT_CA);
  HTTPClient http;
  http.setTimeout(8000);
  if (!http.begin(tls, WEATHER_URL)) return false;
  int code = http.GET();
  if (code != 200) {
    Serial.printf("weather error %d\n", code);
    show("no data", code > 0 ? "API error" : "no connection");
    http.end();
    return false;
  }
  JsonDocument doc;
  DeserializationError err = deserializeJson(doc, http.getStream());
  http.end();
  if (err) {
    Serial.printf("weather bad json %s\n", err.c_str());
    return false;
  }
  tempC = doc["current"]["temperature_2m"] | NAN;
  windKmh = doc["current"]["wind_speed_10m"] | NAN;
  Serial.printf("weather %.1f C wind %.1f km/h\n", tempC, windKmh);
  char big[16], small[32];
  snprintf(big, sizeof big, "%.1f C", tempC);
  snprintf(small, sizeof small, "wind %.0f km/h", windKmh);
  show(big, small);
  return true;
}

static void onMqtt(char *topic, byte *payload, unsigned int len) {
  Serial.printf("mqtt ack %.*s\n", (int)len, (const char *)payload);
}

static void postReading() {
  if (!mqtt.connected()) {
    mqtt.setServer(MQTT_HOST, 1883);
    mqtt.setCallback(onMqtt);
    String id = "xiao-" + WiFi.macAddress();
    id.replace(":", "");
    if (!mqtt.connect(id.c_str())) {
      Serial.printf("mqtt connect failed %d\n", mqtt.state());
      return;
    }
    mqtt.subscribe(MQTT_ACK);
  }
  char msg[96];
  snprintf(msg, sizeof msg, "{\"temp_c\":%.1f,\"wind_kmh\":%.1f,\"rssi\":%d}", tempC, windKmh, WiFi.RSSI());
  bool ok = mqtt.publish(MQTT_TOPIC, msg);
  Serial.printf("mqtt sent %d %s\n", ok, msg);
}

void setup() {
  Serial.begin(115200);
  delay(50);
  Serial.println("api demo boot");
  Wire.begin();
  haveOled = oled.begin(SSD1306_SWITCHCAPVCC, 0x3C);
  if (!haveOled) Serial.println("oled not found");
  show("...", "joining Wi-Fi");
  WiFi.mode(WIFI_STA);
  WiFi.begin(WIFI_SSID, WIFI_PASS);
}

void loop() {
  wl_status_t s = WiFi.status();
  if (s != lastStatus) {
    if (s == WL_CONNECTED) {
      Serial.printf("wifi up %s rssi %d\n", WiFi.localIP().toString().c_str(), WiFi.RSSI());
      lastFetch = 0;  // fetch now
    } else if (lastStatus == WL_CONNECTED) {
      Serial.printf("wifi lost %d\n", s);
      show("offline", "waiting for Wi-Fi");
    }
    lastStatus = s;
  }
  if (s == WL_CONNECTED && (lastFetch == 0 || millis() - lastFetch > FETCH_EVERY_MS)) {
    lastFetch = millis() | 1;
    if (fetchWeather()) postReading();
  }
  mqtt.loop();
  delay(10);
}
