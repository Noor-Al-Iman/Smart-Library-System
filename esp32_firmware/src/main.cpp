// ============================================================
// Smart Library System — ESP32 Firmware
// ============================================================
// Connects to Wi-Fi, reads RFID cards via MFRC522, sends UIDs
// to the Node.js backend over HTTPS via ngrok tunnel.
//
// Hardware pinout (typical):
//   MFRC522 RFID Reader  →  ESP32
//   SDA (SS)             →  GPIO 5
//   SCK                  →  GPIO 18
//   MOSI                 →  GPIO 23
//   MISO                 →  GPIO 19
//   IRQ                  →  not connected
//   GND                  →  GND
//   RST                  →  GPIO 22
//   3.3V                 →  3.3V
//
// Buzzer + onboard LED   →  GPIO 2
// ============================================================

#include <WiFi.h>
#include <WiFiClientSecure.h>
#include <HTTPClient.h>
#include <ArduinoJson.h>
#include <SPI.h>
#include <MFRC522.h>

// ─── Function prototypes ────────────────────────────────────
void connectWiFi();
String readRFID();
void sendRFID(String uid);

// ─── Wi-Fi credentials (change before upload) ───────────────
const char* WIFI_SSID     = "";
const char* WIFI_PASSWORD = "";

// ─── Server endpoints ───────────────────────────────────────
// ngrok URL (public) — change when tunnel restarts
const char* SERVER_HOST   = "unneeded-verbally-regalia.ngrok-free.dev";
const int   SERVER_PORT   = 443;  // HTTPS

// REST endpoint (POST RFID scans)
const String RFID_ENDPOINT = "/hardware/rfid";

// ─── RFID config ────────────────────────────────────────────
#define RST_PIN  22
#define SS_PIN   5
MFRC522 rfid(SS_PIN, RST_PIN);

// ─── Buzzer pin (shared with onboard LED) ───────────────────
#define BUZZER_PIN 2

// ============================================================
//  SETUP
// ============================================================
void setup() {
  Serial.begin(115200);
  pinMode(BUZZER_PIN, OUTPUT);
  digitalWrite(BUZZER_PIN, LOW);

  // ── Start SPI + RFID ──
  SPI.begin();
  rfid.PCD_Init();
  Serial.println("📡 RFID reader initialized.");

  // ── Connect Wi‑Fi ──
  connectWiFi();
}

// ============================================================
//  MAIN LOOP
// ============================================================
void loop() {
  // ── Keep Wi‑Fi alive ──
  if (WiFi.status() != WL_CONNECTED) {
    Serial.println("⚠️ Wi‑Fi lost. Reconnecting...");
    connectWiFi();
  }

  // ── Check for new RFID card ──
  if (rfid.PICC_IsNewCardPresent() && rfid.PICC_ReadCardSerial()) {
    Serial.println("Card detected! Reading UID...");
    String uid = readRFID();
    Serial.println("📇 Card detected: " + uid);
    sendRFID(uid);
    digitalWrite(BUZZER_PIN, HIGH);
    delay(150);
    digitalWrite(BUZZER_PIN, LOW);
    rfid.PICC_HaltA();
    rfid.PCD_StopCrypto1();
    delay(1000);  // debounce
  }
}

// ============================================================
//  Wi‑Fi CONNECTION (with auto‑reconnect)
// ============================================================
void connectWiFi() {
  Serial.print("🔌 Connecting to Wi‑Fi");
  WiFi.begin(WIFI_SSID, WIFI_PASSWORD);
  WiFi.setAutoReconnect(true);

  int attempts = 0;
  while (WiFi.status() != WL_CONNECTED && attempts < 40) {
    delay(500);
    Serial.print(".");
    attempts++;
  }

  if (WiFi.status() == WL_CONNECTED) {
    Serial.println("\n✅ Wi‑Fi connected");
    Serial.print("   IP address: ");
    Serial.println(WiFi.localIP());
  } else {
    Serial.println("\n❌ Wi‑Fi connection failed. Restarting...");
    ESP.restart();
  }
}

// ============================================================
//  RFID CARD READER
// ============================================================
String readRFID() {
  String uid = "";
  for (byte i = 0; i < rfid.uid.size; i++) {
    if (rfid.uid.uidByte[i] < 0x10) uid += "0";
    uid += String(rfid.uid.uidByte[i], HEX);
  }
  uid.toUpperCase();
  return uid;
}

// ============================================================
//  SEND RFID SCAN TO SERVER (HTTPS POST)
// ============================================================
void sendRFID(String uid) {
  if (WiFi.status() != WL_CONNECTED) {
    Serial.println("⚠️ No Wi‑Fi, cannot send RFID");
    return;
  }

  WiFiClientSecure client;
  client.setInsecure();

  HTTPClient http;
  http.begin(client, "https://" + String(SERVER_HOST) + RFID_ENDPOINT);

  http.addHeader("Content-Type", "application/json");

  // Build JSON payload
  String jsonPayload;
  {
    JsonDocument doc;
    doc["uid"] = uid;
    serializeJson(doc, jsonPayload);
  }

  Serial.print("📤 POST " + RFID_ENDPOINT + " → ");
  Serial.println(jsonPayload);

  int httpCode = http.POST(jsonPayload);
  Serial.print("HTTP Response code: ");
  Serial.println(httpCode);
  String response = http.getString();

  if (httpCode > 0) {
    Serial.print("   Response (" + String(httpCode) + "): ");
    Serial.println(response);
  } else {
    Serial.print("❌ HTTP error: ");
    Serial.println(http.errorToString(httpCode).c_str());
  }

  http.end();
}
