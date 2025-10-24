"""
Taekwondo Kick Detection System
Main module for real-time kick detection using HX711 load cell, FSR sensors, and BLE communication
"""

import asyncio
from bleak import BleakClient, BleakScanner
import json
import requests
from datetime import datetime, timezone
import time
import RPi.GPIO as GPIO
from hx711 import HX711
import os

try:
    import Adafruit_ADS1x15
except ImportError:
    print("Error: Adafruit_ADS1x15 library not found.")
    print("Please install it using: sudo pip3 install adafruit-circuitpython-ads1x15")
    exit()

# ==================== CONFIGURATION CONSTANTS ====================

# Firebase Realtime Database URL for storing kick data
FIREBASE_URL = "https://taekwondo-kick-meter-default-rtdb.asia-southeast1.firebasedatabase.app/kick_data.json"

# BLE Device Configuration
DEVICE_NAME = "KickMeter"  # Name of the BLE device to connect to
CHAR_UUID = "19b10001-e8f2-537e-4f6c-d104768a1200"  # Characteristic UUID for speed data

# Load Cell Configuration
CALIB_FILE = "hx711_calibration.json"  # File to store calibration data
KICK_THRESHOLD_KG = 4.0  # Minimum force in kg to register as a valid kick
KICK_COOLDOWN = 1.0  # Minimum seconds between kick detections (prevents multiple triggers)

# GPIO Pin Configuration for HX711
GPIO.setmode(GPIO.BCM)
GPIO.setwarnings(False)
hx = HX711(dout_pin=5, pd_sck_pin=6)  # HX711 data and clock pins

# FSR Sensor Configuration
adc = Adafruit_ADS1x15.ADS1015(address=0x48, busnum=1)  # I2C address and bus for ADC
GAIN = 1  # ADC gain setting
FSR_CHANNELS = [0, 1, 3]  # ADC channels connected to FSR sensors
FSR_NAMES = ["Bottom (A0)", "Top (A1)", "Right (A3)"]  # Descriptive names for FSR positions
FSR_MIN = -1  # Minimum raw ADC value for FSR calibration
FSR_MAX = 1873  # Maximum raw ADC value for FSR calibration
WARNING_THRESHOLD = 50.0  # FSR percentage threshold for accuracy classification

# ==================== GLOBAL VARIABLES ====================

# Impact Detection Variables
force_history = []  # Circular buffer for storing recent force readings for peak detection
last_kick_time = 0  # Timestamp of last detected kick for cooldown management

# ==================== HELPER FUNCTIONS ====================

def fsr_percentage(raw, f_min, f_max):
    """
    Convert raw ADC reading to percentage value (0-100%).
    
    Args:
        raw (float): Raw ADC reading from FSR sensor
        f_min (float): Minimum calibration value (no pressure)
        f_max (float): Maximum calibration value (full pressure)
    
    Returns:
        float: Percentage value between 0-100%
    """
    if f_max <= f_min:
        return 0.0
    # Clamp raw value within calibration range
    raw = max(f_min, min(f_max, raw))
    # Convert to percentage
    percent = (raw - f_min) / (f_max - f_min) * 100
    return max(0.0, min(100.0, percent))


def load_calibration():
    """
    Load HX711 calibration data from JSON file.
    
    Returns:
        bool: True if calibration loaded successfully, False otherwise
    """
    try:
        if os.path.exists(CALIB_FILE):
            with open(CALIB_FILE, "r") as f:
                data = json.load(f)
                # Apply calibration parameters to HX711
                hx.set_scale_ratio(data["scale_ratio"])
                hx.set_offset(data["offset"])
            print("Load cell calibration loaded successfully.")
            return True
        return False
    except Exception as e:
        print(f"Error loading calibration: {e}")
        return False


