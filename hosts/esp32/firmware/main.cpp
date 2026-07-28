#include <Arduino.h>
#include <ArduinoJson.h>
#include <BLEAdvertisedDevice.h>
#include <BLEDevice.h>
#include <BLEScan.h>
#include <BluetoothSerial.h>
#include <Preferences.h>
#include <SPI.h>
#include <SdFat.h>
#include <TFT_eSPI.h>
#include <WiFi.h>
#include <Wire.h>

#include <algorithm>
#include <cmath>
#include <cstddef>
#include <cstdio>
#include <cstdint>
#include <cstring>

#include <esp_heap_caps.h>
#include <esp_system.h>
#include <esp_timer.h>
#include <freertos/FreeRTOS.h>
#include <freertos/queue.h>
#include <freertos/semphr.h>
#include <freertos/task.h>

#include "runtime_abi.h"
#include "safety.h"

#if !defined(CONFIG_BT_ENABLED) || !defined(CONFIG_BLUEDROID_ENABLED)
#error Bluetooth support is required by Symbian Pocket.
#endif

namespace {

constexpr char FIRMWARE_NAME[] = "Symbian Pocket";
constexpr char FIRMWARE_VERSION[] = "0.1.1";

constexpr std::uint16_t SCREEN_WIDTH = 160;
constexpr std::uint16_t SCREEN_HEIGHT = 128;
constexpr std::size_t FRAME_PIXELS = SCREEN_WIDTH * SCREEN_HEIGHT;

constexpr int PIN_UP = 2;
constexpr int PIN_DOWN = 13;
constexpr int PIN_LEFT = 27;
constexpr int PIN_RIGHT = 35;
constexpr int PIN_A = 34;
constexpr int PIN_B = 12;
constexpr int PIN_BUZZER = 14;
constexpr int PIN_LIGHT = 36;
constexpr int PIN_TEMPERATURE = 39;
constexpr int PIN_TFT_CS = 5;
constexpr int PIN_SD_CS = 22;
constexpr int PIN_SD_MISO = 19;
constexpr int PIN_SD_MOSI = 23;
constexpr int PIN_SD_SCLK = 18;
constexpr int PIN_I2C_SDA = 21;
constexpr int PIN_I2C_SCL = 15;
constexpr int EXPANSION_PINS[] = {33, 32, 26, 25};

constexpr std::uint8_t CONTROLLER_ADDRESS = 0x40;
constexpr std::uint8_t LED1_REGISTER = 0xA0;
constexpr std::uint8_t LED2_REGISTER = 0xA1;
constexpr std::uint8_t MOTOR1_REGISTER = 0x0E;
constexpr std::uint8_t MOTOR2_REGISTER = 0x06;
constexpr std::uint8_t IMU_ADDRESS = 0x68;

constexpr std::uint32_t BUTTON_SELECT = 0x0001;
constexpr std::uint32_t BUTTON_START = 0x0008;
constexpr std::uint32_t BUTTON_UP = 0x0010;
constexpr std::uint32_t BUTTON_RIGHT = 0x0020;
constexpr std::uint32_t BUTTON_DOWN = 0x0040;
constexpr std::uint32_t BUTTON_LEFT = 0x0080;
constexpr std::uint32_t BUTTON_CIRCLE = 0x2000;
constexpr std::uint32_t BUTTON_CROSS = 0x4000;

constexpr std::uint32_t LONG_PRESS_MS = 850;
constexpr std::uint32_t OUTPUT_UNLOCK_MS = 30000;
constexpr std::uint32_t MOTOR_DEADMAN_MS = 2000;
constexpr std::size_t COMMAND_DEPTH = 8;
constexpr std::size_t EVENT_DEPTH = 6;
constexpr std::size_t EVENT_BYTES = 2048;

struct DeviceCommand {
    std::int32_t id = -1;
    char name[40] = {};
    char json[384] = {};
};

struct DeviceEvent {
    char json[EVENT_BYTES] = {};
};

struct SensorState {
    bool languageEnglish = false;
    std::uint32_t uptimeMs = 0;
    std::uint64_t sdBytes = 0;
    int lightRaw = 0;
    float temperatureC = 0;
    float accel[3] = {0, 0, 0};
    float gyro[3] = {0, 0, 0};
    float pitch = 0;
    float roll = 0;
    int wifiRssi = -127;
    char wifiSsid[33] = {};
    bool wifiConnected = false;
    bool bluetoothReady = false;
    bool sdMounted = false;
    bool imuAvailable = false;
    bool controllerAvailable = false;
    bool outputsUnlocked = false;
    std::uint32_t outputLeaseMs = 0;
};

struct Button {
    int pin = -1;
    std::uint32_t mask = 0;
    bool idle = HIGH;
    bool raw = HIGH;
    bool stable = HIGH;
    bool pressed = false;
    bool longSent = false;
    std::uint32_t changedAt = 0;
    std::uint32_t pressedAt = 0;

    void begin(int gpio, std::uint32_t pocketMask, bool pullup) {
        pin = gpio;
        mask = pocketMask;
        pinMode(pin, pullup ? INPUT_PULLUP : INPUT);
        raw = stable = idle = digitalRead(pin);
        changedAt = millis();
    }

    void calibrate() {
        int high = 0;
        for (int sample = 0; sample < 24; ++sample) {
            high += digitalRead(pin) == HIGH ? 1 : 0;
            delay(2);
        }
        idle = high >= 12 ? HIGH : LOW;
        raw = stable = idle;
        pressed = false;
        longSent = false;
        changedAt = millis();
    }

    void update(std::uint32_t now) {
        const bool level = digitalRead(pin);
        if (level != raw) {
            raw = level;
            changedAt = now;
        }
        if (stable != raw && now - changedAt >= 22) {
            stable = raw;
            pressed = stable != idle;
            if (pressed) {
                pressedAt = now;
                longSent = false;
            }
        }
    }
};

class ButtonPad {
public:
    void begin() {
        buttons_[0].begin(PIN_UP, BUTTON_UP, true);
        buttons_[1].begin(PIN_DOWN, BUTTON_DOWN, true);
        buttons_[2].begin(PIN_LEFT, BUTTON_LEFT, true);
        buttons_[3].begin(PIN_RIGHT, BUTTON_RIGHT, false);
        buttons_[4].begin(PIN_A, BUTTON_CROSS, false);
        buttons_[5].begin(PIN_B, BUTTON_CIRCLE, true);
        delay(120);
        for (auto& button : buttons_) button.calibrate();
    }

