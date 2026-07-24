#include <stdio.h>
#include <stdlib.h>
#include <string.h>

#include <switch.h>

#define FB_WIDTH 1280
#define FB_HEIGHT 720
#define CONTENT_X 160
#define CONTENT_Y 88
#define CONTENT_WIDTH 960
#define CONTENT_HEIGHT 544
#define CONTENT_BYTES (CONTENT_WIDTH * CONTENT_HEIGHT * 4)

extern bool pocketjs_switch_init(
    const uint8_t *app_js,
    size_t app_js_length,
    const uint8_t *app_pak,
    size_t app_pak_length
);
extern bool pocketjs_switch_frame(
    int32_t buttons,
    int32_t analog,
    const uint8_t **output,
    size_t *output_length
);
extern void pocketjs_switch_shutdown(void);

void pocketjs_switch_log(const uint8_t *bytes, size_t length) {
    svcOutputDebugString((const char *)bytes, length);
    svcOutputDebugString("\n", 1);
}

__attribute__((noreturn)) void pocketjs_switch_abort(void) {
    static const char message[] = "[PocketJS Switch] Rust abort\n";
    svcOutputDebugString(message, sizeof(message) - 1);
    for (;;) {
        svcSleepThread(1000000000L);
    }
}

static uint8_t *read_file(const char *path, size_t *length) {
    FILE *file = fopen(path, "rb");
    if (file == NULL) {
        return NULL;
    }
    if (fseek(file, 0, SEEK_END) != 0) {
        fclose(file);
        return NULL;
    }
    const long size = ftell(file);
    if (size < 0 || fseek(file, 0, SEEK_SET) != 0) {
        fclose(file);
        return NULL;
    }
    uint8_t *bytes = malloc((size_t)size + 1);
    if (bytes == NULL) {
        fclose(file);
        return NULL;
    }
    if (size != 0 && fread(bytes, 1, (size_t)size, file) != (size_t)size) {
        free(bytes);
        fclose(file);
        return NULL;
    }
    bytes[size] = 0;
    fclose(file);
    *length = (size_t)size;
    return bytes;
}

static int32_t pocket_buttons(uint64_t buttons) {
    int32_t output = 0;
    if (buttons & HidNpadButton_Minus) output |= 0x0001;
    if (buttons & HidNpadButton_Plus) output |= 0x0008;
    if (buttons & HidNpadButton_Up) output |= 0x0010;
    if (buttons & HidNpadButton_Right) output |= 0x0020;
    if (buttons & HidNpadButton_Down) output |= 0x0040;
    if (buttons & HidNpadButton_Left) output |= 0x0080;
    if (buttons & (HidNpadButton_L | HidNpadButton_ZL)) output |= 0x0100;
    if (buttons & (HidNpadButton_R | HidNpadButton_ZR)) output |= 0x0200;
    if (buttons & HidNpadButton_X) output |= 0x1000;
    if (buttons & HidNpadButton_A) output |= 0x2000;
    if (buttons & HidNpadButton_B) output |= 0x4000;
    if (buttons & HidNpadButton_Y) output |= 0x8000;
    return output;
}

static uint8_t analog_axis(int32_t value) {
    const int64_t clamped = value < -32768 ? -32768 : value > 32767 ? 32767 : value;
    return (uint8_t)(((clamped + 32768) * 255 + 32767) / 65535);
}

static int32_t pocket_analog(HidAnalogStickState stick) {
    return analog_axis(stick.x) | ((int32_t)analog_axis(-stick.y) << 8);
}

int main(int argc, char **argv) {
    (void)argc;
    (void)argv;

    consoleDebugInit(debugDevice_SVC);
    const Result romfs_result = romfsInit();
    size_t app_js_length = 0;
    size_t app_pak_length = 0;
    uint8_t *app_js = R_SUCCEEDED(romfs_result)
        ? read_file("romfs:/pocketjs/app.js", &app_js_length)
        : NULL;
    uint8_t *app_pak = R_SUCCEEDED(romfs_result)
        ? read_file("romfs:/pocketjs/app.pak", &app_pak_length)
        : NULL;
    bool runtime_ready = app_js != NULL && app_pak != NULL &&
        pocketjs_switch_init(app_js, app_js_length, app_pak, app_pak_length);

    Framebuffer framebuffer;
    framebufferCreate(
        &framebuffer,
        nwindowGetDefault(),
        FB_WIDTH,
        FB_HEIGHT,
        PIXEL_FORMAT_RGBA_8888,
        2
    );
    framebufferMakeLinear(&framebuffer);

    padConfigureInput(1, HidNpadStyleSet_NpadStandard);
    PadState pad;
    padInitializeDefault(&pad);

    while (appletMainLoop()) {
        padUpdate(&pad);
        const uint64_t buttons = padGetButtons(&pad);
        if ((buttons & (HidNpadButton_Plus | HidNpadButton_Minus)) ==
            (HidNpadButton_Plus | HidNpadButton_Minus)) {
            break;
        }

        u32 stride = 0;
        u32 *pixels = framebufferBegin(&framebuffer, &stride);
        memset(pixels, 0, stride * FB_HEIGHT);

        const uint8_t *content = NULL;
        size_t content_length = 0;
        if (runtime_ready) {
            const HidAnalogStickState left_stick = padGetStickPos(&pad, 0);
            runtime_ready = pocketjs_switch_frame(
                pocket_buttons(buttons),
                pocket_analog(left_stick),
                &content,
                &content_length
            );
        }
        if (runtime_ready && content != NULL && content_length == CONTENT_BYTES) {
            for (u32 y = 0; y < CONTENT_HEIGHT; y++) {
                memcpy(
                    (uint8_t *)pixels + (CONTENT_Y + y) * stride + CONTENT_X * 4,
                    content + y * CONTENT_WIDTH * 4,
                    CONTENT_WIDTH * 4
                );
            }
        } else {
            for (u32 y = 0; y < CONTENT_HEIGHT; y++) {
                u32 *row = (u32 *)((uint8_t *)pixels + (CONTENT_Y + y) * stride);
                for (u32 x = CONTENT_X; x < CONTENT_X + CONTENT_WIDTH; x++) {
                    row[x] = RGBA8_MAXALPHA(160, 36, 48);
                }
            }
        }
        framebufferEnd(&framebuffer);
    }

    pocketjs_switch_shutdown();
    framebufferClose(&framebuffer);
    free(app_js);
    free(app_pak);
    if (R_SUCCEEDED(romfs_result)) {
        romfsExit();
    }
    return 0;
}
