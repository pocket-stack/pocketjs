#ifndef POCKETJS_3DS_DEVMENU_H
#define POCKETJS_3DS_DEVMENU_H

#include <citro3d.h>
#include <stdbool.h>

/* Host-owned development menu. It is composited after the auxiliary guest
 * surface and never enters the guest tree, HostOps, or capability contract. */
bool devmenu_init(void);
void devmenu_shutdown(void);
bool devmenu_visible(void);
void devmenu_toggle(void);
void devmenu_hide(void);
void devmenu_set_notice(const char *notice);
void devmenu_draw(C3D_RenderTarget *target);

#endif
