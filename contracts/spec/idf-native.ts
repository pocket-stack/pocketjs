// Shared definition for the ESP-IDF C/Rust data ABI.
// Generated consumers: tools/esp-idf-contracts.ts --check.

export const IDF_NATIVE_STRUCTS = [
  {
    "name": "NativeUiConfig",
    "cName": "pocketjs_ui_core_config_t",
    "component": "core",
    "fields": [
      {
        "name": "struct_size",
        "cName": "struct_size",
        "type": "usize"
      },
      {
        "name": "logical_width",
        "cName": "logical_width",
        "type": "u32"
      },
      {
        "name": "logical_height",
        "cName": "logical_height",
        "type": "u32"
      },
      {
        "name": "raster_density",
        "cName": "raster_density",
        "type": "u32"
      },
      {
        "name": "tick_hz",
        "cName": "tick_hz",
        "type": "u32"
      }
    ]
  },
  {
    "name": "NativeAsset",
    "cName": "pocketjs_ui_asset_t",
    "component": "core",
    "fields": [
      {
        "name": "struct_size",
        "cName": "struct_size",
        "type": "usize"
      },
      {
        "name": "kind",
        "cName": "kind",
        "type": "u32"
      },
      {
        "name": "data",
        "cName": "data",
        "type": "*const u8"
      },
      {
        "name": "size",
        "cName": "size",
        "type": "usize"
      }
    ]
  },
  {
    "name": "NativeFrameView",
    "cName": "pocketjs_ui_frame_view_t",
    "component": "core",
    "fields": [
      {
        "name": "struct_size",
        "cName": "struct_size",
        "type": "usize"
      },
      {
        "name": "epoch",
        "cName": "epoch",
        "type": "u64"
      },
      {
        "name": "raster_revision",
        "cName": "raster_revision",
        "type": "u64"
      },
      {
        "name": "logical_width",
        "cName": "logical_width",
        "type": "u32"
      },
      {
        "name": "logical_height",
        "cName": "logical_height",
        "type": "u32"
      },
      {
        "name": "raster_density",
        "cName": "raster_density",
        "type": "u32"
      },
      {
        "name": "draw_words",
        "cName": "draw_words",
        "type": "*const u32"
      },
      {
        "name": "draw_word_count",
        "cName": "draw_word_count",
        "type": "usize"
      },
      {
        "name": "private_core",
        "cName": "_private_core",
        "type": "*mut c_void"
      }
    ]
  },
  {
    "name": "NativeTextureView",
    "cName": "pocketjs_ui_texture_view_t",
    "component": "core",
    "fields": [
      {
        "name": "struct_size",
        "cName": "struct_size",
        "type": "usize"
      },
      {
        "name": "pixels",
        "cName": "pixels",
        "type": "*const u8"
      },
      {
        "name": "pixel_bytes",
        "cName": "pixel_bytes",
        "type": "usize"
      },
      {
        "name": "width",
        "cName": "width",
        "type": "u32"
      },
      {
        "name": "height",
        "cName": "height",
        "type": "u32"
      },
      {
        "name": "psm",
        "cName": "psm",
        "type": "u32"
      },
      {
        "name": "palette",
        "cName": "palette",
        "type": "*const u8"
      },
      {
        "name": "palette_bytes",
        "cName": "palette_bytes",
        "type": "usize"
      },
      {
        "name": "revision",
        "cName": "revision",
        "type": "u64"
      },
      {
        "name": "linear",
        "cName": "linear",
        "type": "bool"
      }
    ]
  },
  {
    "name": "NativeFontView",
    "cName": "pocketjs_ui_font_view_t",
    "component": "core",
    "fields": [
      {
        "name": "struct_size",
        "cName": "struct_size",
        "type": "usize"
      },
      {
        "name": "bitmap",
        "cName": "bitmap",
        "type": "*const u8"
      },
      {
        "name": "bitmap_bytes",
        "cName": "bitmap_bytes",
        "type": "usize"
      },
      {
        "name": "cell_width",
        "cName": "cell_width",
        "type": "u32"
      },
      {
        "name": "cell_height",
        "cName": "cell_height",
        "type": "u32"
      },
      {
        "name": "raster_density",
        "cName": "raster_density",
        "type": "u32"
      },
      {
        "name": "glyph_count",
        "cName": "glyph_count",
        "type": "u32"
      }
    ]
  },
  {
    "name": "NativeRendererConfig",
    "cName": "pocketjs_rgb565_renderer_config_t",
    "component": "renderer",
    "fields": [
      {
        "name": "struct_size",
        "cName": "struct_size",
        "type": "usize"
      },
      {
        "name": "scale",
        "cName": "scale",
        "type": "u32"
      },
      {
        "name": "min_fill_pixels",
        "cName": "min_fill_pixels",
        "type": "u32"
      },
      {
        "name": "min_blend_pixels",
        "cName": "min_blend_pixels",
        "type": "u32"
      },
      {
        "name": "min_srm_pixels",
        "cName": "min_srm_pixels",
        "type": "u32"
      }
    ]
  },
  {
    "name": "NativeRect",
    "cName": "pocketjs_rgb565_rect_t",
    "component": "renderer",
    "fields": [
      {
        "name": "x",
        "cName": "x",
        "type": "u32"
      },
      {
        "name": "y",
        "cName": "y",
        "type": "u32"
      },
      {
        "name": "width",
        "cName": "width",
        "type": "u32"
      },
      {
        "name": "height",
        "cName": "height",
        "type": "u32"
      }
    ]
  },
  {
    "name": "NativeDamagePlan",
    "cName": "pocketjs_rgb565_damage_plan_t",
    "component": "renderer",
    "fields": [
      {
        "name": "struct_size",
        "cName": "struct_size",
        "type": "usize"
      },
      {
        "name": "region_count",
        "cName": "region_count",
        "type": "u32"
      },
      {
        "name": "full_redraw",
        "cName": "full_redraw",
        "type": "bool"
      },
      {
        "name": "regions",
        "cName": "regions",
        "type": "[NativeRect; MAX_DAMAGE_REGIONS]"
      }
    ]
  },
  {
    "name": "NativeRenderStats",
    "cName": "pocketjs_rgb565_render_stats_t",
    "component": "renderer",
    "fields": [
      {
        "name": "struct_size",
        "cName": "struct_size",
        "type": "usize"
      },
      {
        "name": "ppa_fills",
        "cName": "ppa_fills",
        "type": "u32"
      },
      {
        "name": "ppa_blends",
        "cName": "ppa_blends",
        "type": "u32"
      },
      {
        "name": "ppa_srm",
        "cName": "ppa_srm",
        "type": "u32"
      },
      {
        "name": "software_ops",
        "cName": "software_ops",
        "type": "u32"
      },
      {
        "name": "software_words",
        "cName": "software_words",
        "type": "u32"
      },
      {
        "name": "damage_regions",
        "cName": "damage_regions",
        "type": "u32"
      },
      {
        "name": "damage_pixels",
        "cName": "damage_pixels",
        "type": "u32"
      },
      {
        "name": "damage_bounds",
        "cName": "damage_bounds",
        "type": "NativeRect"
      },
      {
        "name": "full_redraw",
        "cName": "full_redraw",
        "type": "bool"
      }
    ]
  },
  {
    "name": "NativeAccelerator",
    "cName": "pocketjs_rgb565_accelerator_t",
    "component": "renderer",
    "fields": [
      {
        "name": "struct_size",
        "cName": "struct_size",
        "type": "usize"
      },
      {
        "name": "user_data",
        "cName": "user_data",
        "type": "*mut c_void"
      },
      {
        "name": "fill_rgb565",
        "cName": "fill_rgb565",
        "type": "Option<FillFn>"
      },
      {
        "name": "blend_a8_rgb565",
        "cName": "blend_a8_rgb565",
        "type": "Option<BlendFn>"
      },
      {
        "name": "srm_psm5650_rgb565",
        "cName": "srm_psm5650_rgb565",
        "type": "Option<SrmFn>"
      }
    ]
  }
] as const;

export const IDF_NATIVE_CALLBACKS = [
  {
    "name": "FillFn",
    "cName": "pocketjs_rgb565_fill_fn",
    "args": [
      "*mut c_void",
      "*mut u16",
      "usize",
      "u32",
      "u32",
      "NativeRect",
      "u16"
    ]
  },
  {
    "name": "BlendFn",
    "cName": "pocketjs_rgb565_blend_fn",
    "args": [
      "*mut c_void",
      "*mut u16",
      "usize",
      "u32",
      "u32",
      "*const u8",
      "usize",
      "NativeRect",
      "u8",
      "u8",
      "u8",
      "u8"
    ]
  },
  {
    "name": "SrmFn",
    "cName": "pocketjs_rgb565_srm_fn",
    "args": [
      "*mut c_void",
      "*mut u16",
      "usize",
      "u32",
      "u32",
      "*const u8",
      "usize",
      "u32",
      "u32",
      "NativeRect",
      "NativeRect",
      "u32",
      "bool",
      "bool"
    ]
  }
] as const;
