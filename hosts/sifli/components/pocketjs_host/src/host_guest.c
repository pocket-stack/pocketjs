/*
 * One mounted guest: a PocketJS core, its asset pak, native texture copies
 * registered with the GPU queue, and the QuickJS realm that runs the
 * bundle through the `ui` C ABI. Mount and unmount rebuild everything;
 * there is no suspended guest state.
 */
#include <rtthread.h>
#include <string.h>

#include "pocketjs_gpu_host.h"
#include "quickjs.h"

#include "host_internal.h"

#define HOST_ABI 3
#define QJS_MEMORY_LIMIT ((size_t)POCKETJS_QJS_MEMORY_LIMIT_KB * 1024u)
#define QJS_GC_THRESHOLD (768u * 1024u)
#define QJS_STACK_LIMIT (48u * 1024u)
#define MAX_TEXTURES 32u
#define MAX_SPRITES 8u
#define RESOURCE_NAME_MAX 47u

#define PAK_MAGIC 0x4B504344u
#define PAK_VERSION 1u
#define PAK_HEADER_SIZE 32u
#define PAK_ENTRY_SIZE 24u

#if defined(SF32LB58X)
#define HOST_NAME "sf32lb58"
#elif defined(SF32LB57X)
#define HOST_NAME "sf32lb57"
#elif defined(SF32LB56X)
#define HOST_NAME "sf32lb56"
#elif defined(SF32LB52X)
#define HOST_NAME "sf32lb52"
#else
#define HOST_NAME "sifli"
#endif

typedef struct
{
    char name[RESOURCE_NAME_MAX + 1u];
    int32_t handle;
} TextureRegistration;

typedef struct
{
    char name[RESOURCE_NAME_MAX + 1u];
    int32_t handle;
    uint16_t frames;
    uint16_t cols;
    uint16_t step;
} SpriteRegistration;

static PocketCore *g_core;
static JSRuntime *g_runtime;
static JSContext *g_context;
static JSValue g_global;
static JSValue g_frame;
static bool g_global_valid;
static bool g_frame_valid;
static TextureRegistration g_textures[MAX_TEXTURES];
static SpriteRegistration g_sprites[MAX_SPRITES];
static void *g_native_copies[MAX_TEXTURES];
static size_t g_texture_count;
static size_t g_sprite_count;
static size_t g_native_count;
static size_t g_native_bytes;
static size_t g_qjs_heap_bytes;
static uint32_t g_guest_frames;
static PocketjsLaunchHandler g_launch_handler;
static void *g_launch_context;

/* ---- pak parsing ------------------------------------------------------ */

static uint16_t read_u16_le(const uint8_t *p)
{
    return (uint16_t)((uint16_t)p[0] | ((uint16_t)p[1] << 8));
}

static uint32_t read_u32_le(const uint8_t *p)
{
    return (uint32_t)p[0] | ((uint32_t)p[1] << 8) | ((uint32_t)p[2] << 16) |
           ((uint32_t)p[3] << 24);
}

static bool range_valid(size_t total, uint32_t offset, uint32_t length)
{
    return (size_t)offset <= total && (size_t)length <= total - (size_t)offset;
}

static bool key_equals(const uint8_t *key, size_t key_len, const char *literal)
{
    size_t literal_len = strlen(literal);
    return key_len == literal_len && memcmp(key, literal, literal_len) == 0;
}

static bool key_has_prefix(const uint8_t *key, size_t key_len, const char *prefix,
                           const uint8_t **suffix, size_t *suffix_len)
{
    size_t prefix_len = strlen(prefix);
    if (key_len < prefix_len || memcmp(key, prefix, prefix_len) != 0)
    {
        return false;
    }
    *suffix = key + prefix_len;
    *suffix_len = key_len - prefix_len;
    return true;
}

static bool copy_resource_name(char *out, const uint8_t *name, size_t name_len)
{
    if (name_len == 0 || name_len > RESOURCE_NAME_MAX)
    {
        return false;
    }
    memcpy(out, name, name_len);
    out[name_len] = '\0';
    return true;
}

typedef struct
{
    const uint8_t *pak;
    size_t pak_len;
    uint32_t count;
    uint32_t directory;
    uint32_t names;
} PakDirectory;

static bool pak_open(PakDirectory *dir, const uint8_t *pak, size_t pak_len)
{
    if (pak == RT_NULL || pak_len < PAK_HEADER_SIZE || read_u32_le(pak) != PAK_MAGIC ||
        read_u16_le(pak + 4) != PAK_VERSION)
    {
        return false;
    }
    dir->pak = pak;
    dir->pak_len = pak_len;
    dir->count = read_u32_le(pak + 8);
    dir->directory = read_u32_le(pak + 12);
    dir->names = read_u32_le(pak + 16);
    return (size_t)dir->directory <= pak_len &&
           dir->count <= (pak_len - (size_t)dir->directory) / PAK_ENTRY_SIZE &&
           (size_t)dir->names <= pak_len;
}

