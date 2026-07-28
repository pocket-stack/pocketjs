#include <Arduino.h>
#include <SPI.h>
#include <SdFat.h>
#include <TFT_eSPI.h>
#include <Wire.h>
#include <esp_heap_caps.h>
#include <esp_system.h>

namespace {

constexpr int PIN_UP = 2;
constexpr int PIN_DOWN = 13;
constexpr int PIN_LEFT = 27;
constexpr int PIN_RIGHT = 35;
constexpr int PIN_A = 34;
constexpr int PIN_B = 12;
constexpr int PIN_BUZZER = 14;
constexpr int PIN_LIGHT = 36;
constexpr int PIN_TEMPERATURE = 39;
constexpr int PIN_SD_CS = 22;

TFT_eSPI tft;
SdFs sd;
bool controller40 = false;
bool imu68 = false;
bool activeDone = false;
String serialLine;

bool i2cPresent(uint8_t address) {
    Wire.beginTransmission(address);
    return Wire.endTransmission() == 0;
}

int readRegister(uint8_t address, uint8_t reg) {
    Wire.beginTransmission(address);
    Wire.write(reg);
    if (Wire.endTransmission(false) != 0) return -1;
    if (Wire.requestFrom(static_cast<int>(address), 1) != 1) return -1;
    return Wire.read();
}

bool writeRegister(uint8_t address, uint8_t reg, uint8_t value) {
    Wire.beginTransmission(address);
    Wire.write(reg);
    Wire.write(value);
    return Wire.endTransmission() == 0;
}

void drawLine(int row, const String& label, const String& value, uint16_t color) {
    const int y = 22 + row * 14;
    tft.setTextColor(TFT_DARKGREY, TFT_WHITE);
    tft.drawString(label, 4, y, 1);
    tft.setTextColor(color, TFT_WHITE);
    tft.drawRightString(value, 156, y, 1);
}

void emitStage1() {
    uint8_t addresses[16] = {};
    int addressCount = 0;
    for (uint8_t address = 1; address < 127 && addressCount < 16; ++address) {
        if (i2cPresent(address)) addresses[addressCount++] = address;
    }
    controller40 = i2cPresent(0x40);
    imu68 = i2cPresent(0x68);
    const int whoAmI = imu68 ? readRegister(0x68, 0x75) : -1;
    if (imu68) writeRegister(0x68, 0x6B, 0);

    const int light = analogRead(PIN_LIGHT);
    const int temperature = analogRead(PIN_TEMPERATURE);

    // GPIO19 is shared by the TFT reset line and the SD-card MISO line on this
    // board. TFT_eSPI has already completed the reset sequence, so release the
    // pin before starting the SD bus.
    pinMode(19, INPUT_PULLUP);
    delay(10);
    const SdSpiConfig sdConfig(PIN_SD_CS, SHARED_SPI, SD_SCK_MHZ(4), &SPI);
    bool sdMounted = sd.begin(sdConfig);
    bool sdWritable = false;
    uint64_t sdBytes = 0;
    if (sdMounted) {
        sdBytes = static_cast<uint64_t>(sd.card()->sectorCount()) * 512ULL;
        sd.mkdir("/SymbianPocket", true);
        FsFile probe = sd.open("/SymbianPocket/.probe.tmp", O_WRONLY | O_CREAT | O_TRUNC);
        if (probe) {
            probe.print("Symbian Pocket probe\n");
            probe.close();
            FsFile verify = sd.open("/SymbianPocket/.probe.tmp", O_RDONLY);
            sdWritable = verify && verify.size() > 0;
            if (verify) verify.close();
            sd.remove("/SymbianPocket/.probe.tmp");
        }
    } else {
        // A failed filesystem mount must not leave the shared SPI bus owned by
        // the card driver; the LCD and serial diagnostic continue afterwards.
        sd.end();
        pinMode(PIN_SD_CS, OUTPUT);
        digitalWrite(PIN_SD_CS, HIGH);
        SPI.end();
        SPI.begin(18, 19, 23);
    }

    Serial.print("SP_PROBE {\"stage\":1,\"chip\":\"");
    Serial.print(ESP.getChipModel());
    Serial.print("\",\"revision\":");
    Serial.print(ESP.getChipRevision());
    Serial.print(",\"flashBytes\":");
    Serial.print(ESP.getFlashChipSize());
    Serial.print(",\"psramBytes\":");
    Serial.print(ESP.getPsramSize());
    Serial.print(",\"freePsram\":");
    Serial.print(ESP.getFreePsram());
    Serial.print(",\"i2c\":[");
    for (int i = 0; i < addressCount; ++i) {
        if (i) Serial.print(',');
        Serial.print(addresses[i]);
    }
    Serial.print("],\"controller40\":");
    Serial.print(controller40 ? "true" : "false");
    Serial.print(",\"imu68\":");
    Serial.print(imu68 ? "true" : "false");
    Serial.print(",\"whoAmI\":");
    Serial.print(whoAmI);
    Serial.print(",\"lightRaw\":");
    Serial.print(light);
    Serial.print(",\"temperatureRaw\":");
    Serial.print(temperature);
    Serial.print(",\"sdMounted\":");
    Serial.print(sdMounted ? "true" : "false");
    Serial.print(",\"sdWritable\":");
    Serial.print(sdWritable ? "true" : "false");
    Serial.print(",\"sdBytes\":");
    Serial.print(static_cast<unsigned long>(sdBytes));
    Serial.print(",\"buttons\":[");
    Serial.print(digitalRead(PIN_UP));
    Serial.print(',');
    Serial.print(digitalRead(PIN_DOWN));
    Serial.print(',');
    Serial.print(digitalRead(PIN_LEFT));
    Serial.print(',');
    Serial.print(digitalRead(PIN_RIGHT));
    Serial.print(',');
    Serial.print(digitalRead(PIN_A));
    Serial.print(',');
    Serial.print(digitalRead(PIN_B));
    Serial.println("]}");

    // Do not touch the LCD again after probing the card: both peripherals use
    // the same SPI controller and a failed card mount can leave older drivers
    // waiting inside a subsequent display transaction.
}

void activeDiagnostic() {
    if (activeDone) return;
    activeDone = true;
    bool led1 = false;
    bool led2 = false;
    if (controller40) {
        led1 = writeRegister(0x40, 0xA0, 1);
        delay(120);
        writeRegister(0x40, 0xA0, 0);
        led2 = writeRegister(0x40, 0xA1, 1);
        delay(120);
        writeRegister(0x40, 0xA1, 0);
    }
    ledcSetup(0, 880, 10);
    ledcAttachPin(PIN_BUZZER, 0);
    ledcWriteTone(0, 880);
    delay(120);
    ledcWriteTone(0, 0);
    ledcDetachPin(PIN_BUZZER);
    pinMode(PIN_BUZZER, OUTPUT);
    digitalWrite(PIN_BUZZER, LOW);

    Serial.print("SP_PROBE {\"stage\":2,\"led1\":");
    Serial.print(led1 ? "true" : "false");
    Serial.print(",\"led2\":");
    Serial.print(led2 ? "true" : "false");
    Serial.println(",\"buzzer\":true,\"motorsTouched\":false,\"outputsOff\":true}");
}

}  // namespace

