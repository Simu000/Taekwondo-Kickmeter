import asyncio
from bleak import BleakClient, BleakScanner
import json
import requests
from datetime import datetime, timezone
import time
import RPi.GPIO as GPIO
from hx711 import HX711
import os

# --- Import and Environment Setup ---
try:
    import Adafruit_ADS1x15
except ImportError:
    # Handle missing ADC library gracefully and instruct user on installation
    print("Error: Adafruit_ADS1x15 library not found.")
    print("Please install it using: sudo pip3 install adafruit-circuitpython-ads1x15")
    exit()

# ---------------- Firebase Settings ----------------
# URL for the Firebase Realtime Database endpoint where kick data will be pushed.
FIREBASE_URL = "https://taekwondo-kick-meter-default-rtdb.asia-southeast1.firebasedatabase.app/kick_data.json"

# ---------------- BLE Settings ----------------
# Expected name of the peripheral device (e.g., an Arduino or ESP32) broadcasting speed data.
DEVICE_NAME = "KickMeter"
# UUID of the GATT Characteristic used to read speed data from the peripheral device.
CHAR_UUID = "19b10001-e8f2-537e-4f6c-d104768a1200"

# ---------------- Load Cell Settings ----------------
# File path for storing and loading the HX711 calibration data (offset and scale ratio).
CALIB_FILE = "hx711_calibration.json"
# Minimum measured weight (in kg) required to register a kick event.
KICK_THRESHOLD_KG = 4.0
# Time (in seconds) to ignore subsequent load cell readings after a kick is detected (anti-bounce/cooldown).
KICK_COOLDOWN = 2.0
# Initialize GPIO settings for the Raspberry Pi.
GPIO.setmode(GPIO.BCM)
GPIO.setwarnings(False)
# Initialize the HX711 library with the Raspberry Pi GPIO pins.
hx = HX711(dout_pin=5, pd_sck_pin=6)

# ---------------- FSR Settings (Kick Accuracy/Edge Pressure) ----------------
# Initialize the ADS1015 Analog-to-Digital Converter (ADC) for FSR readings.
adc = Adafruit_ADS1x15.ADS1015(address=0x48, busnum=1)
# Programmable Gain Amplifier (PGA) setting for the ADC (1 = +/-4.096V).
GAIN = 1
# ADC channels connected to the Force Sensitive Resistors (FSRs).
FSR_CHANNELS = [0, 1, 3]
# Descriptive names for the FSR channels (for debugging, though not currently used in the main loop).
FSR_NAMES = ["Bottom (A0)", "Top (A1)", "Right (A3)"]
# Minimum and Maximum raw ADC values used to scale FSR readings to 0-100%.
FSR_MIN = -1
FSR_MAX = 1873
# Percentage threshold above which the kick is considered "lower accuracy" (hitting the edges).
WARNING_THRESHOLD = 50.0

# ---------------- Helper Functions ----------------

def fsr_percentage(raw, f_min, f_max):
    """
    Convert raw ADC reading to 0-100% normalized value.
    This logic protects against division by zero and ensures bounds (0% to 100%).
    """
    if f_max <= f_min:
        return 0.0
    # Clamp raw reading within defined min/max range
    raw = max(f_min, min(f_max, raw))
    # Calculate percentage
    percent = (raw - f_min) / (f_max - f_min) * 100
    # Ensure final percentage is between 0 and 100
    return max(0.0, min(100.0, percent))

def load_calibration():
    """Load and apply the previously saved HX711 calibration data."""
    try:
        if os.path.exists(CALIB_FILE):
            with open(CALIB_FILE, "r") as f:
                data = json.load(f)
                # Apply stored scale ratio and offset to the HX711 instance
                hx.set_scale_ratio(data["scale_ratio"])
                hx.set_offset(data["offset"])
            print("Load cell calibration loaded.")
            return True
        return False
    except Exception as e:
        print(f"Error loading calibration: {e}")
        return False
    