    std::uint32_t frame() {
        const std::uint32_t now = millis();
        for (auto& button : buttons_) {
            const bool wasPressed = button.pressed;
            button.update(now);
            const bool face = button.pin == PIN_A || button.pin == PIN_B;
            if (!face && button.pressed) heldMask_ |= button.mask;
            if (!face && wasPressed && !button.pressed) heldMask_ &= ~button.mask;

            // Match the original working tool firmware: face-button actions
            // happen on the debounced press edge, not only after release.
            // This makes A/B feel immediate and still permits the long-press
            // START/SELECT actions below.
            if (face && !wasPressed && button.pressed) {
                pulseMask_ |= button.mask;
            }
            if (face && button.pressed && !button.longSent &&
                now - button.pressedAt >= LONG_PRESS_MS) {
                pulseMask_ |= button.pin == PIN_A ? BUTTON_START : BUTTON_SELECT;
                button.longSent = true;
            }
        }
        const std::uint32_t result = heldMask_ | pulseMask_;
        pulseMask_ = 0;
        return result;
    }

    String idleLevels() const {
        String value;
        for (std::size_t index = 0; index < 6; ++index) {
            if (index) value += ',';
            value += buttons_[index].idle ? '1' : '0';
        }
        return value;
    }

    String rawLevels() const {
        String value;
        for (std::size_t index = 0; index < 6; ++index) {
            if (index) value += ',';
            value += digitalRead(buttons_[index].pin) == HIGH ? '1' : '0';
        }
        return value;
    }

private:
    Button buttons_[6];
    std::uint32_t heldMask_ = 0;
    std::uint32_t pulseMask_ = 0;
};

TFT_eSPI tft;
SdFs sd;
Preferences preferences;
BluetoothSerial serialBluetooth;
BLEScan* bleScan = nullptr;
ButtonPad buttons;
symbian::OutputLease outputLease(OUTPUT_UNLOCK_MS, MOTOR_DEADMAN_MS);

QueueHandle_t commandQueue = nullptr;
QueueHandle_t eventQueue = nullptr;
SemaphoreHandle_t spiMutex = nullptr;
portMUX_TYPE stateMux = portMUX_INITIALIZER_UNLOCKED;
SensorState sensorState;

std::uint16_t* framebuffer = nullptr;
volatile bool runtimeReady = false;
volatile bool forceRender = true;
volatile bool bluetoothInitialized = false;
volatile bool storageMounted = false;
volatile bool controllerPresent = false;
volatile bool imuPresent = false;
volatile bool frameDumpRequested = false;
volatile std::uint32_t injectedButtonMask = 0;
bool ledState[2] = {false, false};
bool expansionState = false;
bool toneInitialized = false;
std::uint32_t motorStopAt[2] = {0, 0};
std::uint32_t alarmAt[4] = {0, 0, 0, 0};
char alarmLabel[4][48] = {};
char pendingWifiSsid[33] = {};
std::int32_t nextCommandId = 1;

bool beforeDeadline(std::uint32_t now, std::uint32_t deadline) {
    return static_cast<std::int32_t>(deadline - now) > 0;
}

void copyText(char* destination, std::size_t capacity, const char* source) {
    if (!destination || capacity == 0) return;
    std::strncpy(destination, source ? source : "", capacity - 1);
    destination[capacity - 1] = '\0';
}

bool i2cPresent(std::uint8_t address) {
    Wire.beginTransmission(address);
    return Wire.endTransmission() == 0;
}

bool writeControllerRegister(std::uint8_t reg, std::uint8_t value) {
    if (!controllerPresent) return false;
    Wire.beginTransmission(CONTROLLER_ADDRESS);
    Wire.write(reg);
    Wire.write(value);
    const bool okay = Wire.endTransmission() == 0;
    controllerPresent = okay;
    return okay;
}

bool writeController(const std::uint8_t* data, std::size_t length) {
    if (!controllerPresent || !data || length == 0) return false;
    Wire.beginTransmission(CONTROLLER_ADDRESS);
    Wire.write(data, length);
    const bool okay = Wire.endTransmission() == 0;
    controllerPresent = okay;
    return okay;
}

bool setMotor(unsigned channel, int power) {
    if (channel < 1 || channel > 2) return false;
    const std::uint8_t reg = channel == 1 ? MOTOR1_REGISTER : MOTOR2_REGISTER;
    const bool reverse = power < 0;
    const std::uint8_t speed =
        static_cast<std::uint8_t>(std::min(255, std::abs(power) * 255 / 100));
    const std::uint16_t pwm = static_cast<std::uint16_t>(speed) << 4;
    std::uint8_t data[9] = {reg, 0, 0, 0, 0, 0, 0, 0, 0};
    if (reverse) {
        data[3] = pwm & 0xff;
        data[4] = pwm >> 8;
    } else {
        data[7] = pwm & 0xff;
        data[8] = pwm >> 8;
    }
    return writeController(data, sizeof(data));
}

void stopTone() {
    if (toneInitialized) {
        ledcWriteTone(0, 0);
        ledcDetachPin(PIN_BUZZER);
        toneInitialized = false;
    }
    pinMode(PIN_BUZZER, OUTPUT);
    digitalWrite(PIN_BUZZER, LOW);
}

void allOutputsOff() {
    const std::uint8_t motorOff[] = {0, 0, 0, 0, 0};
    if (controllerPresent) {
        writeControllerRegister(LED1_REGISTER, 0);
        writeControllerRegister(LED2_REGISTER, 0);
        writeController(motorOff, sizeof(motorOff));
    }
    ledState[0] = ledState[1] = false;
    motorStopAt[0] = motorStopAt[1] = 0;
    stopTone();
    for (int pin : EXPANSION_PINS) {
        pinMode(pin, OUTPUT);
        digitalWrite(pin, LOW);
    }
    expansionState = false;
    outputLease.allOff();
}

void updateCachedLease() {
    const std::uint32_t now = millis();
    portENTER_CRITICAL(&stateMux);
    sensorState.outputsUnlocked = outputLease.isUnlocked(now);
    sensorState.outputLeaseMs = sensorState.outputsUnlocked ? OUTPUT_UNLOCK_MS : 0;
    sensorState.controllerAvailable = controllerPresent;
    portEXIT_CRITICAL(&stateMux);
}

void pushEvent(const JsonDocument& document) {
    if (!eventQueue) return;
    DeviceEvent event;
    const std::size_t length = serializeJson(document, event.json, sizeof(event.json));
    if (length == 0 || length >= sizeof(event.json)) return;
    if (xQueueSend(eventQueue, &event, 0) != pdTRUE) {
        DeviceEvent discarded;
        xQueueReceive(eventQueue, &discarded, 0);
        xQueueSend(eventQueue, &event, 0);
    }
}

void pushResult(std::int32_t id, const char* type, bool okay, const char* error = nullptr) {
    StaticJsonDocument<256> document;
    document["id"] = id;
    document["type"] = type;
    document["ok"] = okay;
    if (!okay && error) document["error"] = error;
    pushEvent(document);
}

bool writeAllowed(const char* path) {
    return symbian::isSandboxWritePath(path);
}

void updateStorageState(bool mounted, std::uint64_t bytes) {
    storageMounted = mounted;
    portENTER_CRITICAL(&stateMux);
    sensorState.sdMounted = mounted;
    sensorState.sdBytes = bytes;
    portEXIT_CRITICAL(&stateMux);
}

bool mountStorage() {
    if (storageMounted) return true;
    if (spiMutex) xSemaphoreTake(spiMutex, portMAX_DELAY);
    pinMode(PIN_SD_CS, OUTPUT);
    digitalWrite(PIN_SD_CS, HIGH);
    pinMode(PIN_SD_MISO, INPUT_PULLUP);
    const SdSpiConfig config(PIN_SD_CS, SHARED_SPI, SD_SCK_MHZ(10), &SPI);
    const bool mounted = sd.begin(config);
    std::uint64_t bytes = 0;
    if (mounted) {
        bytes = static_cast<std::uint64_t>(sd.card()->sectorCount()) * 512ULL;
        sd.mkdir("/SymbianPocket", true);
    } else {
        sd.end();
        digitalWrite(PIN_SD_CS, HIGH);
    }
    if (spiMutex) xSemaphoreGive(spiMutex);
    updateStorageState(mounted, bytes);
    return mounted;
}

float temperatureFromRaw(int raw) {
    if (raw <= 1 || raw >= 4094) return NAN;
    constexpr float nominalResistance = 10000.0f;
    constexpr float nominalTemperature = 298.15f;
    constexpr float beta = 3950.0f;
    const float resistance = nominalResistance * static_cast<float>(raw) /
                             static_cast<float>(4095 - raw);
    const float inverseKelvin =
        1.0f / nominalTemperature + std::log(resistance / nominalResistance) / beta;
    return 1.0f / inverseKelvin - 273.15f;
}

void readImu(SensorState& state) {
    state.imuAvailable = imuPresent;
    if (!imuPresent) {
        std::fill(std::begin(state.accel), std::end(state.accel), 0.0f);
        std::fill(std::begin(state.gyro), std::end(state.gyro), 0.0f);
        state.pitch = state.roll = 0;
        return;
    }
    Wire.beginTransmission(IMU_ADDRESS);
    Wire.write(0x3B);
    if (Wire.endTransmission(false) != 0 ||
        Wire.requestFrom(static_cast<int>(IMU_ADDRESS), 14) != 14) {
        imuPresent = false;
        state.imuAvailable = false;
        return;
    }
    std::int16_t values[7] = {};
    for (auto& value : values) {
        value = static_cast<std::int16_t>((Wire.read() << 8) | Wire.read());
    }
    state.accel[0] = values[0] / 16384.0f;
    state.accel[1] = values[1] / 16384.0f;
    state.accel[2] = values[2] / 16384.0f;
    state.gyro[0] = values[4] / 131.0f;
    state.gyro[1] = values[5] / 131.0f;
    state.gyro[2] = values[6] / 131.0f;
    state.roll = std::atan2(state.accel[1], state.accel[2]) * 57.29578f;
    state.pitch = std::atan2(
        -state.accel[0],
        std::sqrt(state.accel[1] * state.accel[1] + state.accel[2] * state.accel[2])) *
        57.29578f;
}

void refreshSensors() {
    SensorState next;
    portENTER_CRITICAL(&stateMux);
    next = sensorState;
    portEXIT_CRITICAL(&stateMux);
    next.uptimeMs = millis();
    next.lightRaw = analogRead(PIN_LIGHT);
    const int temperatureRaw = analogRead(PIN_TEMPERATURE);
    const float calculated = temperatureFromRaw(temperatureRaw);
    next.temperatureC = std::isfinite(calculated) ? calculated : 0.0f;
    readImu(next);
    next.wifiConnected = WiFi.status() == WL_CONNECTED;
    next.wifiRssi = next.wifiConnected ? WiFi.RSSI() : -127;
    copyText(next.wifiSsid, sizeof(next.wifiSsid),
             next.wifiConnected ? WiFi.SSID().c_str() : "");
    next.bluetoothReady = bluetoothInitialized;
    next.sdMounted = storageMounted;
    next.controllerAvailable = controllerPresent;
    next.outputsUnlocked = outputLease.isUnlocked(next.uptimeMs);
    next.outputLeaseMs = next.outputsUnlocked ? OUTPUT_UNLOCK_MS : 0;
    portENTER_CRITICAL(&stateMux);
    sensorState = next;
    portEXIT_CRITICAL(&stateMux);
}

bool initializeBluetooth() {
    if (bluetoothInitialized) return true;
    const bool classic = serialBluetooth.begin("Symbian-Pocket", true);
    BLEDevice::init("Symbian Pocket");
    bleScan = BLEDevice::getScan();
    if (bleScan) {
        bleScan->setActiveScan(true);
        bleScan->setInterval(100);
        bleScan->setWindow(99);
    }
    bluetoothInitialized = classic || bleScan;
    return bluetoothInitialized;
}

void handleWifiScan(const DeviceCommand& command) {
    WiFi.mode(WIFI_STA);
    const int count = WiFi.scanNetworks(false, true);
    StaticJsonDocument<1900> document;
    document["id"] = command.id;
    document["type"] = "wifi.scan";
    document["ok"] = count >= 0;
    JsonArray data = document.createNestedArray("data");
    const int limit = std::min(count, 12);
    for (int index = 0; index < limit; ++index) {
        JsonObject item = data.createNestedObject();
        item["ssid"] = WiFi.SSID(index);
        item["rssi"] = WiFi.RSSI(index);
        item["channel"] = WiFi.channel(index);
        item["secure"] = WiFi.encryptionType(index) != WIFI_AUTH_OPEN;
    }
    if (count < 0) document["error"] = "Wi-Fi scan failed";
    WiFi.scanDelete();
    pushEvent(document);
}

void handleWifiConnect(const DeviceCommand& command, JsonVariantConst payload) {
    const char* ssid = payload["ssid"] | "";
    const char* password = payload["password"] | "";
    pendingWifiSsid[0] = '\0';
    if (!*ssid) {
        pushResult(command.id, command.name, false, "SSID is empty");
        return;
    }
    WiFi.mode(WIFI_STA);
    WiFi.disconnect(false, false);
    delay(80);
    WiFi.begin(ssid, password);
    const std::uint32_t deadline = millis() + 12000;
    while (WiFi.status() != WL_CONNECTED && beforeDeadline(millis(), deadline)) {
        vTaskDelay(pdMS_TO_TICKS(100));
    }
    if (WiFi.status() == WL_CONNECTED) {
        copyText(pendingWifiSsid, sizeof(pendingWifiSsid), ssid);
        pushResult(command.id, command.name, true);
    } else {
        pushResult(command.id, command.name, false, "Connection timed out");
    }
}

void handleRadioScan(const DeviceCommand& command, JsonVariantConst payload) {
    const char* kind = payload["kind"] | "ble";
    if (!initializeBluetooth()) {
        pushResult(command.id, command.name, false, "Bluetooth init failed");
        return;
    }
    StaticJsonDocument<1900> document;
    document["id"] = command.id;
    document["type"] = "radio.scan";
    document["ok"] = true;
    JsonArray data = document.createNestedArray("data");
    if (std::strcmp(kind, "classic") == 0) {
        BTScanResults* results = serialBluetooth.discover(5120);
        const int count = results ? std::min(results->getCount(), 10) : 0;
        for (int index = 0; index < count; ++index) {
            BTAdvertisedDevice* device = results->getDevice(index);
            if (!device) continue;
            JsonObject item = data.createNestedObject();
            item["name"] = device->haveName() ? device->getName() : "";
            item["address"] = device->getAddress().toString();
            item["rssi"] = device->haveRSSI() ? device->getRSSI() : -127;
            item["kind"] = "classic";
        }
    } else if (bleScan) {
        BLEScanResults results = bleScan->start(4, false);
        const int count = std::min(results.getCount(), 10);
        for (int index = 0; index < count; ++index) {
            BLEAdvertisedDevice device = results.getDevice(index);
            JsonObject item = data.createNestedObject();
            item["name"] = device.haveName() ? device.getName() : "";
            item["address"] = device.getAddress().toString();
            item["rssi"] = device.haveRSSI() ? device.getRSSI() : -127;
            item["kind"] = "ble";
        }
        bleScan->clearResults();
    }
    pushEvent(document);
}

bool parseBluetoothAddress(const char* text, std::uint8_t output[6]) {
    if (!text) return false;
    unsigned values[6] = {};
    if (std::sscanf(text, "%x:%x:%x:%x:%x:%x", &values[0], &values[1], &values[2],
                    &values[3], &values[4], &values[5]) != 6) {
        return false;
    }
    for (int index = 0; index < 6; ++index) output[index] = values[index] & 0xff;
    return true;
}

void handleStorageList(const DeviceCommand& command, JsonVariantConst payload) {
    const char* path = payload["path"] | "/SymbianPocket";
    if (!storageMounted) {
        pushResult(command.id, command.name, false, "SD card is not mounted");
        return;
    }
    if (spiMutex) xSemaphoreTake(spiMutex, portMAX_DELAY);
    FsFile directory = sd.open(path, O_RDONLY);
    StaticJsonDocument<1900> document;
    document["id"] = command.id;
    document["type"] = "storage.list";
    document["ok"] = static_cast<bool>(directory) && directory.isDirectory();
    JsonArray data = document.createNestedArray("data");
    if (directory && directory.isDirectory()) {
        FsFile entry;
        int count = 0;
        while (count < 24 && entry.openNext(&directory, O_RDONLY)) {
            char name[96] = {};
            entry.getName(name, sizeof(name));
            if (name[0] && name[0] != '.') {
                String display = name;
                if (entry.isDirectory()) display += '/';
                data.add(display);
                ++count;
            }
            entry.close();
        }
        directory.close();
    } else {
        document["error"] = "Folder is unavailable";
    }
    if (spiMutex) xSemaphoreGive(spiMutex);
    pushEvent(document);
}

void handleStorageAppend(const DeviceCommand& command, JsonVariantConst payload) {
    const char* path = payload["path"] | "";
    const char* text = payload["text"] | "";
    if (!storageMounted || !writeAllowed(path)) {
        pushResult(command.id, command.name, false,
                   storageMounted ? "Write path is outside /SymbianPocket" : "SD card is not mounted");
        return;
    }
    if (spiMutex) xSemaphoreTake(spiMutex, portMAX_DELAY);
    FsFile file = sd.open(path, O_WRONLY | O_CREAT | O_APPEND);
    const bool okay = file && file.println(text) > 0;
    if (file) {
        file.flush();
        file.close();
    }
    if (spiMutex) xSemaphoreGive(spiMutex);
    pushResult(command.id, command.name, okay, okay ? nullptr : "Write failed");
}

void handleMotorPulse(const DeviceCommand& command, JsonVariantConst payload) {
    const unsigned channel = payload["channel"] | 0;
    const int power = std::max(-100, std::min(100, payload["power"] | 25));
    const std::uint32_t duration =
        std::min<std::uint32_t>(MOTOR_DEADMAN_MS, payload["durationMs"] | 500);
    const std::uint32_t now = millis();
    if (!controllerPresent) {
        pushResult(command.id, command.name, false, "Motor controller 0x40 is unavailable");
        return;
    }
    if (!outputLease.startMotor(channel, now)) {
        pushResult(command.id, command.name, false, "Hold A to unlock motor outputs");
        return;
    }
    const bool okay = setMotor(channel, power);
    if (okay) {
        motorStopAt[channel - 1] = now + duration;
    } else {
        outputLease.stopMotor(channel);
    }
    pushResult(command.id, command.name, okay, okay ? nullptr : "Motor command failed");
}

void handleCommand(const DeviceCommand& command) {
    StaticJsonDocument<512> payloadDocument;
    const auto error = deserializeJson(payloadDocument, command.json);
    JsonVariantConst payload = payloadDocument.as<JsonVariantConst>();
    if (error) {
        pushResult(command.id, command.name, false, "Invalid JSON payload");
        return;
    }

    if (std::strcmp(command.name, "wifi.scan") == 0) {
        handleWifiScan(command);
    } else if (std::strcmp(command.name, "wifi.connect") == 0) {
        handleWifiConnect(command, payload);
    } else if (std::strcmp(command.name, "wifi.save") == 0) {
        const char* ssid = payload["ssid"] | "";
        const char* password = payload["password"] | "";
        const bool connected = WiFi.status() == WL_CONNECTED;
        const String activeSsid = connected ? WiFi.SSID() : "";
        const bool okay = connected && *ssid &&
                          std::strcmp(ssid, pendingWifiSsid) == 0 &&
                          activeSsid.equals(ssid);
        if (okay) {
            preferences.putString("wifiSsid", ssid);
            preferences.putString("wifiPass", password);
            pendingWifiSsid[0] = '\0';
        }
        pushResult(command.id, command.name, okay,
                   okay ? nullptr : "No matching successful Wi-Fi connection");
    } else if (std::strcmp(command.name, "wifi.forget") == 0) {
        pendingWifiSsid[0] = '\0';
        preferences.remove("wifiSsid");
        preferences.remove("wifiPass");
        WiFi.disconnect(true, false);
        pushResult(command.id, command.name, true);
    } else if (std::strcmp(command.name, "radio.scan") == 0) {
        handleRadioScan(command, payload);
    } else if (std::strcmp(command.name, "bluetooth.select") == 0) {
        if (!initializeBluetooth()) {
            pushResult(command.id, command.name, false, "Bluetooth init failed");
        } else {
            std::uint8_t address[6] = {};
            const char* value = payload["address"] | "";
            const bool okay = parseBluetoothAddress(value, address) &&
                              serialBluetooth.connect(address);
            pushResult(command.id, command.name, okay,
                       okay ? nullptr : "Classic Bluetooth connection failed");
        }
    } else if (std::strcmp(command.name, "bluetooth.send") == 0) {
        const char* text = payload["text"] | "";
        bool sent = false;
        if (initializeBluetooth() && serialBluetooth.connected()) {
            sent = serialBluetooth.write(
                       reinterpret_cast<const std::uint8_t*>(text), std::strlen(text)) > 0;
            serialBluetooth.write('\n');
        }
        if (storageMounted) {
            if (spiMutex) xSemaphoreTake(spiMutex, portMAX_DELAY);
            FsFile outbox = sd.open(
                "/SymbianPocket/messages-outbox.txt", O_WRONLY | O_CREAT | O_APPEND);
            if (outbox) {
                outbox.println(text);
                outbox.close();
            }
            if (spiMutex) xSemaphoreGive(spiMutex);
        }
        StaticJsonDocument<256> document;
        document["id"] = command.id;
        document["type"] = command.name;
        document["ok"] = true;
        document["data"]["sent"] = sent;
        pushEvent(document);
    } else if (std::strcmp(command.name, "storage.list") == 0) {
        handleStorageList(command, payload);
    } else if (std::strcmp(command.name, "storage.append") == 0) {
        handleStorageAppend(command, payload);
    } else if (std::strcmp(command.name, "storage.prepare") == 0) {
        const bool okay = mountStorage();
        pushResult(command.id, command.name, okay,
                   okay ? nullptr : "SD card not detected or filesystem unsupported");
    } else if (std::strcmp(command.name, "alarm.add") == 0) {
        const std::uint32_t minutes = std::max<std::uint32_t>(
            1, std::min<std::uint32_t>(24 * 60, payload["afterMinutes"] | 5));
        int slot = -1;
        for (int index = 0; index < 4; ++index) {
            if (alarmAt[index] == 0) {
                slot = index;
                break;
            }
        }
        if (slot >= 0) {
            alarmAt[slot] = millis() + minutes * 60000UL;
            copyText(alarmLabel[slot], sizeof(alarmLabel[slot]),
                     payload["label"] | "Symbian Pocket");
            pushResult(command.id, command.name, true);
        } else {
            pushResult(command.id, command.name, false, "Alarm list is full");
        }
    } else if (std::strcmp(command.name, "tone.play") == 0) {
        const int frequency = std::max(80, std::min(4000, payload["frequency"] | 880));
        const int duration = std::max(20, std::min(2000, payload["durationMs"] | 180));
        ledcSetup(0, frequency, 10);
        ledcAttachPin(PIN_BUZZER, 0);
        toneInitialized = true;
        ledcWriteTone(0, frequency);
        vTaskDelay(pdMS_TO_TICKS(duration));
        stopTone();
        pushResult(command.id, command.name, true);
    } else if (std::strcmp(command.name, "output.unlock") == 0) {
        outputLease.unlock(millis());
        updateCachedLease();
        pushResult(command.id, command.name, true);
    } else if (std::strcmp(command.name, "output.allOff") == 0) {
        allOutputsOff();
        updateCachedLease();
        pushResult(command.id, command.name, true);
    } else if (std::strcmp(command.name, "output.toggle") == 0) {
        const char* target = payload["target"] | "";
        bool okay = false;
        if (std::strcmp(target, "led1") == 0 || std::strcmp(target, "led2") == 0) {
            const int index = target[3] == '1' ? 0 : 1;
            ledState[index] = !ledState[index];
            okay = writeControllerRegister(index == 0 ? LED1_REGISTER : LED2_REGISTER,
                                             ledState[index] ? 1 : 0);
            if (!okay) ledState[index] = false;
        } else if (std::strcmp(target, "gpio") == 0) {
            expansionState = !expansionState;
            for (int pin : EXPANSION_PINS) digitalWrite(pin, expansionState ? HIGH : LOW);
            okay = true;
        }
        pushResult(command.id, command.name, okay, okay ? nullptr : "Output is unavailable");
    } else if (std::strcmp(command.name, "motor.pulse") == 0) {
        handleMotorPulse(command, payload);
    } else if (std::strcmp(command.name, "settings.language") == 0) {
        const char* language = payload["language"] | "zh";
        const bool english = std::strcmp(language, "en") == 0;
        preferences.putString("language", english ? "en" : "zh");
        portENTER_CRITICAL(&stateMux);
        sensorState.languageEnglish = english;
        portEXIT_CRITICAL(&stateMux);
        pushResult(command.id, command.name, true);
    } else if (std::strcmp(command.name, "settings.rotation") == 0) {
        pushResult(command.id, command.name, (payload["rotation"] | 3) == 3,
                   "This board profile uses rotation 3");
    } else if (std::strcmp(command.name, "settings.defaults") == 0) {
        const String savedSsid =
            preferences.isKey("wifiSsid") ? preferences.getString("wifiSsid", "") : "";
        const String savedPass =
            preferences.isKey("wifiPass") ? preferences.getString("wifiPass", "") : "";
        preferences.clear();
        if (!savedSsid.isEmpty()) {
            preferences.putString("wifiSsid", savedSsid);
            preferences.putString("wifiPass", savedPass);
        }
        portENTER_CRITICAL(&stateMux);
        sensorState.languageEnglish = false;
        portEXIT_CRITICAL(&stateMux);
        pushResult(command.id, command.name, true);
    } else {
        pushResult(command.id, command.name, false, "Unknown device command");
    }
}

void pollBluetoothMessages() {
    if (!bluetoothInitialized || !serialBluetooth.available()) return;
    char message[240] = {};
    std::size_t length = 0;
    while (serialBluetooth.available() && length + 1 < sizeof(message)) {
        const int value = serialBluetooth.read();
        if (value < 0 || value == '\n') break;
        if (value != '\r') message[length++] = static_cast<char>(value);
    }
    if (length == 0) return;
    StaticJsonDocument<384> document;
    document["id"] = 0;
    document["type"] = "bluetooth.message";
    document["ok"] = true;
    document["data"]["text"] = message;
    pushEvent(document);
}

void serviceDeadlines() {
    const std::uint32_t now = millis();
    for (unsigned channel = 1; channel <= 2; ++channel) {
        const int index = channel - 1;
        if (motorStopAt[index] &&
            (!beforeDeadline(now, motorStopAt[index]) ||
             !outputLease.motorRunning(channel, now))) {
            setMotor(channel, 0);
            outputLease.stopMotor(channel);
            motorStopAt[index] = 0;
        }
    }
    if (!outputLease.isUnlocked(now) && (motorStopAt[0] || motorStopAt[1])) {
        setMotor(1, 0);
        setMotor(2, 0);
        motorStopAt[0] = motorStopAt[1] = 0;
    }
    for (int index = 0; index < 4; ++index) {
        if (alarmAt[index] && !beforeDeadline(now, alarmAt[index])) {
            StaticJsonDocument<256> document;
            document["id"] = 0;
            document["type"] = "alarm.fire";
            document["ok"] = true;
            document["data"]["label"] = alarmLabel[index];
            pushEvent(document);
            alarmAt[index] = 0;
            alarmLabel[index][0] = '\0';
        }
    }
    updateCachedLease();
}

void deviceTask(void*) {
    std::uint32_t lastSensors = 0;
    for (;;) {
        DeviceCommand command;
        if (xQueueReceive(commandQueue, &command, pdMS_TO_TICKS(10)) == pdTRUE) {
            handleCommand(command);
        }
        const std::uint32_t now = millis();
        if (now - lastSensors >= 100) {
            lastSensors = now;
            refreshSensors();
        }
        serviceDeadlines();
        pollBluetoothMessages();
    }
}

void showBootError(int code) {
    if (spiMutex) xSemaphoreTake(spiMutex, portMAX_DELAY);
    tft.fillScreen(TFT_NAVY);
    tft.setTextColor(TFT_WHITE, TFT_NAVY);
    tft.drawCentreString("SYMBIAN POCKET", 80, 35, 2);
    tft.setTextColor(TFT_YELLOW, TFT_NAVY);
    tft.drawCentreString("PocketJS boot error", 80, 65, 1);
    tft.drawCentreString(String(code), 80, 82, 2);
    if (spiMutex) xSemaphoreGive(spiMutex);
}

std::uint32_t takeInjectedButtons() {
    portENTER_CRITICAL(&stateMux);
    const std::uint32_t mask = injectedButtonMask;
    injectedButtonMask = 0;
    portEXIT_CRITICAL(&stateMux);
    return mask;
}

void requestInjectedButton(std::uint32_t mask) {
    portENTER_CRITICAL(&stateMux);
    injectedButtonMask |= mask;
    portEXIT_CRITICAL(&stateMux);
}

void dumpFramebuffer() {
    if (!framebuffer) return;
    constexpr std::size_t bytes = FRAME_PIXELS * sizeof(std::uint16_t);
    Serial.printf(
        "SP_FRAME_BEGIN {\"width\":%u,\"height\":%u,\"bytes\":%u}\n",
        SCREEN_WIDTH,
        SCREEN_HEIGHT,
        static_cast<unsigned>(bytes));
    Serial.write(reinterpret_cast<const std::uint8_t*>(framebuffer), bytes);
    Serial.print("\nSP_FRAME_END\n");
    Serial.flush();
}

void pollSerialConsole() {
    while (Serial.available()) {
        const char command = static_cast<char>(Serial.read());
        if (command == 's' || command == 'S') {
            Serial.printf(
                "SP_CONSOLE {\"ready\":%s,\"freeHeap\":%u,\"freePsram\":%u,"
                "\"qjsPeak\":%u}\n",
                runtimeReady ? "true" : "false",
                ESP.getFreeHeap(),
                ESP.getFreePsram(),
                static_cast<unsigned>(pocketjs_runtime_qjs_peak_bytes()));
        } else if (command == 'x' || command == 'X') {
            allOutputsOff();
            Serial.println("SP_CONSOLE {\"outputsOff\":true}");
        } else if (command == 'p' || command == 'P') {
            frameDumpRequested = true;
        } else if (command == 'k' || command == 'K') {
            Serial.printf(
                "SP_KEYS {\"order\":[\"up\",\"down\",\"left\",\"right\",\"a\",\"b\"],"
                "\"idle\":[%s],\"raw\":[%s]}\n",
                buttons.idleLevels().c_str(),
                buttons.rawLevels().c_str());
        } else if (command == 'u' || command == 'U') {
            requestInjectedButton(BUTTON_UP);
        } else if (command == 'd' || command == 'D') {
            requestInjectedButton(BUTTON_DOWN);
        } else if (command == 'l' || command == 'L') {
            requestInjectedButton(BUTTON_LEFT);
        } else if (command == 'r' || command == 'R') {
            requestInjectedButton(BUTTON_RIGHT);
        } else if (command == 'a' || command == 'A') {
            requestInjectedButton(BUTTON_CROSS);
        } else if (command == 'b' || command == 'B') {
            requestInjectedButton(BUTTON_CIRCLE);
        } else if (command == 'q' || command == 'Q') {
            requestInjectedButton(BUTTON_START);
        } else if (command == 'e' || command == 'E') {
            requestInjectedButton(BUTTON_SELECT);
        }
    }
}

void runtimeTask(void*) {
    const int initialized = pocketjs_runtime_init(
        symbian_pocket_qbc,
        symbian_pocket_qbc_len,
        symbian_pocket_pak,
        symbian_pocket_pak_len,
        SCREEN_WIDTH,
        SCREEN_HEIGHT);
    if (initialized != 0) {
        Serial.printf("SP_BOOT {\"ready\":false,\"stage\":\"runtime\",\"code\":%d}\n", initialized);
        showBootError(initialized);
        vTaskDelete(nullptr);
        return;
    }

    runtimeReady = true;
    forceRender = true;
    Serial.printf(
        "SP_BOOT {\"ready\":true,\"firmware\":\"%s\",\"version\":\"%s\","
        "\"host\":\"esp32\",\"quickjs\":true,\"pocketjsCore\":true,"
        "\"width\":160,\"height\":128,\"rotation\":3}\n",
        FIRMWARE_NAME,
        FIRMWARE_VERSION);

    std::uint32_t frameCount = 0;
    std::uint32_t renderCount = 0;
    std::uint32_t statusAt = millis();
    std::uint32_t statusFrames = 0;
    std::uint32_t statusRenders = 0;
    std::uint32_t lastPhysicalMask = 0;
    std::int64_t nextFrame = esp_timer_get_time();

    for (;;) {
        nextFrame += 16667;
        // The runtime task has a higher priority than Arduino's loop task so
        // that display cadence remains deterministic. Poll UART here as well,
        // otherwise sustained native redraws can starve debug/input commands.
        pollSerialConsole();
        const std::uint32_t physicalMask = buttons.frame();
        const std::uint32_t serialMask = takeInjectedButtons();
        const std::uint32_t mask = physicalMask | serialMask;
        const int changed = pocketjs_runtime_frame(mask);
        ++frameCount;
        if (changed < 0) {
            Serial.printf("SP_RUNTIME {\"frameError\":%d}\n", changed);
        }
        if (mask != 0 && (serialMask != 0 || physicalMask != lastPhysicalMask)) {
            Serial.printf(
                "SP_INPUT {\"source\":\"%s\",\"mask\":%lu,\"changed\":%d}\n",
                serialMask ? "serial" : "physical",
                static_cast<unsigned long>(mask),
                changed);
            // Always transfer the resulting frame on input. This keeps
            // immediate key feedback visible even if a future draw-list
            // optimization reports an unchanged hash.
            forceRender = true;
        }
        lastPhysicalMask = physicalMask;
        if (changed > 0 || forceRender) {
            forceRender = false;
            if (pocketjs_runtime_render_rgb565(framebuffer, FRAME_PIXELS) == 0) {
                if (spiMutex) xSemaphoreTake(spiMutex, portMAX_DELAY);
                tft.pushImage(0, 0, SCREEN_WIDTH, SCREEN_HEIGHT, framebuffer);
                if (spiMutex) xSemaphoreGive(spiMutex);
                ++renderCount;
            }
        }
        if (frameDumpRequested) {
            frameDumpRequested = false;
            dumpFramebuffer();
        }

        const std::uint32_t nowMs = millis();
        if (nowMs - statusAt >= 5000) {
            const std::uint32_t elapsed = nowMs - statusAt;
            const float fps = (frameCount - statusFrames) * 1000.0f / elapsed;
            const float renderFps = (renderCount - statusRenders) * 1000.0f / elapsed;
            statusFrames = frameCount;
            statusRenders = renderCount;
            statusAt = nowMs;
            SensorState state;
            portENTER_CRITICAL(&stateMux);
            state = sensorState;
            portEXIT_CRITICAL(&stateMux);
            Serial.printf(
                "SP_STATUS {\"uptimeMs\":%lu,\"fps\":%.1f,\"renderFps\":%.1f,"
                "\"freeHeap\":%u,\"freePsram\":%u,\"qjsPeak\":%u,"
                "\"wifi\":%s,\"bluetooth\":%s,\"sd\":%s,\"imu\":%s,"
                "\"controller40\":%s,\"outputsUnlocked\":%s}\n",
                static_cast<unsigned long>(nowMs),
                fps,
                renderFps,
                ESP.getFreeHeap(),
                ESP.getFreePsram(),
                static_cast<unsigned>(pocketjs_runtime_qjs_peak_bytes()),
                state.wifiConnected ? "true" : "false",
                state.bluetoothReady ? "true" : "false",
                state.sdMounted ? "true" : "false",
                state.imuAvailable ? "true" : "false",
                state.controllerAvailable ? "true" : "false",
                state.outputsUnlocked ? "true" : "false");
        }

        std::int64_t remaining = nextFrame - esp_timer_get_time();
        if (remaining > 2000) {
            vTaskDelay(pdMS_TO_TICKS(static_cast<std::uint32_t>((remaining - 1000) / 1000)));
        }
        while ((remaining = nextFrame - esp_timer_get_time()) > 0) {
            delayMicroseconds(static_cast<unsigned>(std::min<std::int64_t>(remaining, 250)));
        }
        if (remaining < -100000) nextFrame = esp_timer_get_time();
    }
}

void initializeHardware() {
    pinMode(PIN_BUZZER, OUTPUT);
    digitalWrite(PIN_BUZZER, LOW);
    for (int pin : EXPANSION_PINS) {
        pinMode(pin, OUTPUT);
        digitalWrite(pin, LOW);
    }
    analogReadResolution(12);
    analogSetPinAttenuation(PIN_LIGHT, ADC_11db);
    analogSetPinAttenuation(PIN_TEMPERATURE, ADC_11db);

    Wire.begin(PIN_I2C_SDA, PIN_I2C_SCL, 100000);
    Wire.setTimeOut(30);
    controllerPresent = i2cPresent(CONTROLLER_ADDRESS);
    imuPresent = i2cPresent(IMU_ADDRESS);
    if (imuPresent) {
        Wire.beginTransmission(IMU_ADDRESS);
        Wire.write(0x6B);
        Wire.write(0);
        if (Wire.endTransmission() != 0) imuPresent = false;
    }
    allOutputsOff();

    // Keep the other SPI peripheral deselected while probing the card.
    pinMode(PIN_TFT_CS, OUTPUT);
    digitalWrite(PIN_TFT_CS, HIGH);
    SPI.begin(PIN_SD_SCLK, PIN_SD_MISO, PIN_SD_MOSI, PIN_SD_CS);
    mountStorage();

    tft.init();
    tft.setRotation(3);
    tft.invertDisplay(false);
    tft.setSwapBytes(true);
    tft.fillScreen(TFT_NAVY);
    tft.setTextColor(TFT_WHITE, TFT_NAVY);
    tft.drawCentreString("SYMBIAN POCKET", 80, 45, 2);
    tft.drawCentreString("PocketJS + QuickJS", 80, 70, 1);
    buttons.begin();

    portENTER_CRITICAL(&stateMux);
    sensorState.controllerAvailable = controllerPresent;
    sensorState.imuAvailable = imuPresent;
    sensorState.sdMounted = storageMounted;
    portEXIT_CRITICAL(&stateMux);
}

void connectSavedWifi() {
    if (!preferences.isKey("wifiSsid")) return;
    const String ssid = preferences.getString("wifiSsid", "");
    if (ssid.isEmpty()) return;
    const String password =
        preferences.isKey("wifiPass") ? preferences.getString("wifiPass", "") : "";
    WiFi.mode(WIFI_STA);
    WiFi.begin(ssid.c_str(), password.c_str());
}

}  // namespace

