#include <Arduino_LSM6DS3.h>   // IMU sensor (LSM6DS3) library
#include <ArduinoBLE.h>        // BLE communication library
#include <ArduinoJson.h>       // JSON serialization library

const float G = 9.81f;                        // Gravity constant (m/s²)
const float KICK_THRESHOLD_G = 3.0f;          // Minimum G-force to register as kick
const float KICK_JERK_THRESHOLD = 50.0f;      // Minimum jerk (rate of change) for valid kick
const unsigned long SAMPLE_INTERVAL_MS = 10;  // Sampling period (ms)
const unsigned long MIN_TIME_BETWEEN_KICKS_MS = 1000; // Debounce delay between kicks (ms)
const unsigned long KICK_WINDOW_MS = 200;     // Time window to capture each kick (ms)
const unsigned long STABILIZATION_TIME_MS = 3000; // Time before starting detection (ms)
const int BASELINE_SAMPLES = 20;              // Number of samples for baseline calibration

float baselineAx = 0, baselineAy = 0, baselineAz = 0;  // Baseline IMU offsets
unsigned long lastKickMillis = 0;                      // Timestamp of last detected kick
unsigned long startupTime = 0;                         // Time when setup completed
float lastAccelMagnitude = 0;                          // Last acceleration magnitude
bool isStabilized = false;                             // Flag for stabilization period completion

BLEService kickService("19b10000-e8f2-537e-4f6c-d104768a1200");  // Kick Meter Service UUID
BLECharacteristic kickChar("19b10001-e8f2-537e-4f6c-d104768a1200",
                           BLERead | BLENotify, 64);             // JSON payload characteristic

void sendKickBLE(float peakAccel, float kickSpeed) {
  StaticJsonDocument<128> doc;

  // Prepare JSON payload
  doc["accel"] = peakAccel * G;  // Convert from G to m/s²
  doc["speed"] = kickSpeed;      // Speed of kick in m/s

  char buffer[64];
  serializeJson(doc, buffer);

  // Send JSON string to BLE characteristic
  kickChar.writeValue(buffer);

}

void setup() {
  Serial.begin(115200);
  // Note: Do NOT block with while(!Serial); for headless (non-USB) operation

  // --- Initialize IMU sensor ---
  if (!IMU.begin()) {
    Serial.println("Error: Failed to initialize IMU!");
    while (1);  // Halt program (critical failure)
  }

  // --- Calibrate baseline acceleration (device resting) ---
  Serial.println("Calibrating IMU...");
  for (int i = 0; i < BASELINE_SAMPLES; i++) {
    float ax, ay, az;
    while (!IMU.accelerationAvailable());  // Wait for fresh sample
    IMU.readAcceleration(ax, ay, az);

    baselineAx += ax;
    baselineAy += ay;
    baselineAz += az;

    delay(50);
  }
  // Average out baseline readings
  baselineAx /= BASELINE_SAMPLES;
  baselineAy /= BASELINE_SAMPLES;
  baselineAz /= BASELINE_SAMPLES;
  startupTime = millis();
  Serial.println("Calibration complete!");

  // --- Initialize BLE ---
  if (!BLE.begin()) {
    Serial.println("Error: Failed to start BLE module!");
    while (1);  // Halt program if BLE not initialized
  }

  delay(200);  // Short delay for BLE stability

  BLE.setLocalName("KickMeter");           // Device name shown during scanning
  BLE.setAdvertisedService(kickService);   // Add primary service
  kickService.addCharacteristic(kickChar); // Add data characteristic
  BLE.addService(kickService);

  // Initial status message
  kickChar.writeValue("Ready");

  // Begin BLE advertising
  BLE.advertise();
  Serial.println("BLE Advertising as KickMeter");
}


void loop() {
  BLEDevice central = BLE.central();  // Listen for central (e.g., Raspberry Pi)

  // --- Wait for stabilization after startup ---
  if (!isStabilized) {
    if (millis() - startupTime >= STABILIZATION_TIME_MS) {
      isStabilized = true;
      Serial.println("System ready for kick detection!");
    }
    delay(100);
    return;
  }

  // --- Read accelerometer data ---
  float ax, ay, az;
  if (!IMU.accelerationAvailable()) return;
  IMU.readAcceleration(ax, ay, az);

  // Subtract baseline to get net acceleration
  float axNet = ax - baselineAx;
  float ayNet = ay - baselineAy;
  float azNet = az - baselineAz;

  // Compute total acceleration in G units
  float totalAccelG = sqrt(axNet * axNet + ayNet * ayNet + azNet * azNet);

  // Compute jerk (rate of change of acceleration)
  float jerk = abs(totalAccelG - lastAccelMagnitude) * (1000.0f / SAMPLE_INTERVAL_MS);
  lastAccelMagnitude = totalAccelG;

  unsigned long now = millis();

  // --- Kick detection logic ---
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

    // --- Capture acceleration data within kick window ---
    while (millis() - startTime < KICK_WINDOW_MS) {
      if (IMU.accelerationAvailable()) {
        IMU.readAcceleration(ax, ay, az);

        // Compute net acceleration
        axNet = ax - baselineAx;
        ayNet = ay - baselineAy;
        azNet = az - baselineAz;

        float accelMagnitude = sqrt(axNet * axNet + ayNet * ayNet + azNet * azNet) * G;

        // Numerical integration to approximate velocity
        float dt = (millis() - lastTime) / 1000.0f;
        if (sampleCount > 0 && dt > 0) {
          kickSpeed += (accelMagnitude + prevAccel) * 0.5f * dt;
        }

        prevAccel = accelMagnitude;
        lastTime = millis();
        sampleCount++;

        // Track maximum acceleration (peak)
        float currentG = accelMagnitude / G;
        if (currentG > peakAccel) peakAccel = currentG;
      }
      delay(SAMPLE_INTERVAL_MS);
    }

    // --- Validate and send kick data ---
    if (sampleCount > 5 && kickSpeed > 1.0f && peakAccel > 3.5f) {
      kickSpeed *= 0.85f;       // Apply correction factor
      if (kickSpeed > 25.0f)    // Limit unrealistic speeds
        kickSpeed = 25.0f;
      sendKickBLE(peakAccel, kickSpeed);
    }
  }

  delay(SAMPLE_INTERVAL_MS);  // Maintain stable sampling rate
}