static bool pak_entry(const PakDirectory *dir, uint32_t index, const uint8_t **key,
                      size_t *key_len, const uint8_t **blob, uint32_t *blob_len)
{
    const uint8_t *entry = dir->pak + dir->directory + (size_t)index * PAK_ENTRY_SIZE;
    uint32_t blob_offset = read_u32_le(entry + 4);
    uint32_t name_offset = read_u32_le(entry + 12);
    uint16_t name_len = read_u16_le(entry + 16);

    *blob_len = read_u32_le(entry + 8);
    if (!range_valid(dir->pak_len, blob_offset, *blob_len) ||
        (size_t)name_offset > dir->pak_len - (size_t)dir->names ||
        (size_t)name_len > dir->pak_len - (size_t)dir->names - (size_t)name_offset)
    {
        return false;
    }
    *key = dir->pak + dir->names + name_offset;
    *key_len = name_len;
    *blob = dir->pak + blob_offset;
    return true;
}

/* The native image for `ui:img.<name>` inside the guest's .epic pak. */
static const uint8_t *find_native_texture(const uint8_t *epic, size_t epic_len,
                                          const uint8_t *name, size_t name_len,
                                          uint32_t *blob_len_out)
{
    PakDirectory dir;
    uint32_t index;
    if (!pak_open(&dir, epic, epic_len))
    {
        return RT_NULL;
    }
    for (index = 0; index < dir.count; ++index)
    {
        const uint8_t *key;
        size_t key_len;
        const uint8_t *blob;
        uint32_t blob_len;
        const uint8_t *suffix;
        size_t suffix_len;
        if (!pak_entry(&dir, index, &key, &key_len, &blob, &blob_len))
        {
            return RT_NULL;
        }
        if (key_has_prefix(key, key_len, "ui:img.", &suffix, &suffix_len) &&
            suffix_len == name_len && memcmp(suffix, name, name_len) == 0)
        {
            *blob_len_out = blob_len;
            return blob;
        }
    }
    return RT_NULL;
}

/* ---- native textures ------------------------------------------------- */

static bool register_native_texture(int32_t handle, const uint8_t *blob, size_t blob_len)
{
    const uint8_t *source = blob;
    void *copy = RT_NULL;
    uint64_t revision;

    if (blob == RT_NULL || blob_len == 0)
    {
        return false;
    }
#ifdef POCKETJS_NATIVE_TEXTURE_STAGING
    if (g_native_count >= MAX_TEXTURES)
    {
        return false;
    }
    copy = pocket_heap_alloc(blob_len, 64);
    if (copy == RT_NULL)
    {
        return false;
    }
    memcpy(copy, blob, blob_len);
    source = copy;
#endif
    revision = pocket_core_texture_revision(g_core, handle);
    if (revision == UINT64_MAX ||
        !pocketjs_gpu_texture_register(handle, revision, source, blob_len))
    {
        pocket_heap_free(copy);
        return false;
    }
    if (copy != RT_NULL)
    {
        g_native_copies[g_native_count++] = copy;
    }
    g_native_bytes += blob_len;
    return true;
}

#ifdef POCKETJS_GPU_VGLITE
/* Without a native blob, VG Lite still blits the portable entry once it
 * sits 64-byte aligned in cache-clean memory. */
static bool register_portable_texture(int32_t handle, const uint8_t *entry, size_t entry_len)
{
    void *copy;
    uint64_t revision;

    if (entry == RT_NULL || entry_len == 0 || g_native_count >= MAX_TEXTURES)
    {
        return false;
    }
    copy = pocket_heap_alloc(entry_len, 64);
    if (copy == RT_NULL)
    {
        return false;
    }
    memcpy(copy, entry, entry_len);
    revision = pocket_core_texture_revision(g_core, handle);
    if (revision == UINT64_MAX ||
        !pocketjs_gpu_texture_register_portable(handle, revision, copy, entry_len))
    {
        pocket_heap_free(copy);
        return false;
    }
    g_native_copies[g_native_count++] = copy;
    g_native_bytes += entry_len;
    return true;
}
#endif

static void release_native_textures(void)
{
    size_t index;
    pocketjs_gpu_texture_reset();
    for (index = 0; index < g_native_count; ++index)
    {
        pocket_heap_free(g_native_copies[index]);
    }
    memset(g_native_copies, 0, sizeof(g_native_copies));
    g_native_count = 0;
    g_native_bytes = 0;
}

/* ---- pak loading ----------------------------------------------------- */