def calibrate_load_cell():
    """
    Perform one-time calibration of the HX711 load cell.
    Guides user through offset and scale ratio calculation.
    """
    try:
        print("Starting load cell calibration...")
        print("Please remove all weight from the sensor and press Enter.")
        input()
        
        # Calculate offset (zero point)
        hx.zero()
        offset = hx.get_raw_data_mean(readings=50)
        print(f"Offset calibration complete: {offset}")
        
        # Calculate scale ratio using known weight
        input("Place a known weight on the sensor and press Enter: ")
        reading = hx.get_data_mean(readings=100)
        known_weight_grams = float(input('Enter the known weight in grams and press Enter: '))
        
        # Calculate and apply scale ratio
        ratio = reading / known_weight_grams
        hx.set_scale_ratio(ratio)
        
        # Save calibration data to file
        calibration_data = {
            "offset": offset,
            "scale_ratio": ratio
        }
        with open(CALIB_FILE, "w") as f:
            json.dump(calibration_data, f)
            
        print("Load cell calibration saved successfully!")
        
    except Exception as e:
        print(f"Calibration error: {e}")


def read_fsr_sensors():
    """
    Read all FSR sensors and return the maximum pressure percentage.
    
    Returns:
        float: Maximum pressure percentage from all FSR sensors (0-100%)
    """
    try:
        percentages = []
        for channel in FSR_CHANNELS:
            # Read raw ADC value from each FSR channel
            raw_value = adc.read_adc(channel, gain=GAIN)
            # Convert to percentage
            percent = fsr_percentage(raw_value, FSR_MIN, FSR_MAX)
            percentages.append(percent)
        # Return the highest pressure detected (worst-case accuracy)
        return max(percentages)
    except Exception as e:
        print(f"FSR read error: {e}")
        return 0.0


def read_load_cell_fast():
    """
    Read load cell with minimal delay for quick impact detection.
    Uses fewer readings than standard method for faster response.
    
    Returns:
        tuple: (weight_kg, force_newtons) - Weight in kg and force in Newtons
    """
    try:
        # Use minimal readings for fastest response (tradeoff: slightly more noise)
        weight_grams = hx.get_weight_mean(readings=2)
        weight_kg = weight_grams / 1000.0
        force_newtons = weight_kg * 9.81  # Convert kg to Newtons (F = m*g)
        return weight_kg, force_newtons
    except Exception as e:
        print(f"Load cell read error: {e}")
        return 0.0, 0.0


def detect_impact(weight_kg):
    """
    Detect quick impacts using peak detection algorithm.
    Identifies rapid force spikes characteristic of martial arts kicks.
    
    Args:
        weight_kg (float): Current weight reading from load cell
    
    Returns:
        bool: True if impact detected, False otherwise
    """
    global force_history, last_kick_time
    
    current_time = time.time()
    
    # Add current reading to circular buffer
    force_history.append(weight_kg)
    
    # Maintain fixed-size history (last 3 readings)
    if len(force_history) > 3:
        force_history.pop(0)
    
    # Require minimum history for reliable detection
    if len(force_history) < 2:
        return False
    
    # Enforce cooldown period between detections
    if current_time - last_kick_time < KICK_COOLDOWN:
        return False
    
    # Check if force exceeds minimum threshold
    if weight_kg >= KICK_THRESHOLD_KG:
        # Peak detection: current value must be higher than previous reading
        # This ensures we capture the moment of impact, not sustained pressure
        if weight_kg > force_history[-2]:
            last_kick_time = current_time
            return True
    
    return False


def determine_accuracy(max_fsr_percent):
    """
    Classify kick accuracy based on FSR edge pressure.
    Lower edge pressure indicates better technique (center hits).
    
    Args:
        max_fsr_percent (float): Maximum pressure percentage from FSR sensors
    
    Returns:
        str: "higher accuracy" or "lower accuracy"
    """
    if max_fsr_percent >= WARNING_THRESHOLD:
        return "lower accuracy"  # High edge pressure = poor technique
    else:
        return "higher accuracy"  # Low edge pressure = good technique


def determine_kick_type(weight_kg):
    """
    Categorize kick based on force intensity.
    
    Args:
        weight_kg (float): Force of kick in kilograms
    
    Returns:
        str: Kick classification ("Light Kick", "Medium Kick", "Strong Kick")
    """
    if 4 <= weight_kg < 5:
        return "Light Kick"
    elif 5 <= weight_kg <= 6.5:
        return "Medium Kick"
    elif weight_kg > 6.5:
        return "Strong Kick"
    else:
        return "No or very light contact"