extern "C" void* pocketjs_heap_alloc(std::size_t size, std::size_t alignment) {
    const std::size_t actualAlignment = std::max<std::size_t>(alignment, 8);
    return heap_caps_aligned_alloc(
        actualAlignment, std::max<std::size_t>(size, 1), MALLOC_CAP_SPIRAM | MALLOC_CAP_8BIT);
}

extern "C" void pocketjs_heap_free(void* pointer) {
    heap_caps_free(pointer);
}

namespace {
struct alignas(8) QuickJsAllocation {
    std::size_t size;
    std::uint32_t magic;
};
constexpr std::uint32_t QUICKJS_ALLOCATION_MAGIC = 0x51534a50;
}  // namespace

extern "C" void* pocketjs_qjs_alloc(std::size_t size) {
    auto* allocation = static_cast<QuickJsAllocation*>(heap_caps_aligned_alloc(
        alignof(QuickJsAllocation),
        sizeof(QuickJsAllocation) + std::max<std::size_t>(size, 1),
        MALLOC_CAP_SPIRAM | MALLOC_CAP_8BIT));
    if (!allocation) return nullptr;
    allocation->size = size;
    allocation->magic = QUICKJS_ALLOCATION_MAGIC;
    return allocation + 1;
}

extern "C" void pocketjs_qjs_free(void* pointer) {
    if (!pointer) return;
    auto* allocation = static_cast<QuickJsAllocation*>(pointer) - 1;
    if (allocation->magic == QUICKJS_ALLOCATION_MAGIC) {
        allocation->magic = 0;
        heap_caps_free(allocation);
    }
}