static bool load_pak(const uint8_t *pak, size_t pak_len, const uint8_t *epic, size_t epic_len)
{
    PakDirectory dir;
    uint32_t index;
    size_t native_registered = 0;
    size_t portable_registered = 0;

    if (!pak_open(&dir, pak, pak_len))
    {
        rt_kprintf("[PocketJS] invalid asset pack\n");
        return false;
    }
    for (index = 0; index < dir.count; ++index)
    {
        const uint8_t *key;
        size_t key_len;
        const uint8_t *blob;
        uint32_t blob_len;
        const uint8_t *resource_name;
        size_t resource_name_len;

        if (!pak_entry(&dir, index, &key, &key_len, &blob, &blob_len))
        {
            rt_kprintf("[PocketJS] corrupt asset entry %u\n", (unsigned)index);
            return false;
        }
        if (key_equals(key, key_len, "ui:styles"))
        {
            if (!pocket_core_load_styles(g_core, blob, blob_len))
            {
                rt_kprintf("[PocketJS] styles.bin rejected\n");
                return false;
            }
        }
        else if (key_has_prefix(key, key_len, "ui:font.", &resource_name, &resource_name_len))
        {
            if (!pocket_core_load_font_atlas(g_core, blob, blob_len))
            {
                rt_kprintf("[PocketJS] font atlas rejected\n");
                return false;
            }
        }
        else if (key_has_prefix(key, key_len, "ui:img.", &resource_name, &resource_name_len))
        {
            TextureRegistration *registration;
            const uint8_t *native;
            uint32_t native_len;
            int32_t handle;

            if (g_texture_count >= MAX_TEXTURES)
            {
                rt_kprintf("[PocketJS] texture registration overflow\n");
                return false;
            }
            registration = &g_textures[g_texture_count];
            if (!copy_resource_name(registration->name, resource_name, resource_name_len))
            {
                rt_kprintf("[PocketJS] texture name rejected\n");
                return false;
            }
            handle = pocket_core_upload_img_entry(g_core, blob, blob_len);
            if (handle < 0)
            {
                rt_kprintf("[PocketJS] image rejected: %s\n", registration->name);
                return false;
            }
            registration->handle = handle;
            ++g_texture_count;

            native = find_native_texture(epic, epic_len, resource_name, resource_name_len,
                                         &native_len);
            if (native != RT_NULL)
            {
                if (register_native_texture(handle, native, native_len))
                {
                    ++native_registered;
                }
                else
                {
                    rt_kprintf("[PocketJS] native texture rejected: %s (portable path)\n",
                               registration->name);
                }
            }
#ifdef POCKETJS_GPU_VGLITE
            else if (register_portable_texture(handle, blob, blob_len))
            {
                ++portable_registered;
            }
#endif
        }
        else if (key_has_prefix(key, key_len, "ui:sprite.", &resource_name,
                                &resource_name_len))
        {
            SpriteRegistration *registration;
            int32_t handle;

            if (blob_len < 16 || g_sprite_count >= MAX_SPRITES)
            {
                rt_kprintf("[PocketJS] sprite registration overflow\n");
                return false;
            }
            registration = &g_sprites[g_sprite_count];
            if (!copy_resource_name(registration->name, resource_name, resource_name_len))
            {
                return false;
            }
            handle = pocket_core_upload_texture(g_core, blob + 16, blob_len - 16,
                                                read_u16_le(blob), read_u16_le(blob + 2),
                                                blob[4]);
            if (handle < 0)
            {
                rt_kprintf("[PocketJS] sprite rejected: %s\n", registration->name);
                return false;
            }
            registration->handle = handle;
            registration->frames = read_u16_le(blob + 6);
            registration->cols = read_u16_le(blob + 8);
            registration->step = read_u16_le(blob + 10);
            ++g_sprite_count;
        }
    }
    rt_kprintf("[PocketJS] pak loaded: %u texture(s), %u sprite(s), %u native + %u portable "
               "registered (%uKB)\n",
               (unsigned)g_texture_count, (unsigned)g_sprite_count, (unsigned)native_registered,
               (unsigned)portable_registered, (unsigned)(g_native_bytes >> 10));
    return true;
}

/* ---- QuickJS allocator over the shared heap -------------------------- */

static void *qjs_malloc(JSMallocState *state, size_t size)
{
    void *ptr;
    if (size == 0 || size > state->malloc_limit - state->malloc_size)
    {
        return RT_NULL;
    }
    ptr = pocket_heap_alloc(size, 8);
    if (ptr != RT_NULL)
    {
        ++state->malloc_count;
        state->malloc_size += pocket_heap_usable_size(ptr);
        g_qjs_heap_bytes = state->malloc_size;
    }
    return ptr;
}

static void qjs_free(JSMallocState *state, void *ptr)
{
    size_t old_size;
    if (ptr == RT_NULL)
    {
        return;
    }
    old_size = pocket_heap_usable_size(ptr);
    if (state->malloc_count > 0)
    {
        --state->malloc_count;
    }
    state->malloc_size = old_size <= state->malloc_size ? state->malloc_size - old_size : 0;
    g_qjs_heap_bytes = state->malloc_size;
    pocket_heap_free(ptr);
}

static void *qjs_realloc(JSMallocState *state, void *ptr, size_t size)
{
    size_t old_size;
    void *replacement;
    if (ptr == RT_NULL)
    {
        return size == 0 ? RT_NULL : qjs_malloc(state, size);
    }
    if (size == 0)
    {
        qjs_free(state, ptr);
        return RT_NULL;
    }
    old_size = pocket_heap_usable_size(ptr);
    if (size > old_size && size - old_size > state->malloc_limit - state->malloc_size)
    {
        return RT_NULL;
    }
    replacement = pocket_heap_alloc(size, 8);
    if (replacement == RT_NULL)
    {
        return RT_NULL;
    }
    memcpy(replacement, ptr, old_size < size ? old_size : size);
    pocket_heap_free(ptr);
    state->malloc_size = state->malloc_size - old_size + pocket_heap_usable_size(replacement);
    g_qjs_heap_bytes = state->malloc_size;
    return replacement;
}

static size_t qjs_malloc_usable_size(const void *ptr)
{
    return pocket_heap_usable_size(ptr);
}

static const JSMallocFunctions g_qjs_allocators = {
    qjs_malloc,
    qjs_free,
    qjs_realloc,
    qjs_malloc_usable_size,
};

/* ---- ui bindings ----------------------------------------------------- */

static int32_t js_arg_i32(JSContext *ctx, int argc, JSValueConst *argv, int index)
{
    int32_t value = 0;
    if (index < argc)
    {
        JS_ToInt32(ctx, &value, argv[index]);
    }
    return value;
}

static double js_arg_f64(JSContext *ctx, int argc, JSValueConst *argv, int index)
{
    double value = 0.0;
    if (index < argc)
    {
        JS_ToFloat64(ctx, &value, argv[index]);
    }
    return value;
}

