// ============================================================
// Tarshid (ترشيد) Smart Library — ESP32 Firmware
// ============================================================
// Connects to Wi-Fi, reads RFID cards via MFRC522, sends UIDs
// to the Node.js backend over HTTPS (ngrok tunnel), and
// maintains a WebSocket connection for live status updates.
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
// On‑board LED (status)  →  GPIO 2
// ============================================================

#include <WiFi.h>
#include <WiFiClientSecure.h>
#include <HTTPClient.h>
#include <WebSocketsClient.h>
#include <ArduinoJson.h>
#include <SPI.h>
#include <MFRC522.h>

// ─── Function prototypes ────────────────────────────────────
void connectWiFi();
void connectWebSocket();
void webSocketEvent(WStype_t type, uint8_t* payload, size_t length);
String readRFID();
void sendRFID(String uid);

// ─── Wi-Fi credentials (change before upload) ───────────────
const char* WIFI_SSID     = "FCI";
const char* WIFI_PASSWORD = "waleed2233";

// ─── Server endpoints ───────────────────────────────────────
// ngrok URL (public) — change when tunnel restarts
const char* SERVER_HOST   = "unneeded-verbally-regalia.ngrok-free.dev";
const int   SERVER_PORT   = 443;  // HTTPS

// REST endpoint (POST RFID scans)
const String RFID_ENDPOINT = "/hardware/rfid";

// WebSocket path (for live status)
const String WS_PATH       = "/ws";

// ─── RFID config ────────────────────────────────────────────
#define RST_PIN  22
#define SS_PIN   5
MFRC522 rfid(SS_PIN, RST_PIN);

// ─── Buzzer pin (shared with onboard LED) ───────────────────
#define BUZZER_PIN 2

// ─── Globals ────────────────────────────────────────────────
WebSocketsClient webSocket;
unsigned long lastReconnectAttempt = 0;
const unsigned long WS_RECONNECT_INTERVAL = 5000;  // 5 seconds
bool wsConnected = false;

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

  // ── Connect WebSocket ──
  connectWebSocket();
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

  // ── Keep WebSocket alive ──
  webSocket.loop();
  if (!wsConnected && (millis() - lastReconnectAttempt > WS_RECONNECT_INTERVAL)) {
    lastReconnectAttempt = millis();
    connectWebSocket();
  }

  // ── Check for new RFID card ──
  if (rfid.PICC_IsNewCardPresent() && rfid.PICC_ReadCardSerial()) {
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
    digitalWrite(BUZZER_PIN, HIGH);
  } else {
    Serial.println("\n❌ Wi‑Fi connection failed. Restarting...");
    ESP.restart();
  }
}

// ============================================================
//  WebSocket CLIENT
// ============================================================
void connectWebSocket() {
  Serial.println("🔗 Connecting WebSocket...");
  webSocket.beginSSL(SERVER_HOST, SERVER_PORT, WS_PATH);
  webSocket.onEvent(webSocketEvent);
  webSocket.setReconnectInterval(5000);
}

void webSocketEvent(WStype_t type, uint8_t* payload, size_t length) {
  switch (type) {
    case WStype_DISCONNECTED:
      Serial.println("❌ WebSocket disconnected");
      wsConnected = false;
      break;

    case WStype_CONNECTED:
      Serial.println("✅ WebSocket connected");
      wsConnected = true;
      break;

    case WStype_TEXT: {
      // Parse incoming JSON (e.g., crowd level, status updates)
      JsonDocument doc;
      DeserializationError error = deserializeJson(doc, payload, length);
      if (error) {
        Serial.print("⚠️ WebSocket JSON parse error: ");
        Serial.println(error.c_str());
        return;
      }
      const char* type = doc["type"];
      if (type) {
        Serial.print("📩 WS message type: ");
        Serial.println(type);
        // Example: flash LED on status updates
        if (strcmp(type, "status_update") == 0) {
          digitalWrite(BUZZER_PIN, HIGH);
          delay(100);
          digitalWrite(BUZZER_PIN, LOW);
        }
      }
      break;
    }

    case WStype_ERROR:
      Serial.println("⚠️ WebSocket error");
      break;

    default:
      break;
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