extern "C" void* pocketjs_qjs_realloc(void* pointer, std::size_t size) {
    if (!pointer) return pocketjs_qjs_alloc(size);
    if (size == 0) {
        pocketjs_qjs_free(pointer);
        return nullptr;
    }
    auto* oldAllocation = static_cast<QuickJsAllocation*>(pointer) - 1;
    if (oldAllocation->magic != QUICKJS_ALLOCATION_MAGIC) return nullptr;
    void* replacement = pocketjs_qjs_alloc(size);
    if (!replacement) return nullptr;
    std::memcpy(replacement, pointer, std::min(oldAllocation->size, size));
    pocketjs_qjs_free(pointer);
    return replacement;
}

extern "C" std::size_t pocketjs_qjs_usable_size(const void* pointer) {
    if (!pointer) return 0;
    const auto* allocation = static_cast<const QuickJsAllocation*>(pointer) - 1;
    return allocation->magic == QUICKJS_ALLOCATION_MAGIC ? allocation->size : 0;
}

extern "C" void pocketjs_log(const std::uint8_t* message, std::size_t length) {
    Serial.print("[PocketJS] ");
    if (message && length) Serial.write(message, length);
    Serial.println();
}

extern "C" void pocketjs_panic() {
    allOutputsOff();
    Serial.println("SP_RUNTIME {\"panic\":true,\"outputsOff\":true}");
    Serial.flush();
    delay(50);
    esp_restart();
}