static bool js_buffer_bytes(JSContext *ctx, JSValueConst value, const uint8_t **data,
                            size_t *length)
{
    uint8_t *array_buffer = JS_GetArrayBuffer(ctx, length, value);
    JSValue buffer;
    size_t buffer_len = 0;
    uint8_t *buffer_data;
    JSValue offset_value;
    JSValue length_value;
    int32_t offset = 0;
    int32_t view_len = 0;

    if (array_buffer != RT_NULL)
    {
        *data = array_buffer;
        return true;
    }
    JS_FreeValue(ctx, JS_GetException(ctx));
    buffer = JS_GetPropertyStr(ctx, value, "buffer");
    buffer_data = JS_GetArrayBuffer(ctx, &buffer_len, buffer);
    JS_FreeValue(ctx, buffer);
    if (buffer_data == RT_NULL)
    {
        JS_FreeValue(ctx, JS_GetException(ctx));
        return false;
    }
    offset_value = JS_GetPropertyStr(ctx, value, "byteOffset");
    length_value = JS_GetPropertyStr(ctx, value, "byteLength");
    JS_ToInt32(ctx, &offset, offset_value);
    JS_ToInt32(ctx, &view_len, length_value);
    JS_FreeValue(ctx, offset_value);
    JS_FreeValue(ctx, length_value);
    if (offset < 0 || view_len < 0 || (size_t)offset > buffer_len ||
        (size_t)view_len > buffer_len - (size_t)offset)
    {
        return false;
    }
    *data = buffer_data + offset;
    *length = (size_t)view_len;
    return true;
}

#define JS_BINDING(name) \
    static JSValue name(JSContext *ctx, JSValueConst this_value, int argc, JSValueConst *argv)

JS_BINDING(js_create_node)
{
    (void)this_value;
    return JS_NewInt32(
        ctx, pocket_core_create_node(g_core, (uint32_t)js_arg_i32(ctx, argc, argv, 0)));
}

JS_BINDING(js_destroy_node)
{
    (void)this_value;
    pocket_core_destroy_node(g_core, js_arg_i32(ctx, argc, argv, 0));
    return JS_UNDEFINED;
}

JS_BINDING(js_insert_before)
{
    (void)this_value;
    pocket_core_insert_before(g_core, js_arg_i32(ctx, argc, argv, 0),
                              js_arg_i32(ctx, argc, argv, 1), js_arg_i32(ctx, argc, argv, 2));
    return JS_UNDEFINED;
}

JS_BINDING(js_remove_child)
{
    (void)this_value;
    pocket_core_remove_child(g_core, js_arg_i32(ctx, argc, argv, 0),
                             js_arg_i32(ctx, argc, argv, 1));
    return JS_UNDEFINED;
}

JS_BINDING(js_set_style)
{
    (void)this_value;
    pocket_core_set_style(g_core, js_arg_i32(ctx, argc, argv, 0), js_arg_i32(ctx, argc, argv, 1));
    return JS_UNDEFINED;
}

JS_BINDING(js_set_prop)
{
    (void)this_value;
    pocket_core_set_prop(g_core, js_arg_i32(ctx, argc, argv, 0),
                         (uint32_t)js_arg_i32(ctx, argc, argv, 1), js_arg_f64(ctx, argc, argv, 2));
    return JS_UNDEFINED;
}

JS_BINDING(js_set_prop_batch)
{
    const uint8_t *data;
    size_t length;
    size_t offset;
    (void)this_value;
    if (argc < 1 || !js_buffer_bytes(ctx, argv[0], &data, &length))
    {
        return JS_UNDEFINED;
    }
    for (offset = 0; offset + 24 <= length; offset += 24)
    {
        double id;
        double prop;
        double value;
        memcpy(&id, data + offset, sizeof(id));
        memcpy(&prop, data + offset + 8, sizeof(prop));
        memcpy(&value, data + offset + 16, sizeof(value));
        pocket_core_set_prop(g_core, (int32_t)id, (uint32_t)prop, value);
    }
    return JS_UNDEFINED;
}

static JSValue set_text_common(JSContext *ctx, int argc, JSValueConst *argv, bool replace)
{
    size_t length = 0;
    const char *text;
    int32_t id;
    if (argc < 2)
    {
        return JS_UNDEFINED;
    }
    id = js_arg_i32(ctx, argc, argv, 0);
    text = JS_ToCStringLen2(ctx, &length, argv[1], 0);
    if (text != RT_NULL)
    {
        if (replace)
        {
            pocket_core_replace_text(g_core, id, (const uint8_t *)text, length);
        }
        else
        {
            pocket_core_set_text(g_core, id, (const uint8_t *)text, length);
        }
        JS_FreeCString(ctx, text);
    }
    return JS_UNDEFINED;
}

JS_BINDING(js_set_text)
{
    (void)this_value;
    return set_text_common(ctx, argc, argv, false);
}

JS_BINDING(js_replace_text)
{
    (void)this_value;
    return set_text_common(ctx, argc, argv, true);
}

JS_BINDING(js_upload_texture)
{
    const uint8_t *data;
    size_t length;
    (void)this_value;
    if (argc < 4 || !js_buffer_bytes(ctx, argv[0], &data, &length))
    {
        return JS_NewInt32(ctx, -1);
    }
    return JS_NewInt32(ctx, pocket_core_upload_texture(g_core, data, length,
                                                       (uint32_t)js_arg_i32(ctx, argc, argv, 1),
                                                       (uint32_t)js_arg_i32(ctx, argc, argv, 2),
                                                       (uint32_t)js_arg_i32(ctx, argc, argv, 3)));
}

