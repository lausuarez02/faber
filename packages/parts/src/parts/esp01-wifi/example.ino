// ESP-01S (AT firmware) on SoftwareSerial: ESP TX → D2, ESP RX ← D3 (through a 1k/2k divider),
// VCC → 3V3. Moves a factory-fresh module from 115200 to 9600 baud, joins the Wi-Fi and makes
// one HTTP request, printing everything the module says on Serial.
#include <SoftwareSerial.h>

SoftwareSerial esp(2, 3);  // RX, TX

// Waits up to `ms` for `token`; echoes what arrives. Returns true when found.
bool expect(const char *token, unsigned long ms) {
  char win[16];
  memset(win, ' ', sizeof(win) - 1);
  win[sizeof(win) - 1] = 0;
  unsigned long start = millis();
  while (millis() - start < ms) {
    while (esp.available()) {
      char c = esp.read();
      Serial.write(c);
      memmove(win, win + 1, sizeof(win) - 2);
      win[sizeof(win) - 2] = c;
      if (c != 0 && strstr(win, token)) return true;
    }
  }
  return false;
}

void setup() {
  Serial.begin(115200);
  Serial.println(F("esp01 example"));
  esp.begin(9600);
  delay(600);  // let the module boot (it prints at 74880 baud first)
  esp.print(F("AT\r\n"));
  if (!expect("OK", 500)) {
    Serial.println(F("\n[no answer at 9600, switching the module from 115200]"));
    esp.begin(115200);
    esp.print(F("AT+UART_DEF=9600,8,1,0,0\r\n"));
    delay(50);
    esp.begin(9600);
    esp.print(F("AT\r\n"));
    if (!expect("OK", 800)) { Serial.println(F("\n[ESP not answering]")); for (;;) {} }
  }
  esp.print(F("ATE0\r\n"));
  expect("OK", 500);
  esp.print(F("AT+CWMODE=1\r\n"));
  expect("OK", 500);
  esp.print(F("AT+CWJAP=\"FaberNet\",\"\"\r\n"));
  if (!expect("OK", 15000)) { Serial.println(F("\n[join failed]")); for (;;) {} }
  Serial.println(F("\n[joined]"));
  esp.print(F("AT+CIPSTART=\"TCP\",\"ai.faber\",80\r\n"));
  if (!expect("OK", 5000)) { Serial.println(F("\n[connect failed]")); for (;;) {} }
  const char req[] = "GET /health HTTP/1.0\r\nHost: ai.faber\r\n\r\n";
  esp.print(F("AT+CIPSEND="));
  esp.print(strlen(req));
  esp.print(F("\r\n"));
  if (!expect(">", 2000)) { Serial.println(F("\n[no prompt]")); for (;;) {} }
  esp.print(req);
  if (!expect("CLOSED", 8000)) Serial.println(F("\n[no reply]"));
  Serial.println(F("\n[done]"));
}

void loop() {}
