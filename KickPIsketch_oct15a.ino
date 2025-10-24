#include <Arduino_LSM6DS3.h>
#include <ArduinoBLE.h>
#include <ArduinoJson.h>

const float G = 9.81f;
const float KICK_THRESHOLD_G = 3.0f;
const float KICK_JERK_THRESHOLD = 50.0f;
const unsigned long SAMPLE_INTERVAL_MS = 10;
const unsigned long MIN_TIME_BETWEEN_KICKS_MS = 1000;
const unsigned long KICK_WINDOW_MS = 200;
const unsigned long STABILIZATION_TIME_MS = 3000;
const int BASELINE_SAMPLES = 20;

float baselineAx = 0, baselineAy = 0, baselineAz = 0;
unsigned long lastKickMillis = 0;
unsigned long startupTime = 0;
float lastAccelMagnitude = 0;
bool isStabilized = false;

// BLE UUIDs
BLEService kickService("19b10000-e8f2-537e-4f6c-d104768a1200");
BLECharacteristic kickChar("19b10001-e8f2-537e-4f6c-d104768a1200",
                            BLERead | BLENotify, 64);

void sendKickBLE(float peakAccel, float kickSpeed) {
  StaticJsonDocument<128> doc;
  doc["accel"] = peakAccel * G;
  doc["speed"] = kickSpeed;
  char buffer[64];
  serializeJson(doc, buffer);
  kickChar.writeValue(buffer);
  // Optional debug output
  // Serial.print("BLE Sent: "); Serial.println(buffer);
}

void setup() {
  // Initialize Serial for optional debugging (won't block)
  Serial.begin(115200);
  // while (!Serial);  <-- removed for headless operation

  // Initialize IMU
  if (!IMU.begin()) {
    // Cannot continue without IMU
    Serial.println("Failed to initialize IMU!");
    while (1);
  }

  // Calibrate baseline acceleration
  Serial.println("Calibrating IMU...");
  for (int i = 0; i < BASELINE_SAMPLES; i++) {
    float ax, ay, az;
    while (!IMU.accelerationAvailable());
    IMU.readAcceleration(ax, ay, az);
    baselineAx += ax; baselineAy += ay; baselineAz += az;
    delay(50);
  }
  baselineAx /= BASELINE_SAMPLES;
  baselineAy /= BASELINE_SAMPLES;
  baselineAz /= BASELINE_SAMPLES;
  startupTime = millis();
  Serial.println("Calibration complete!");

  // Initialize BLE
  if (!BLE.begin()) {
    Serial.println("BLE start failed!");
    while (1);
  }

  delay(200); // small delay to stabilize BLE
  BLE.setLocalName("KickMeter");
  BLE.setAdvertisedService(kickService);
  kickService.addCharacteristic(kickChar);
  BLE.addService(kickService);
  kickChar.writeValue("Ready");
  BLE.advertise();
  Serial.println("BLE Advertising as KickMeter");
}

void loop() {
  BLEDevice central = BLE.central();

  if (!isStabilized) {
    if (millis() - startupTime >= STABILIZATION_TIME_MS) {
      isStabilized = true;
      Serial.println("Ready to detect kicks!");
    }
    delay(100);
    return;
  }

  float ax, ay, az;
  if (!IMU.accelerationAvailable()) return;
  IMU.readAcceleration(ax, ay, az);

  float axNet = ax - baselineAx;
  float ayNet = ay - baselineAy;
  float azNet = az - baselineAz;
  float totalAccelG = sqrt(axNet * axNet + ayNet * ayNet + azNet * azNet);
  float jerk = abs(totalAccelG - lastAccelMagnitude) * (1000.0f / SAMPLE_INTERVAL_MS);
  lastAccelMagnitude = totalAccelG;

  unsigned long now = millis();
  if (totalAccelG > KICK_THRESHOLD_G &&
      jerk > KICK_JERK_THRESHOLD &&
      (now - lastKickMillis) >= MIN_TIME_BETWEEN_KICKS_MS) {

    lastKickMillis = now;
    float peakAccel = totalAccelG;
    float kickSpeed = 0.0f;
    unsigned long startTime = millis();
    unsigned long lastTime = startTime;
    int sampleCount = 0;
    float prevAccel = 0;

    while (millis() - startTime < KICK_WINDOW_MS) {
      if (IMU.accelerationAvailable()) {
        IMU.readAcceleration(ax, ay, az);
        axNet = ax - baselineAx;
        ayNet = ay - baselineAy;
        azNet = az - baselineAz;
        float accelMagnitude = sqrt(axNet * axNet + ayNet * ayNet + azNet * azNet) * G;

        float dt = (millis() - lastTime) / 1000.0f;
        if (sampleCount > 0 && dt > 0) {
          kickSpeed += (accelMagnitude + prevAccel) * 0.5f * dt;
        }
        prevAccel = accelMagnitude;
        lastTime = millis();
        sampleCount++;
        float currentG = accelMagnitude / G;
        if (currentG > peakAccel) peakAccel = currentG;
      }
      delay(SAMPLE_INTERVAL_MS);
    }

    if (sampleCount > 5 && kickSpeed > 1.0f && peakAccel > 3.5f) {
      kickSpeed *= 0.85f;
      if (kickSpeed > 25.0f) kickSpeed = 25.0f;
      sendKickBLE(peakAccel, kickSpeed);
    }
  }
  delay(SAMPLE_INTERVAL_MS);
}