JS_BINDING(js_upload_img_entry)
{
    const uint8_t *data;
    size_t length;
    (void)this_value;
    if (argc < 1 || !js_buffer_bytes(ctx, argv[0], &data, &length))
    {
        return JS_NewInt32(ctx, -1);
    }
    return JS_NewInt32(ctx, pocket_core_upload_img_entry(g_core, data, length));
}

JS_BINDING(js_free_texture)
{
    (void)this_value;
    pocket_core_free_texture(g_core, js_arg_i32(ctx, argc, argv, 0));
    return JS_UNDEFINED;
}

JS_BINDING(js_set_image)
{
    (void)this_value;
    pocket_core_set_image(g_core, js_arg_i32(ctx, argc, argv, 0), js_arg_i32(ctx, argc, argv, 1));
    return JS_UNDEFINED;
}

JS_BINDING(js_set_sprite)
{
    (void)this_value;
    pocket_core_set_sprite(g_core, js_arg_i32(ctx, argc, argv, 0), js_arg_i32(ctx, argc, argv, 1),
                           (uint32_t)js_arg_i32(ctx, argc, argv, 2),
                           (uint32_t)js_arg_i32(ctx, argc, argv, 3),
                           (uint32_t)js_arg_i32(ctx, argc, argv, 4));
    return JS_UNDEFINED;
}

JS_BINDING(js_animate)
{
    int32_t duration = js_arg_i32(ctx, argc, argv, 3);
    int32_t delay = js_arg_i32(ctx, argc, argv, 5);
    (void)this_value;
    return JS_NewInt32(ctx, pocket_core_animate(g_core, js_arg_i32(ctx, argc, argv, 0),
                                                (uint32_t)js_arg_i32(ctx, argc, argv, 1),
                                                js_arg_f64(ctx, argc, argv, 2),
                                                duration > 0 ? (uint32_t)duration : 0,
                                                (uint32_t)js_arg_i32(ctx, argc, argv, 4),
                                                delay > 0 ? (uint32_t)delay : 0));
}

JS_BINDING(js_cancel_anim)
{
    (void)this_value;
    pocket_core_cancel_anim(g_core, js_arg_i32(ctx, argc, argv, 0));
    return JS_UNDEFINED;
}

JS_BINDING(js_set_focus)
{
    (void)this_value;
    pocket_core_set_focus(g_core, js_arg_i32(ctx, argc, argv, 0));
    return JS_UNDEFINED;
}

JS_BINDING(js_set_active)
{
    (void)this_value;
    pocket_core_set_active(g_core, js_arg_i32(ctx, argc, argv, 0), js_arg_i32(ctx, argc, argv, 1));
    return JS_UNDEFINED;
}

JS_BINDING(js_hit_test)
{
    (void)this_value;
    return JS_NewInt32(ctx, pocket_core_hit_test(g_core, (float)js_arg_f64(ctx, argc, argv, 0),
                                                 (float)js_arg_f64(ctx, argc, argv, 1)));
}

JS_BINDING(js_hit_test_bounds)
{
    (void)this_value;
    return JS_NewInt32(ctx,
                       pocket_core_hit_test_bounds(g_core, (float)js_arg_f64(ctx, argc, argv, 0),
                                                   (float)js_arg_f64(ctx, argc, argv, 1)));
}

JS_BINDING(js_set_cursor)
{
    (void)this_value;
    pocket_core_set_cursor(g_core, js_arg_i32(ctx, argc, argv, 0),
                           (float)js_arg_f64(ctx, argc, argv, 1),
                           (float)js_arg_f64(ctx, argc, argv, 2),
                           (float)js_arg_f64(ctx, argc, argv, 3),
                           (float)js_arg_f64(ctx, argc, argv, 4));
    return JS_UNDEFINED;
}

JS_BINDING(js_set_cursor_pos)
{
    (void)this_value;
    pocket_core_set_cursor_pos(g_core, (float)js_arg_f64(ctx, argc, argv, 0),
                               (float)js_arg_f64(ctx, argc, argv, 1));
    return JS_UNDEFINED;
}

JS_BINDING(js_load_styles)
{
    const uint8_t *data;
    size_t length;
    (void)this_value;
    if (argc < 1 || !js_buffer_bytes(ctx, argv[0], &data, &length))
    {
        return JS_FALSE;
    }
    return JS_NewBool(ctx, pocket_core_load_styles(g_core, data, length));
}

JS_BINDING(js_load_font)
{
    const uint8_t *data;
    size_t length;
    (void)this_value;
    if (argc < 1 || !js_buffer_bytes(ctx, argv[0], &data, &length))
    {
        return JS_FALSE;
    }
    return JS_NewBool(ctx, pocket_core_load_font_atlas(g_core, data, length));
}

JS_BINDING(js_measure_text)
{
    size_t length = 0;
    const char *text;
    float width = 0.0f;
    (void)this_value;
    if (argc >= 2)
    {
        text = JS_ToCStringLen2(ctx, &length, argv[0], 0);
        if (text != RT_NULL)
        {
            width = pocket_core_measure_text(g_core, (const uint8_t *)text, length,
                                             (uint32_t)js_arg_i32(ctx, argc, argv, 1));
            JS_FreeCString(ctx, text);
        }
    }
    return JS_NewFloat64(ctx, width);
}