async def main():
    """
    Main application loop.
    Manages BLE connection, monitors sensors, and processes kick events.
    """
    # Initialize load cell with calibration data
    if not load_calibration():
        calibrate_load_cell()
    
    # Main reconnection loop - automatically recovers from connection failures
    while True:
        try:
            print("Scanning for BLE devices...")
            devices = await BleakScanner.discover()
            target_device = None

            # Search for KickMeter device by name
            for device in devices:
                if device.name and DEVICE_NAME in device.name:
                    target_device = device
                    break

            if target_device is None:
                print("KickMeter not found. Retrying in 5 seconds...")
                await asyncio.sleep(5)
                continue

            print(f"Found {DEVICE_NAME}: {target_device.address}")

            # Establish BLE connection
            async with BleakClient(target_device.address) as client:
                print("Connected to Arduino!")
                print(f"System ready. Monitoring for quick kicks (threshold: {KICK_THRESHOLD_KG} kg)...\n")

                # Main sensor monitoring loop
                while True:
                    try:
                        # Verify BLE connection health
                        if not client.is_connected:
                            print("Connection lost. Reconnecting...")
                            break

                        # Read load cell with fast sampling
                        weight_kg, force_newtons = read_load_cell_fast()
                        
                        # Check for impact using peak detection
                        if detect_impact(weight_kg):
                            # Capture all sensor data at moment of impact
                            kick_weight = weight_kg
                            kick_force = force_newtons
                            
                            print(f"Kick detected! (Weight: {kick_weight:.2f} kg)")
                            
                            # Read speed data from BLE device
                            try:
                                value = await client.read_gatt_char(CHAR_UUID)
                                data_str = value.decode("utf-8").strip()
                                sensor_data = json.loads(data_str)
                                speed = float(sensor_data.get("speed", 0))
                            except Exception as e:
                                print(f"Error reading BLE data: {e}")
                                speed = 0.0

                            # Read FSR sensors for accuracy assessment
                            max_fsr_percent = read_fsr_sensors()
                            
                            # Analyze kick characteristics
                            accuracy = determine_accuracy(max_fsr_percent)
                            kick_type = determine_kick_type(kick_weight)

                            # Generate timestamps
                            local_time = datetime.now().isoformat()
                            utc_time = datetime.now(timezone.utc).isoformat()

                            # Display kick analysis to console
                            print(f"  Kick Type: {kick_type}")
                            print(f"  Force: {kick_force:.2f} N")
                            print(f"  Edge Pressure: {max_fsr_percent:.1f}%")
                            print(f"  Accuracy: {accuracy}")
                            print(f"  Speed: {speed:.2f} m/s")
                            print(f"  Time: {local_time}\n")
                            
                            # Prepare data payload for Firebase
                            payload = {
                                "force_of_kick_in_newton": kick_force,
                                "pressure_at_edges_in_percentage": max_fsr_percent,
                                "accuracy": accuracy,
                                "speed_of_kick_in_meters_per_second": speed,
                                "timestamp_utc": utc_time,
                                "timestamp_local": local_time,
                                "kick_detection_state": "kick_detected"
                            }
                            
                            # Transmit data to Firebase
                            try:
                                response = requests.post(FIREBASE_URL, json=payload, timeout=10)
                                if response.status_code == 200:
                                    print("Data sent to Firebase successfully!\n")
                                else:
                                    print(f"Firebase error: {response.status_code}\n")
                            except Exception as e:
                                print(f"Firebase connection error: {e}\n")

                        # Brief sleep to balance responsiveness and CPU usage
                        await asyncio.sleep(0.05)

                    except Exception as e:
                        print(f"Monitoring loop error: {e}")
                        await asyncio.sleep(1)
                        
        except Exception as e:
            print(f"Connection error: {e}")
            print("Reconnecting in 5 seconds...")
            await asyncio.sleep(5)
            

if __name__ == "__main__":
    """
    Application entry point with graceful shutdown handling.
    """
    try:
        asyncio.run(main())
    except KeyboardInterrupt:
        print("\nExiting application...")
        GPIO.cleanup()  # Clean up GPIO resources
