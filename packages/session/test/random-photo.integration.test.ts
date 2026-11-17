// Round 14: a camera device that acts "at random", tested deterministically, with real firmware in
// QEMU. Generic capabilities, proven together on one sketch (a XIAO ESP32-S3 Sense with a button):
//   - a fixed seed per test: esp_random() repeats, so the "random" wait is the same every run;
//   - said = the text the firmware sends to a speech API; preceded_by checks it was said 10 s before
//     the picture (expect_capture); a button press in the countdown means no picture;
//   - the upload is checked by content type and multipart fields, against an OpenAPI mock of the API
//     (requests that do not fit the spec get 400);
//   - offline: Wi-Fi drops, the photo goes to a LittleFS queue, the board reboots (reset_board), the
//     queue is still there, Wi-Fi comes back and it posts later;
//   - a service on this computer reached by a ".local" name (mDNS) through "local": true + "to";
//   - set_clock: NTP gives the time the test chose.
// Needs the native ESP32 toolchain + QEMU (faber setup esp32) or Docker; skipped otherwise.
import { spawn, type ChildProcess } from "node:child_process";
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { canBuildArduino } from "@faber/runner";
import { qemuImageAvailable } from "@faber/sim-backends/node";
import { ProjectSession } from "../src/index.ts";

const ready = qemuImageAvailable() && canBuildArduino("esp32:esp32:XIAO_ESP32S3").ok;
if (!ready) console.warn("skipping the random-photo firmware test: the ESP32 toolchain and QEMU are not ready (Fix: pnpm faber setup esp32)");

const SKETCH = `// Random photo: at a random moment it says it will take a picture in 10 s; a press skips it;
// otherwise it takes it, queues it on flash and posts it when Wi-Fi is up.
#include <WiFi.h>
#include <HTTPClient.h>
#include <NetworkClientSecure.h>
#include <LittleFS.h>
#include <time.h>
#include "esp_camera.h"

const int BUTTON = 1;  // [D0] to GND
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
  c.pixel_format = PIXFORMAT_JPEG; c.frame_size = FRAMESIZE_QVGA; c.jpeg_quality = 14;
  c.fb_count = 1; c.fb_location = CAMERA_FB_IN_PSRAM; c.grab_mode = CAMERA_GRAB_LATEST;
  return esp_camera_init(&c) == ESP_OK;
}

static int queued() {
  int n = 0;
  File d = LittleFS.open("/q");
  for (File f = d.openNextFile(); f; f = d.openNextFile()) n++;
  return n;
}

static void say(const char *text) {
  Serial.printf("announce: %s\\n", text);
  if (WiFi.status() != WL_CONNECTED) return;  // a real device would play a stored clip
  HTTPClient http;
  http.begin(tls, "https://api.voice.test/v1/audio/speech");
  http.addHeader("Content-Type", "application/json");
  String body = String("{\\"model\\":\\"tts-1\\",\\"voice\\":\\"alloy\\",\\"response_format\\":\\"pcm\\",\\"input\\":\\"") + text + "\\"}";
  int code = http.POST(body);
  if (code > 0) http.getString();
  http.end();
}

static bool post(const char *path) {
  File f = LittleFS.open(path, "r");
  if (!f) return false;
  size_t n = f.size();
  const char *head = "--b0undary\\r\\nContent-Disposition: form-data; name=\\"caption\\"\\r\\n\\r\\nTwinkle saw this\\r\\n--b0undary\\r\\nContent-Disposition: form-data; name=\\"photo\\"; filename=\\"photo.jpg\\"\\r\\nContent-Type: image/jpeg\\r\\n\\r\\n";
  const char *tail = "\\r\\n--b0undary--\\r\\n";
  size_t len = strlen(head) + n + strlen(tail);
  uint8_t *buf = (uint8_t *)ps_malloc(len);
  memcpy(buf, head, strlen(head));
  f.read(buf + strlen(head), n);
  memcpy(buf + strlen(head) + n, tail, strlen(tail));
  f.close();
  HTTPClient http;
  http.begin(tls, "https://api.social.test/v1/posts");
  http.addHeader("Content-Type", "multipart/form-data; boundary=b0undary");
  int code = http.POST(buf, len);
  free(buf);
  Serial.printf("post %s -> %d\\n", path, code);
  http.end();
  return code == 201;
}

static void flush() {
  if (WiFi.status() != WL_CONNECTED) return;
  File d = LittleFS.open("/q");
  String names[8]; int k = 0;
  for (File f = d.openNextFile(); f && k < 8; f = d.openNextFile()) names[k++] = String("/q/") + f.name();
  for (int i = 0; i < k; i++) if (post(names[i].c_str())) { LittleFS.remove(names[i]); Serial.printf("posted %s\\n", names[i].c_str()); }
}

void setup() {
  Serial.begin(115200);
  pinMode(BUTTON, INPUT_PULLUP);
  LittleFS.begin(true);
  LittleFS.mkdir("/q");
  Serial.printf("queue %d\\n", queued());
  Serial.println(initCamera() ? "camera ok" : "camera failed");
  tls.setInsecure();
  WiFi.begin("FaberNet", "password");
  for (int i = 0; i < 60 && WiFi.status() != WL_CONNECTED; i++) delay(100);
  if (WiFi.status() == WL_CONNECTED) {
    Serial.println("wifi ok");
    configTime(0, 0, "pool.ntp.org");
    struct tm t;
    if (getLocalTime(&t, 5000)) Serial.printf("year %d\\n", t.tm_year + 1900);
    HTTPClient h;  // a service on this computer, found by its .local name
    h.begin("http://mystar.local/hello");
    Serial.printf("local %d\\n", h.GET());
    h.end();
  }
}

unsigned long nextAt = 0, lastTry = 0;

void loop() {
  if (!nextAt) {
    long wait = 5 + (esp_random() % 16);  // 5 to 20 s: "random", but the same for one seed
    Serial.printf("next in %ld s\\n", wait);
    nextAt = millis() + wait * 1000;
  }
  if (WiFi.status() != WL_CONNECTED && millis() - lastTry > 3000) { lastTry = millis(); WiFi.reconnect(); }
  if (WiFi.status() == WL_CONNECTED && queued() && millis() - lastTry > 1000) { lastTry = millis(); flush(); }
  if (millis() < nextAt) { delay(20); return; }
  nextAt = 0;
  say("I'm taking a picture in 10 seconds");
  unsigned long t0 = millis();
  while (millis() - t0 < 10000) {
    if (digitalRead(BUTTON) == LOW) { Serial.println("skipped"); return; }
    delay(10);
  }
  camera_fb_t *fb = esp_camera_fb_get();
  if (!fb) { Serial.println("no frame"); return; }
  char path[24]; snprintf(path, sizeof path, "/q/%lu.jpg", millis());
  File f = LittleFS.open(path, "w"); f.write(fb->buf, fb->len); f.close();
  esp_camera_fb_return(fb);
  Serial.printf("queued %d\\n", queued());
  flush();
}
`;