JS_BINDING(js_debug_inspect)
{
    (void)this_value;
    pocket_core_debug_inspect(g_core, js_arg_i32(ctx, argc, argv, 0));
    return JS_UNDEFINED;
}

JS_BINDING(js_debug_rect_xy)
{
    (void)this_value;
    (void)argc;
    (void)argv;
    return JS_NewInt32(ctx, pocket_core_debug_rect_xy(g_core));
}

JS_BINDING(js_debug_rect_wh)
{
    (void)this_value;
    (void)argc;
    (void)argv;
    return JS_NewInt32(ctx, pocket_core_debug_rect_wh(g_core));
}

JS_BINDING(js_debug_pause)
{
    (void)this_value;
    pocket_core_debug_pause(g_core, js_arg_i32(ctx, argc, argv, 0));
    return JS_UNDEFINED;
}

JS_BINDING(js_debug_step)
{
    (void)ctx;
    (void)this_value;
    (void)argc;
    (void)argv;
    pocket_core_debug_step(g_core);
    return JS_UNDEFINED;
}

JS_BINDING(js_app_launch)
{
    const char *output;
    size_t output_len = 0;
    bool accepted = false;
    (void)this_value;
    if (argc < 1 || g_launch_handler == RT_NULL)
    {
        return JS_NewInt32(ctx, 0);
    }
    output = JS_ToCStringLen2(ctx, &output_len, argv[0], 0);
    if (output != RT_NULL)
    {
        accepted = g_launch_handler(output, output_len, g_launch_context);
        JS_FreeCString(ctx, output);
    }
    return JS_NewInt32(ctx, accepted ? 1 : 0);
}

JS_BINDING(js_console_log)
{
    int index;
    (void)this_value;
    rt_kprintf("[PocketJS JS]");
    for (index = 0; index < argc; ++index)
    {
        const char *text = JS_ToCString(ctx, argv[index]);
        if (text != RT_NULL)
        {
            rt_kprintf(" %s", text);
            JS_FreeCString(ctx, text);
        }
    }
    rt_kprintf("\n");
    return JS_UNDEFINED;
}

static void add_function(JSContext *ctx, JSValue object, const char *name, JSCFunction *function,
                         int argument_count)
{
    JS_SetPropertyStr(ctx, object, name, JS_NewCFunction(ctx, function, name, argument_count));
}

static void register_ui(JSContext *ctx, JSValue global)
{
    JSValue ui = JS_NewObject(ctx);
    JSValue textures = JS_NewObject(ctx);
    JSValue sprites = JS_NewObject(ctx);
    JSValue viewport = JS_NewObject(ctx);
    size_t index;

    add_function(ctx, ui, "createNode", js_create_node, 1);
    add_function(ctx, ui, "destroyNode", js_destroy_node, 1);
    add_function(ctx, ui, "insertBefore", js_insert_before, 3);
    add_function(ctx, ui, "removeChild", js_remove_child, 2);
    add_function(ctx, ui, "setStyle", js_set_style, 2);
    add_function(ctx, ui, "setProp", js_set_prop, 3);
    add_function(ctx, ui, "setPropBatch", js_set_prop_batch, 1);
    add_function(ctx, ui, "setText", js_set_text, 2);
    add_function(ctx, ui, "replaceText", js_replace_text, 2);
    add_function(ctx, ui, "uploadTexture", js_upload_texture, 4);
    add_function(ctx, ui, "uploadImgEntry", js_upload_img_entry, 1);
    add_function(ctx, ui, "freeTexture", js_free_texture, 1);
    add_function(ctx, ui, "setImage", js_set_image, 2);
    add_function(ctx, ui, "setSprite", js_set_sprite, 5);
    add_function(ctx, ui, "animate", js_animate, 6);
    add_function(ctx, ui, "cancelAnim", js_cancel_anim, 1);
    add_function(ctx, ui, "setFocus", js_set_focus, 1);
    add_function(ctx, ui, "setActive", js_set_active, 2);
    add_function(ctx, ui, "hitTest", js_hit_test, 2);
    add_function(ctx, ui, "hitTestBounds", js_hit_test_bounds, 2);
    add_function(ctx, ui, "setCursor", js_set_cursor, 5);
    add_function(ctx, ui, "setCursorPos", js_set_cursor_pos, 2);
    add_function(ctx, ui, "loadStyles", js_load_styles, 1);
    add_function(ctx, ui, "loadFontAtlas", js_load_font, 1);
    add_function(ctx, ui, "measureText", js_measure_text, 2);
    add_function(ctx, ui, "debugInspect", js_debug_inspect, 1);
    add_function(ctx, ui, "debugRectXY", js_debug_rect_xy, 0);
    add_function(ctx, ui, "debugRectWH", js_debug_rect_wh, 0);
    add_function(ctx, ui, "debugPause", js_debug_pause, 1);
    add_function(ctx, ui, "debugStep", js_debug_step, 0);
    add_function(ctx, ui, "appLaunch", js_app_launch, 1);

    JS_SetPropertyStr(ctx, ui, "__host", JS_NewString(ctx, HOST_NAME));
    JS_SetPropertyStr(ctx, ui, "__hostAbi", JS_NewInt32(ctx, HOST_ABI));
    JS_SetPropertyStr(ctx, ui, "__tickHz", JS_NewInt32(ctx, POCKETJS_TICK_HZ));
    JS_SetPropertyStr(ctx, viewport, "w", JS_NewInt32(ctx, POCKETJS_LOGICAL_WIDTH));
    JS_SetPropertyStr(ctx, viewport, "h", JS_NewInt32(ctx, POCKETJS_LOGICAL_HEIGHT));
    JS_SetPropertyStr(ctx, ui, "__viewport", viewport);

    for (index = 0; index < g_texture_count; ++index)
    {
        JS_SetPropertyStr(ctx, textures, g_textures[index].name,
                          JS_NewInt32(ctx, g_textures[index].handle));
    }
    JS_SetPropertyStr(ctx, ui, "__textures", textures);
    for (index = 0; index < g_sprite_count; ++index)
    {
        JSValue metadata = JS_NewObject(ctx);
        JS_SetPropertyStr(ctx, metadata, "handle", JS_NewInt32(ctx, g_sprites[index].handle));
        JS_SetPropertyStr(ctx, metadata, "frames", JS_NewInt32(ctx, g_sprites[index].frames));
        JS_SetPropertyStr(ctx, metadata, "cols", JS_NewInt32(ctx, g_sprites[index].cols));
        JS_SetPropertyStr(ctx, metadata, "step", JS_NewInt32(ctx, g_sprites[index].step));
        JS_SetPropertyStr(ctx, sprites, g_sprites[index].name, metadata);
    }
    JS_SetPropertyStr(ctx, ui, "__sprites", sprites);
    JS_SetPropertyStr(ctx, global, "ui", ui);
}