extern "C" std::int32_t pocketjs_device_command(
    const std::uint8_t* name,
    std::size_t nameLength,
    const std::uint8_t* json,
    std::size_t jsonLength) {
    if (!commandQueue || !name || nameLength == 0 || nameLength >= sizeof(DeviceCommand::name) ||
        !json || jsonLength >= sizeof(DeviceCommand::json)) {
        return -1;
    }
    DeviceCommand command;
    command.id = nextCommandId++;
    std::memcpy(command.name, name, nameLength);
    command.name[nameLength] = '\0';
    std::memcpy(command.json, json, jsonLength);
    command.json[jsonLength] = '\0';
    if (xQueueSend(commandQueue, &command, 0) != pdTRUE) return -1;
    return command.id;
}

extern "C" std::size_t pocketjs_device_poll(std::uint8_t* output, std::size_t capacity) {
    if (!eventQueue || !output || capacity == 0) return 0;
    DeviceEvent event;
    if (xQueueReceive(eventQueue, &event, 0) != pdTRUE) return 0;
    const std::size_t length = std::min(std::strlen(event.json), capacity);
    std::memcpy(output, event.json, length);
    return length;
}

extern "C" std::size_t pocketjs_device_snapshot(std::uint8_t* output, std::size_t capacity) {
    if (!output || capacity == 0) return 0;
    SensorState state;
    portENTER_CRITICAL(&stateMux);
    state = sensorState;
    portEXIT_CRITICAL(&stateMux);
    StaticJsonDocument<768> document;
    document["language"] = state.languageEnglish ? "en" : "zh";
    document["uptimeMs"] = millis();
    document["heapInternal"] = ESP.getFreeHeap();
    document["heapPsram"] = ESP.getFreePsram();
    document["lightRaw"] = state.lightRaw;
    document["temperatureC"] = state.temperatureC;
    JsonArray accel = document.createNestedArray("accel");
    JsonArray gyro = document.createNestedArray("gyro");
    for (int index = 0; index < 3; ++index) {
        accel.add(state.accel[index]);
        gyro.add(state.gyro[index]);
    }
    document["pitch"] = state.pitch;
    document["roll"] = state.roll;
    document["imuAvailable"] = state.imuAvailable;
    document["controllerAvailable"] = state.controllerAvailable;
    document["wifiConnected"] = state.wifiConnected;
    document["wifiSsid"] = state.wifiSsid;
    document["wifiRssi"] = state.wifiRssi;
    document["bluetoothReady"] = state.bluetoothReady;
    document["sdMounted"] = state.sdMounted;
    document["sdBytes"] = state.sdBytes;
    document["outputsUnlocked"] = state.outputsUnlocked;
    document["outputLeaseMs"] = state.outputLeaseMs;
    return serializeJson(document, reinterpret_cast<char*>(output), capacity);
}