const SOCIAL_SPEC = `openapi: 3.0.3
info: {title: Star social, version: "1"}
servers: [{url: "https://api.social.test/v1"}]
paths:
  /posts:
    post:
      operationId: createPost
      requestBody:
        required: true
        content:
          multipart/form-data:
            schema:
              type: object
              required: [photo, caption]
              properties:
                photo: {type: string, format: binary}
                caption: {type: string, maxLength: 280}
            encoding: {photo: {contentType: image/jpeg}}
      responses:
        "201":
          description: created
          content:
            application/json:
              schema:
                type: object
                properties:
                  id: {type: string, example: p_1}
                  status: {type: string, enum: [pending_review, published]}
`;

const call = (s: ProjectSession, op: string, args: Record<string, unknown> = {}) => s.call(op, args) as Promise<Record<string, any>>;
const POST_REQ = { host: "api.social.test", method: "POST", path: "/v1/posts", status: 201, content_type: "multipart/form-data", body_json: { "photo.content_type": "image/jpeg", "photo.filename": "photo.jpg", caption: "?" }, min_bytes: 1000 };

describe.skipIf(!ready)("random photo device: deterministic randomness, countdown, skip, offline queue (real build, real QEMU)", { timeout: 900_000 }, () => {
  const dir = mkdtempSync(join(tmpdir(), "faber-random-photo-"));
  const s = new ProjectSession({ dir, actor: "test" });
  // "A service the person runs on this computer": its own process, as it would be (run_tests runs the
  // simulation synchronously, so a server on this test's own event loop could not answer in time).
  let local: ChildProcess;
  let port = 0;
  const hitsFile = join(dir, "local-hits.txt");
  beforeAll(async () => {
    local = spawn(process.execPath, ["-e", `const fs=require("fs");const s=require("http").createServer((q,r)=>{fs.appendFileSync(${JSON.stringify(hitsFile)},q.method+" "+q.url+" "+q.headers.host+"\\n");r.end("hi from this computer")});s.listen(0,"127.0.0.1",()=>console.log(s.address().port))`], { stdio: ["ignore", "pipe", "inherit"] });
    port = await new Promise<number>((res) => local.stdout!.once("data", (d: Buffer) => res(Number(String(d).trim()))));
  });
  afterAll(() => {
    s.dispose();
    local?.kill();
    rmSync(dir, { recursive: true, force: true });
  });

  it("builds, and every behaviour is a passing, repeatable test", async () => {
    await call(s, "new_project", { template: "xiao-esp32s3-sense" });
    await call(s, "place_part", { type: "pushbutton", id: "btn" });
    const board = (s.project.parts.find((p) => p.type === "seeed-xiao-esp32s3-sense")!).id;
    await call(s, "connect", { from: `${board}.GND`, to: "btn.2a" });
    await call(s, "connect", { from: "btn.1a", to: `${board}.GPIO1` });
    mkdirSync(join(dir, "network"), { recursive: true });
    writeFileSync(join(dir, "network", "social.openapi.yaml"), SOCIAL_SPEC);
    await call(s, "set_network", { mode: "mock", allow: [{ host: "mystar.local", local: true, to: `http://127.0.0.1:${port}` }] });
    const added = await call(s, "add_mock_api", { mock: { kind: "openapi", host: "api.social.test", spec: "network/social.openapi.yaml" } });
    expect(added.mock.operations).toEqual(["POST /posts (createPost)"]);
    await call(s, "add_mock_api", { mock: { host: "api.voice.test", method: "POST", path: "/v1/audio/speech", response: { body_b64: Buffer.alloc(3200).toString("base64") } } });
    await call(s, "write_file", { path: "firmware/main.ino", content: SKETCH });
    const b = await call(s, "build");
    expect(b.ok, JSON.stringify(b).slice(0, 2000)).toBe(true);

    const B = board;
    await call(s, "write_scenario", {
      id: "snaps-after-countdown",
      timeout_ms: 90_000,
      clock: "2031-05-01T08:00:00Z",
      steps: [
        { expect_serial: "wifi ok", within_ms: 15_000 },
        { expect_serial: "year 2031", within_ms: 8000 },
        { expect_serial: "local 200", within_ms: 5000 },
        { said: "picture in 10 seconds", within_ms: 30_000 },
        { expect_capture: B, within_ms: 12_000, preceded_by: { said: "picture in 10", min_ms: 9500, max_ms: 11_500 } },
        { request: POST_REQ, within_ms: 15_000, preceded_by: { capture: true, max_ms: 15_000 } },
        { expect_serial: "posted", within_ms: 5000 },
      ],
    });
    await call(s, "write_scenario", {
      id: "skip-with-button",
      timeout_ms: 90_000,
      steps: [
        { said: "picture in 10 seconds", within_ms: 40_000 },
        { press: "btn", hold_ms: 200 },
        { expect_serial: "skipped", within_ms: 1000 },
        { expect_capture: true, absent: true, within_ms: 11_000 },
        { request: { host: "api.social.test", path: "/v1/posts" }, absent: true },
      ],
    });
    await call(s, "write_scenario", {
      id: "offline-queue-posts-later",
      timeout_ms: 120_000,
      steps: [
        { expect_serial: "wifi ok", within_ms: 15_000 },
        { network_fault: { kind: "wifi_drop" } },
        { expect_serial: "announce: I'm taking a picture", within_ms: 30_000 },
        { expect_capture: true, within_ms: 12_000, preceded_by: { serial: "announce:", min_ms: 9500, max_ms: 11_500 } },
        { expect_serial: "queued 1", within_ms: 3000 },
        { request: { host: "api.social.test", path: "/v1/posts" }, absent: true, within_ms: 2000 },
        { reset_board: true },
        { expect_serial: "queue 1", within_ms: 5000 },
        { network_fault: { kind: "clear" } },
        { request: POST_REQ, within_ms: 30_000 },
        { expect_serial: "posted", within_ms: 5000 },
      ],
    });
    for (const name of ["snaps-after-countdown", "skip-with-button", "offline-queue-posts-later"]) {
      const t = await call(s, "run_tests", { name });
      expect(t.failed, JSON.stringify(t.results, null, 1).slice(0, 6000)).toBe(0);
    }
    expect(readFileSync(hitsFile, "utf8")).toContain("GET /hello mystar.local");

    // the same seed gives the same "random" wait; another seed gives another
    const waitOf = (r: Record<string, any>) => /next in (\d+) s/.exec(String(r.serial))?.[1];
    const r1 = await call(s, "run", { ms: 10000, seed: 7, reset: true });
    const r2 = await call(s, "run", { ms: 10000, seed: 7, reset: true });
    const r3 = await call(s, "run", { ms: 10000, seed: 8, reset: true });
    expect(waitOf(r1)).toBeDefined();
    expect(waitOf(r2)).toBe(waitOf(r1));
    const others = [waitOf(r3)];
    for (const seed of [9, 10]) others.push(waitOf(await call(s, "run", { ms: 10000, seed, reset: true })));
    expect(others.some((w) => w !== waitOf(r1))).toBe(true);
    // a request that does not fit the OpenAPI spec gets 400 and says why
    const bad = await call(s, "try_request", { url: "https://api.social.test/v1/posts", method: "POST", headers: { "content-type": "application/json" }, body: "{}" });
    expect(bad.status).toBe(400);
    expect(JSON.stringify(bad)).toContain("the API takes multipart/form-data");
  });
});
