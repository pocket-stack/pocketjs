/*
 * Board keys and touch mapped to the PocketJS input contract
 * (hosts/sifli/include/pocket_spec.h). Keys are sampled once per frame.
 *
 * POCKETJS_KEY_LONG_PRESS_MS == 0: KEY1/KEY2 levels become LEFT/RIGHT.
 * POCKETJS_KEY_LONG_PRESS_MS > 0: a key emits one LEFT/RIGHT pulse when it
 * is released before the threshold; holding KEY2 while the launcher runs
 * emits one CIRCLE pulse; holding KEY1 while another guest runs requests
 * the launcher. The long action latches until release so the newly mounted
 * guest never sees a stray pulse.
 */
#include <rtdevice.h>
#include <rtthread.h>
#include <string.h>

#include "board.h"
#include "pocket_spec.h"

#include "host_internal.h"

#ifdef POCKETJS_INPUT_TOUCH
#include "drv_touch.h"
#endif

#define WIDE_TOUCH_MARKER 0x80000000u
#define WIDE_TOUCH_ID_SHIFT 20u
#define LONG_PRESS_TICKS \
    ((RT_TICK_PER_SECOND * (rt_tick_t)POCKETJS_KEY_LONG_PRESS_MS + 999u) / 1000u)

typedef struct
{
    bool down;
    bool long_fired;
    rt_tick_t pressed_at;
} KeyState;

static KeyState g_key1;
static KeyState g_key2;

#ifdef POCKETJS_INPUT_TOUCH
static rt_device_t g_touch;
static volatile uint32_t g_touch_pending;
static bool g_touch_active;
static uint16_t g_touch_x;
static uint16_t g_touch_y;

static rt_err_t touch_rx_indicate(rt_device_t device, rt_size_t size)
{
    (void)device;
    (void)size;
    if (g_touch_pending != UINT32_MAX)
    {
        ++g_touch_pending;
    }
    return RT_EOK;
}

static void touch_open(void)
{
    g_touch = rt_device_find("touch");
    if (g_touch == RT_NULL)
    {
        rt_kprintf("[PocketJS] touch device not found; keys remain available\n");
        return;
    }
    if (rt_device_open(g_touch, RT_DEVICE_FLAG_RDONLY) != RT_EOK)
    {
        g_touch = RT_NULL;
        rt_kprintf("[PocketJS] touch device open failed\n");
        return;
    }
    rt_device_set_rx_indicate(g_touch, touch_rx_indicate);
    rt_kprintf("[PocketJS] touch input ready\n");
}

static void touch_poll(void)
{
    while (g_touch != RT_NULL && g_touch_pending > 0)
    {
        struct touch_message message;
        uint16_t logical_x;
        uint16_t logical_y;
        rt_base_t level = rt_hw_interrupt_disable();
        if (g_touch_pending > 0)
        {
            --g_touch_pending;
        }
        rt_hw_interrupt_enable(level);

        if (rt_device_read(g_touch, 0, &message, 1) != 1)
        {
            continue;
        }
        logical_x = message.x / POCKETJS_RENDER_SCALE;
        logical_y = message.y / POCKETJS_RENDER_SCALE;
        g_touch_x = logical_x < POCKETJS_LOGICAL_WIDTH ? logical_x : POCKETJS_LOGICAL_WIDTH - 1u;
        g_touch_y = logical_y < POCKETJS_LOGICAL_HEIGHT ? logical_y : POCKETJS_LOGICAL_HEIGHT - 1u;
        g_touch_active = message.event == TOUCH_EVENT_DOWN || message.event == TOUCH_EVENT_MOVE;
    }
}

static size_t touch_snapshot(uint32_t *packed)
{
    touch_poll();
    if (!g_touch_active)
    {
        return 0;
    }
    *packed = WIDE_TOUCH_MARKER | (1u << WIDE_TOUCH_ID_SHIFT) | ((uint32_t)g_touch_y << 10) |
              (uint32_t)g_touch_x;
    return 1;
}
#endif

static bool key1_down(void)
{
#ifdef BSP_USING_KEY1
    int value = rt_pin_read(BSP_KEY1_PIN);
#ifdef BSP_KEY1_ACTIVE_HIGH
    return value != 0;
#else
    return value == 0;
#endif
#else
    return false;
#endif
}

static bool key2_down(void)
{
#ifdef BSP_USING_KEY2
    int value = rt_pin_read(BSP_KEY2_PIN);
#ifdef BSP_KEY2_ACTIVE_HIGH
    return value != 0;
#else
    return value == 0;
#endif
#else
    return false;
#endif
}

void pocketjs_input_open(void)
{
#ifdef BSP_USING_KEY1
    rt_pin_mode(BSP_KEY1_PIN, PIN_MODE_INPUT);
#endif
#ifdef BSP_USING_KEY2
    rt_pin_mode(BSP_KEY2_PIN, PIN_MODE_INPUT);
#endif
#ifdef POCKETJS_INPUT_TOUCH
    touch_open();
#endif
    memset(&g_key1, 0, sizeof(g_key1));
    memset(&g_key2, 0, sizeof(g_key2));
}

#if POCKETJS_KEY_LONG_PRESS_MS > 0
static bool held_long_enough(const KeyState *state, rt_tick_t now)
{
    return (rt_tick_t)(now - state->pressed_at) >= LONG_PRESS_TICKS;
}

static void sample_keys(PocketjsInputFrame *frame, bool launcher_active)
{
    rt_tick_t now = rt_tick_get();
    bool key1_pressed = key1_down();
    bool key2_pressed = key2_down();

    if (key1_pressed && !g_key1.down)
    {
        g_key1.down = true;
        g_key1.long_fired = false;
        g_key1.pressed_at = now;
    }
    else if (key1_pressed && !g_key1.long_fired && held_long_enough(&g_key1, now))
    {
        g_key1.long_fired = true;
        if (!launcher_active)
        {
            frame->home_request = true;
        }
    }
    else if (!key1_pressed && g_key1.down)
    {
        if (!g_key1.long_fired)
        {
            frame->buttons |= POCKET_BTN_LEFT;
        }
        memset(&g_key1, 0, sizeof(g_key1));
    }

    if (key2_pressed && !g_key2.down)
    {
        g_key2.down = true;
        g_key2.long_fired = false;
        g_key2.pressed_at = now;
    }
    else if (key2_pressed && !g_key2.long_fired && launcher_active &&
             held_long_enough(&g_key2, now))
    {
        g_key2.long_fired = true;
        frame->buttons |= POCKET_BTN_CIRCLE;
    }
    else if (!key2_pressed && g_key2.down)
    {
        if (!g_key2.long_fired)
        {
            frame->buttons |= POCKET_BTN_RIGHT;
        }
        memset(&g_key2, 0, sizeof(g_key2));
    }
}
#else
static void sample_keys(PocketjsInputFrame *frame, bool launcher_active)
{
    (void)launcher_active;
    if (key1_down())
    {
        frame->buttons |= POCKET_BTN_LEFT;
    }
    if (key2_down())
    {
        frame->buttons |= POCKET_BTN_RIGHT;
    }
}
#endif

void pocketjs_input_poll(PocketjsInputFrame *frame, bool launcher_active)
{
    memset(frame, 0, sizeof(*frame));
    sample_keys(frame, launcher_active);
#ifdef POCKETJS_INPUT_TOUCH
    frame->touch_count = touch_snapshot(&frame->touch);
#endif
}