def calibrate_load_cell():
    """
    Run an interactive calibration process for the HX711 load cell.
    Calculates the zero offset and the scale ratio (grams/unit).
    """
    try:
        print("Calibrating load cell... Remove all weight.")
        # Step 1: Zero the scale (find the offset when nothing is on the scale)
        hx.zero()
        offset = hx.get_raw_data_mean(readings=50)
        print(f"Offset set: {offset}")

        # Step 2: Calculate the scale ratio using a known weight
        input("Place known weight on scale and press Enter: ")
        reading = hx.get_data_mean(readings=100)
        known_weight_grams = float(input('Enter the known weight in grams and press Enter: '))

        # Calculate the ratio (raw reading / actual weight)
        ratio = reading / known_weight_grams
        hx.set_scale_ratio(ratio)

        # Step 3: Save calibration data to file
        data = {
            "offset": offset,
            "scale_ratio": ratio
        }
        with open(CALIB_FILE, "w") as f:
            json.dump(data, f)

        print("Load cell calibration saved successfully!")
    except Exception as e:
        print(f"Calibration error: {e}")

def read_fsr_sensors():
    """
    Read all FSR sensors connected to the ADC and return the highest percentage
    to represent the maximum edge pressure.
    """
    try:
        percentages = []
        for ch in FSR_CHANNELS:
            # Read raw value from the specified ADC channel
            raw = adc.read_adc(ch, gain=GAIN)
            # Convert raw value to normalized percentage
            percent = fsr_percentage(raw, FSR_MIN, FSR_MAX)
            percentages.append(percent)
        # Return the maximum edge pressure detected
        return max(percentages)
    except Exception as e:
        print(f"FSR read error: {e}")
        return 0.0
    
def read_load_cell():
    """
    Read the load cell, convert the reading to weight (kg), and then to Force (N).
    Force (N) = Mass (kg) * 9.81 m/s^2 (acceleration due to gravity).
    """
    try:
        # Get weight in grams, using fewer readings for faster kick detection
        weight_g = hx.get_weight_mean(readings=5)
        # Convert to kilograms
        weight_kg = weight_g / 1000.0
        # Convert mass (kg) to force (Newtons)
        force_n = weight_kg * 9.81
        return weight_kg, force_n
    except Exception as e:
        print(f"Load cell read error: {e}")
        return 0.0, 0.0

def determine_accuracy(max_fsr_percent):
    """Categorize kick accuracy based on how much edge pressure was detected."""
    if max_fsr_percent >= WARNING_THRESHOLD:
        return "lower accuracy"
    else:
        return "higher accuracy"

def determine_kick_type(weight_kg):
    """Categorize kick strength based on the measured equivalent weight."""
    if 4 <= weight_kg < 5:
        return "Light Kick"
    elif 5 <= weight_kg <= 6.5:
        return "Medium Kick"
    elif weight_kg > 6.5:
        return "Strong Kick"
    else:
        return "No or very light contact"
    
# ---------------- Main Asynchronous Loop ----------------

