#include <stdio.h>

#include <switch.h>

#define FB_WIDTH 1280
#define FB_HEIGHT 720
#define CONTENT_X 160
#define CONTENT_Y 88
#define CONTENT_WIDTH 960
#define CONTENT_HEIGHT 544

static bool file_exists(const char *path) {
    FILE *file = fopen(path, "rb");
    if (file == NULL) {
        return false;
    }
    fclose(file);
    return true;
}

int main(int argc, char **argv) {
    (void)argc;
    (void)argv;

    consoleDebugInit(debugDevice_SVC);
    const Result romfs_result = romfsInit();
    const bool app_ready = R_SUCCEEDED(romfs_result) &&
        file_exists("romfs:/pocketjs/app.js") &&
        file_exists("romfs:/pocketjs/app.pak");
    printf(
        "[PocketJS Switch] target=switch hostAbi=4 romfs=%s\n",
        app_ready ? "ready" : "missing"
    );
    fflush(stdout);

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
        if (padGetButtonsDown(&pad) & HidNpadButton_Plus) {
            break;
        }

        u32 stride = 0;
        u32 *pixels = framebufferBegin(&framebuffer, &stride);
        const u32 row_pixels = stride / sizeof(*pixels);
        for (u32 y = 0; y < FB_HEIGHT; y++) {
            for (u32 x = 0; x < FB_WIDTH; x++) {
                const bool content =
                    x >= CONTENT_X && x < CONTENT_X + CONTENT_WIDTH &&
                    y >= CONTENT_Y && y < CONTENT_Y + CONTENT_HEIGHT;
                pixels[y * row_pixels + x] = content
                    ? (app_ready ? RGBA8_MAXALPHA(28, 120, 84) : RGBA8_MAXALPHA(160, 36, 48))
                    : RGBA8_MAXALPHA(0, 0, 0);
            }
        }
        framebufferEnd(&framebuffer);
    }

    framebufferClose(&framebuffer);
    if (R_SUCCEEDED(romfs_result)) {
        romfsExit();
    }
    return 0;
}