void setup() {
    Serial.begin(115200);
    delay(250);

    pinMode(PIN_UP, INPUT);
    pinMode(PIN_DOWN, INPUT);
    pinMode(PIN_LEFT, INPUT);
    pinMode(PIN_RIGHT, INPUT);
    pinMode(PIN_A, INPUT);
    pinMode(PIN_B, INPUT);
    pinMode(PIN_BUZZER, OUTPUT);
    digitalWrite(PIN_BUZZER, LOW);
    analogReadResolution(12);
    analogSetPinAttenuation(PIN_LIGHT, ADC_11db);
    analogSetPinAttenuation(PIN_TEMPERATURE, ADC_11db);

    SPI.begin(18, 19, 23);
    Wire.begin(21, 15, 100000);

    tft.init();
    tft.setRotation(3);
    tft.fillScreen(TFT_WHITE);
    tft.fillRect(0, 0, 160, 19, TFT_NAVY);
    tft.setTextColor(TFT_WHITE, TFT_NAVY);
    tft.drawCentreString("SYMBIAN POCKET PROBE", 80, 5, 1);
    tft.setTextColor(TFT_DARKGREY, TFT_WHITE);
    tft.drawCentreString("Serial probe on COM13", 80, 50, 1);
    tft.drawCentreString("ACTIVE tests LEDs + tone", 80, 66, 1);
    emitStage1();
    Serial.println("SP_PROBE READY");
}

void loop() {
    static uint32_t heartbeatAt = 0;
    if (millis() - heartbeatAt >= 1000) {
        heartbeatAt = millis();
        Serial.println("SP_PROBE HEARTBEAT");
    }
    while (Serial.available()) {
        const char character = static_cast<char>(Serial.read());
        if (character == '\r' || character == '\n') {
            serialLine.trim();
            if (serialLine.equalsIgnoreCase("ACTIVE")) activeDiagnostic();
            serialLine = "";
        } else if (serialLine.length() < 32) {
            serialLine += character;
        }
    }

    static uint32_t pressedAt = 0;
    if (digitalRead(PIN_A) == LOW) {
        if (!pressedAt) pressedAt = millis();
        if (millis() - pressedAt >= 1200) activeDiagnostic();
    } else {
        pressedAt = 0;
    }
    delay(5);
}