async def main():
    """
    Main loop handles load cell initialization, BLE discovery/reconnection,
    kick detection, sensor data reading, and Firebase posting.
    """
    # Initialize load cell calibration before entering the main loop
    if not load_calibration():
        calibrate_load_cell()
    
    # Outer loop handles continuous scanning and reconnection if connection is lost
    while True:
        try:
            print("Scanning for BLE devices...")
            # Use BleakScanner to find devices
            devices = await BleakScanner.discover()
            target = None

            # Look for the device matching the predefined DEVICE_NAME
            for d in devices:
                if d.name and DEVICE_NAME in d.name:
                    target = d
                    break

            if target is None:
                print("KickMeter not found. Retrying in 5 seconds...")
                await asyncio.sleep(5)
                continue

            print(f"Found {DEVICE_NAME}: {target.address}")

            # Establish connection using the device's MAC address
            async with BleakClient(target.address) as client:
                print("Connected to Arduino!")
                print(f"System ready. Monitoring for kicks (threshold: {KICK_THRESHOLD_KG} kg)...\n")

                last_kick_time = 0  # Cooldown timer initialization
                
                # Inner loop handles continuous sensor monitoring and data processing
                while True:
                    try:
                        # --- Connection Check ---
                        if not client.is_connected:
                            print("Connection lost. Reconnecting...")
                            break

                        # --- Kick Detection (Primary Trigger) ---
                        weight_kg, force_n = read_load_cell()
                        current_time = time.time()

                        if weight_kg >= KICK_THRESHOLD_KG and (current_time - last_kick_time) > KICK_COOLDOWN:
                            last_kick_time = current_time  # Reset cooldown timer
                            
                            # Capture force/weight data used for the kick event
                            kick_weight = weight_kg
                            kick_force = force_n
                            
                            print(f"Kick detected! (Weight: {kick_weight:.2f} kg)")
                            
                            # --- Secondary Sensor Data Capture ---
                            
                            # Read BLE data (expected to be JSON with "speed" key)
                            try:
                                value = await client.read_gatt_char(CHAR_UUID)
                                data_str = value.decode("utf-8").strip()
                                # Assuming the BLE characteristic sends a JSON string
                                data = json.loads(data_str)
                                speed = float(data.get("speed", 0))
                            except Exception as e:
                                print(f"Error reading BLE data: {e}")
                                speed = 0.0

                            # Read FSR sensors for edge pressure
                            max_fsr_percent = read_fsr_sensors()
                            
                            # --- Data Analysis and Formatting ---
                            accuracy = determine_accuracy(max_fsr_percent)
                            kick_type = determine_kick_type(kick_weight)

                            # Get high-resolution timestamps
                            local_time = datetime.now().isoformat()
                            utc_time = datetime.now(timezone.utc).isoformat()

                            # --- Console Output (Debugging/Real-time Display) ---
                            print(f"  Kick Type: {kick_type}")
                            print(f"  Force: {kick_force:.2f} N")
                            print(f"  Edge Pressure: {max_fsr_percent:.1f}%")
                            print(f"  Accuracy: {accuracy}")
                            print(f"  Speed: {speed:.2f} m/s")
                            print(f"  Time: {local_time}\n")
                            
                            # --- Firebase Payload Creation ---
                            # This payload structure exactly matches the Firebase image requested previously.
                            payload = {
                                "force_of_kick_in_newton": kick_force,
                                "pressure_at_edges_in_percentage": max_fsr_percent,
                                "accuracy": accuracy,
                                "speed_of_kick_in_meters_per_second": speed,
                                "timestamp_utc": utc_time,
                                "timestamp_local": local_time,
                                "kick_detection_state": "kick_detected"
                            }
                            
                            # --- Send Data to Firebase ---
                            try:
                                # POST request to push a new record to the database
                                response = requests.post(FIREBASE_URL, json=payload, timeout=10)
                                if response.status_code == 200:
                                    print("Data sent to Firebase successfully!\n")
                                else:
                                    print(f"Firebase error: {response.status_code}\n")
                            except Exception as e:
                                print(f"Firebase connection error: {e}\n")

                        # Pause briefly before the next load cell read cycle
                        await asyncio.sleep(0.1)

                    except Exception as e:
                        print(f"Loop error: {e}")
                        await asyncio.sleep(1)
                        
        except Exception as e:
            print(f"Connection error: {e}")
            print("Reconnecting in 5 seconds...")
            await asyncio.sleep(5)
            
# ---------------- Entry Point and Cleanup ----------------

if __name__ == "__main__":
    try:
        # Run the asynchronous main function
        asyncio.run(main())
    except KeyboardInterrupt:
        # Clean up GPIO pins when the script is manually stopped (Ctrl+C)
        print("\nExiting...")
        GPIO.cleanup()