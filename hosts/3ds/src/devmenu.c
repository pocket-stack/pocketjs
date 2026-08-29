/* Nintendo 3DS host development menu.
 *
 * Citro2D draws this after the guest's bottom-screen DrawList. The menu reads
 * only a native Runtime snapshot, so it survives guest replacement and cannot
 * become an application dependency or a published PocketJS capability.
 */

#include "devmenu.h"

#include <citro2d.h>
#include <stdio.h>
#include <string.h>

#include "devserver.h"

#define MENU_WIDTH 320.0f
#define MENU_HEIGHT 240.0f

static C2D_TextBuf text_buffer;
static bool initialized;
static bool visible;
static char notice[48] = "READY";

static void text(
  float x,
  float y,
  float scale,
  uint32_t color,
  const char *value
) {
  C2D_Text parsed;
  C2D_TextParse(&parsed, text_buffer, value == NULL ? "" : value);
  C2D_TextOptimize(&parsed);
  C2D_DrawText(
    &parsed,
    C2D_WithColor,
    x,
    y,
    0.9f,
    scale,
    scale,
    color
  );
}

bool devmenu_init(void) {
  if (initialized) return true;
  if (!C2D_Init(512)) return false;
  C2D_Prepare();
  text_buffer = C2D_TextBufNew(1024);
  if (text_buffer == NULL) {
    C2D_Fini();
    return false;
  }
  initialized = true;
  return true;
}

void devmenu_shutdown(void) {
  if (!initialized) return;
  C2D_TextBufDelete(text_buffer);
  text_buffer = NULL;
  C2D_Fini();
  initialized = false;
  visible = false;
}

bool devmenu_visible(void) {
  return initialized && visible;
}

void devmenu_toggle(void) {
  if (initialized) visible = !visible;
}

void devmenu_hide(void) {
  visible = false;
}

void devmenu_set_notice(const char *value) {
  snprintf(notice, sizeof notice, "%s", value == NULL ? "" : value);
}

void devmenu_draw(C3D_RenderTarget *target) {
  if (!devmenu_visible() || target == NULL) return;
  DevserverSnapshot state;
  devserver_snapshot(&state);
  char line[96];

  C2D_SceneBegin(target);
  C2D_TextBufClear(text_buffer);
  C2D_DrawRectSolid(0, 0, 0.75f, MENU_WIDTH, MENU_HEIGHT, C2D_Color32(7, 13, 29, 255));
  C2D_DrawRectSolid(0, 0, 0.76f, MENU_WIDTH, 34, C2D_Color32(16, 27, 52, 255));
  C2D_DrawRectSolid(0, 34, 0.76f, 4, 206, C2D_Color32(34, 211, 238, 255));

  text(14, 7, 0.54f, C2D_Color32(248, 250, 252, 255), "POCKET RUNTIME");
  snprintf(line, sizeof line, "3DS ABI %u", (unsigned)state.host_abi);
  text(226, 9, 0.40f, C2D_Color32(103, 232, 249, 255), line);

  uint32_t link_color = state.connected
    ? C2D_Color32(74, 222, 128, 255)
    : state.discoverable
      ? C2D_Color32(250, 204, 21, 255)
      : C2D_Color32(248, 113, 113, 255);
  text(14, 45, 0.38f, C2D_Color32(148, 163, 184, 255), "DEV LINK");
  text(
    94,
    43,
    0.48f,
    link_color,
    state.connected
      ? "CONNECTED"
      : state.discoverable
        ? "DISCOVERABLE"
        : state.enabled
          ? "TCP ONLY"
          : "NOT PAIRED"
  );

  if (state.enabled) {
    snprintf(line, sizeof line, "%s:%u", state.ip, (unsigned)state.port);
  } else {
    snprintf(line, sizeof line, "start ftpd, then run pair --host <ip>");
  }
  text(14, 70, 0.44f, C2D_Color32(226, 232, 240, 255), line);

  snprintf(
    line,
    sizeof line,
    "ID %016llx   GEN %lu",
    (unsigned long long)state.device_id,
    (unsigned long)state.generation
  );
  text(14, 94, 0.34f, C2D_Color32(148, 163, 184, 255), line);
  snprintf(
    line,
    sizeof line,
    "RUN %016llx   %s",
    (unsigned long long)state.running_hash,
    state.phase
  );
  text(14, 114, 0.34f, C2D_Color32(203, 213, 225, 255), line);
  snprintf(
    line,
    sizeof line,
    "UP %lu   SHOT %lu   CONN %lu   ERR %lu",
    (unsigned long)state.uploads,
    (unsigned long)state.screenshots,
    (unsigned long)state.connects,
    (unsigned long)(state.auth_failures + state.timeouts)
  );
  text(14, 134, 0.36f, C2D_Color32(148, 163, 184, 255), line);

  C2D_DrawRectSolid(12, 158, 0.77f, 296, 48, C2D_Color32(15, 23, 42, 255));
  text(20, 164, 0.34f, C2D_Color32(103, 232, 249, 255), "ON YOUR MAC (AUTO-DISCOVERY)");
  text(20, 183, 0.36f, C2D_Color32(248, 250, 252, 255), "bun run 3ds:dev dev --app 3ds-demo");

  snprintf(line, sizeof line, "X SCREENSHOT  B CLOSE        %s", notice);
  text(14, 216, 0.32f, C2D_Color32(148, 163, 184, 255), line);
}