static void register_console(JSContext *ctx, JSValue global)
{
    JSValue console = JS_NewObject(ctx);
    add_function(ctx, console, "log", js_console_log, 1);
    add_function(ctx, console, "info", js_console_log, 1);
    add_function(ctx, console, "warn", js_console_log, 1);
    add_function(ctx, console, "error", js_console_log, 1);
    JS_SetPropertyStr(ctx, global, "console", console);
}

static void log_exception(JSContext *ctx, const char *stage)
{
    JSValue exception = JS_GetException(ctx);
    const char *message = JS_ToCString(ctx, exception);
    rt_kprintf("[PocketJS] JS exception during %s: %s\n", stage,
               message != RT_NULL ? message : "<unprintable>");
    if (message != RT_NULL)
    {
        JS_FreeCString(ctx, message);
    }
    if (JS_IsObject(exception))
    {
        JSValue stack = JS_GetPropertyStr(ctx, exception, "stack");
        const char *stack_text = JS_ToCString(ctx, stack);
        if (stack_text != RT_NULL)
        {
            rt_kprintf("%s\n", stack_text);
            JS_FreeCString(ctx, stack_text);
        }
        JS_FreeValue(ctx, stack);
    }
    JS_FreeValue(ctx, exception);
}

static void drain_jobs(void)
{
    JSContext *job_context = RT_NULL;
    int result;
    do
    {
        result = JS_ExecutePendingJob(g_runtime, &job_context);
        if (result < 0)
        {
            log_exception(job_context != RT_NULL ? job_context : g_context, "pending job");
        }
    } while (result > 0);
}

/* ---- lifecycle ------------------------------------------------------- */

void pocketjs_guest_set_launch_handler(PocketjsLaunchHandler handler, void *context)
{
    g_launch_handler = handler;
    g_launch_context = context;
}

void pocketjs_guest_unmount(void)
{
    if (g_context != RT_NULL)
    {
        if (g_frame_valid)
        {
            JS_FreeValue(g_context, g_frame);
        }
        if (g_global_valid)
        {
            JS_FreeValue(g_context, g_global);
        }
        JS_FreeContext(g_context);
    }
    if (g_runtime != RT_NULL)
    {
        JS_FreeRuntime(g_runtime);
    }
    /* Waits for the hardware before the blobs it may still read go away. */
    release_native_textures();
    if (g_core != RT_NULL)
    {
        pocket_core_destroy(g_core);
    }
    g_core = RT_NULL;
    g_runtime = RT_NULL;
    g_context = RT_NULL;
    g_global_valid = false;
    g_frame_valid = false;
    g_texture_count = 0;
    g_sprite_count = 0;
    g_qjs_heap_bytes = 0;
    g_guest_frames = 0;
}