void setup() {
    Serial.begin(115200);
    delay(250);
    Serial.println();
    Serial.printf("SP_START {\"firmware\":\"%s\",\"version\":\"%s\"}\n",
                  FIRMWARE_NAME, FIRMWARE_VERSION);
    Serial.printf(
        "SP_HARDWARE {\"chip\":\"%s\",\"revision\":%u,\"flashBytes\":%u,"
        "\"psramBytes\":%u}\n",
        ESP.getChipModel(),
        ESP.getChipRevision(),
        ESP.getFlashChipSize(),
        ESP.getPsramSize());

    commandQueue = xQueueCreate(COMMAND_DEPTH, sizeof(DeviceCommand));
    eventQueue = xQueueCreate(EVENT_DEPTH, sizeof(DeviceEvent));
    spiMutex = xSemaphoreCreateMutex();
    preferences.begin("sympocket", false);
    const String savedLanguage =
        preferences.isKey("language") ? preferences.getString("language", "zh") : "zh";
    portENTER_CRITICAL(&stateMux);
    sensorState.languageEnglish = savedLanguage == "en";
    portEXIT_CRITICAL(&stateMux);

    initializeHardware();
    WiFi.persistent(false);
    WiFi.setAutoReconnect(true);
    WiFi.setSleep(true);
    connectSavedWifi();

    framebuffer = static_cast<std::uint16_t*>(heap_caps_malloc(
        FRAME_PIXELS * sizeof(std::uint16_t), MALLOC_CAP_SPIRAM | MALLOC_CAP_8BIT));
    if (!framebuffer || !commandQueue || !eventQueue || !spiMutex) {
        Serial.println("SP_BOOT {\"ready\":false,\"stage\":\"allocation\",\"code\":-100}");
        showBootError(-100);
        return;
    }

    Serial.printf(
        "SP_INVENTORY {\"controller40\":%s,\"imu68\":%s,\"sdMounted\":%s,"
        "\"buttonsIdle\":[%s],\"outputsOff\":true}\n",
        controllerPresent ? "true" : "false",
        imuPresent ? "true" : "false",
        storageMounted ? "true" : "false",
        buttons.idleLevels().c_str());

    Serial.printf(
        "SP_TASK_HEAP {\"freeInternal\":%u,\"largestInternal\":%u}\n",
        heap_caps_get_free_size(MALLOC_CAP_INTERNAL | MALLOC_CAP_8BIT),
        heap_caps_get_largest_free_block(MALLOC_CAP_INTERNAL | MALLOC_CAP_8BIT));

    // Allocate the large runtime stack before the smaller device worker so a
    // fragmented internal heap cannot prevent creation even when total free
    // memory is sufficient.
    // Keep task headroom above QuickJS' 64 KiB VM stack limit. QuickJS measures
    // from its own entry point, while the FreeRTOS task also carries the C++/Rust
    // bridge and task wrapper frames; making both limits identical trips the
    // FreeRTOS canary before QuickJS can report a bounded stack exception.
    const BaseType_t runtimeTaskCreated =
        xTaskCreatePinnedToCore(runtimeTask, "sp-runtime", 80 * 1024, nullptr, 2, nullptr, 1);
    const BaseType_t deviceTaskCreated =
        xTaskCreatePinnedToCore(deviceTask, "sp-device", 12 * 1024, nullptr, 1, nullptr, 0);
    if (deviceTaskCreated != pdPASS || runtimeTaskCreated != pdPASS) {
        Serial.printf(
            "SP_BOOT {\"ready\":false,\"stage\":\"task-allocation\","
            "\"device\":%ld,\"runtime\":%ld,\"freeHeap\":%u}\n",
            static_cast<long>(deviceTaskCreated),
            static_cast<long>(runtimeTaskCreated),
            ESP.getFreeHeap());
        allOutputsOff();
        showBootError(-101);
    }
}

void loop() {
    delay(20);
}