bool pocketjs_guest_mount(const PocketjsGuest *guest)
{
    const uint8_t *bundle = guest != RT_NULL ? guest->js_start : RT_NULL;
    size_t bundle_len = pocketjs_guest_js_size(guest);
    const uint8_t *pak = guest != RT_NULL ? guest->pak_start : RT_NULL;
    size_t pak_len = pocketjs_guest_pak_size(guest);
    const uint8_t *epic = guest != RT_NULL ? guest->epic_start : RT_NULL;
    size_t epic_len = pocketjs_guest_epic_size(guest);
    const char *name = guest != RT_NULL && guest->output != RT_NULL ? guest->output : "guest";
    JSValue evaluation;

    if (g_core != RT_NULL || g_runtime != RT_NULL || bundle == RT_NULL || bundle_len == 0 ||
        pak == RT_NULL || pak_len == 0)
    {
        rt_kprintf("[PocketJS] invalid guest initialization state\n");
        return false;
    }
    g_texture_count = 0;
    g_sprite_count = 0;
    g_guest_frames = 0;
    g_core = pocket_core_create(POCKETJS_LOGICAL_WIDTH, POCKETJS_LOGICAL_HEIGHT,
                                POCKETJS_RENDER_SCALE, POCKETJS_RASTER_DENSITY,
                                POCKETJS_FRAMEBUFFER_COUNT);
    if (g_core == RT_NULL || !pocket_core_set_tick_rate(g_core, POCKETJS_TICK_HZ))
    {
        rt_kprintf("[PocketJS] core initialization failed\n");
        goto fail;
    }
    if (!load_pak(pak, pak_len, epic, epic_len))
    {
        goto fail;
    }

    g_runtime = JS_NewRuntime2(&g_qjs_allocators, RT_NULL);
    if (g_runtime == RT_NULL)
    {
        rt_kprintf("[PocketJS] JS_NewRuntime2 failed\n");
        goto fail;
    }
    JS_SetMemoryLimit(g_runtime, QJS_MEMORY_LIMIT);
    JS_SetGCThreshold(g_runtime, QJS_GC_THRESHOLD);
    JS_SetMaxStackSize(g_runtime, QJS_STACK_LIMIT);

    g_context = JS_NewContext(g_runtime);
    if (g_context == RT_NULL)
    {
        rt_kprintf("[PocketJS] JS_NewContext failed\n");
        goto fail;
    }
    g_global = JS_GetGlobalObject(g_context);
    g_global_valid = true;
    register_ui(g_context, g_global);
    register_console(g_context, g_global);
    JS_SetPropertyStr(g_context, g_global, "__simHz", JS_NewInt32(g_context, POCKETJS_TICK_HZ));

    evaluation = JS_Eval(g_context, (const char *)bundle, bundle_len, name, JS_EVAL_TYPE_GLOBAL);
    if (JS_IsException(evaluation))
    {
        log_exception(g_context, "bundle evaluation");
        JS_FreeValue(g_context, evaluation);
        goto fail;
    }
    JS_FreeValue(g_context, evaluation);
    drain_jobs();

    g_frame = JS_GetPropertyStr(g_context, g_global, "frame");
    g_frame_valid = true;
    if (!JS_IsFunction(g_context, g_frame))
    {
        rt_kprintf("[PocketJS] globalThis.frame is missing\n");
        goto fail;
    }
    rt_kprintf("[PocketJS] guest mounted: %s (%u-byte JS, %u-byte pak, %u-byte native)\n", name,
               (unsigned)bundle_len, (unsigned)pak_len, (unsigned)epic_len);
    return true;

fail:
    pocketjs_guest_unmount();
    return false;
}

bool pocketjs_guest_frame(uint32_t buttons, const uint32_t *touches, size_t touch_count)
{
    JSValue arguments[4];
    JSValue result;
    int argument_count = 2;
    uint32_t no_touch = 0;
    int32_t hits[8] = {0};
    size_t hit_count;
    size_t index;

    touch_count = touch_count > 8 ? 8 : touch_count;
    hit_count = pocket_core_touch_hits(g_core, touch_count > 0 ? touches : &no_touch, touch_count,
                                       hits);
    arguments[0] = JS_NewInt32(g_context, (int32_t)buttons);
    arguments[1] = JS_NewInt32(g_context, 0x8080);
    if (touch_count > 0)
    {
        arguments[2] = JS_NewArray(g_context);
        arguments[3] = JS_NewArray(g_context);
        for (index = 0; index < touch_count; ++index)
        {
            JS_SetPropertyUint32(g_context, arguments[2], (uint32_t)index,
                                 JS_NewInt32(g_context, (int32_t)touches[index]));
        }
        for (index = 0; index < hit_count; ++index)
        {
            JS_SetPropertyUint32(g_context, arguments[3], (uint32_t)index,
                                 JS_NewInt32(g_context, hits[index]));
        }
        argument_count = 4;
    }

    result = JS_Call(g_context, g_frame, g_global, argument_count, arguments);
    if (touch_count > 0)
    {
        JS_FreeValue(g_context, arguments[3]);
        JS_FreeValue(g_context, arguments[2]);
    }
    if (JS_IsException(result))
    {
        log_exception(g_context, "frame");
        JS_FreeValue(g_context, result);
        return false;
    }
    JS_FreeValue(g_context, result);
    drain_jobs();
    pocket_core_tick(g_core);

    ++g_guest_frames;
    if ((g_guest_frames % (POCKETJS_TICK_HZ * 4u)) == 0)
    {
        JS_RunGC(g_runtime);
    }
    return true;
}

bool pocketjs_guest_render(uint16_t *framebuffer, size_t pixel_count, uint32_t target_index,
                           PocketRenderStats *stats)
{
#ifdef POCKETJS_FORCE_SOFTWARE
    (void)target_index;
    memset(stats, 0, sizeof(*stats));
    return pocket_core_render_rgb565_software(g_core, framebuffer, pixel_count) == 0;
#else
    return pocket_core_render_rgb565(g_core, framebuffer, pixel_count, target_index, stats) == 0;
#endif
}

bool pocketjs_guest_render_software(uint16_t *framebuffer, size_t pixel_count)
{
    return pocket_core_render_rgb565_software(g_core, framebuffer, pixel_count) == 0;
}

uint64_t pocketjs_guest_draw_hash(void)
{
    return pocket_core_draw_hash(g_core);
}

size_t pocketjs_guest_js_heap_bytes(void)
{
    return g_qjs_heap_bytes;
}
