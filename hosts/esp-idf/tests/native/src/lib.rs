#[cfg(test)]
mod tests {
    use core::ptr;
    use pocketjs_idf_abi::*;
    use pocketjs_idf_render_rgb565::*;
    use pocketjs_idf_ui_core::*;

    #[test]
    fn rejects_out_of_range_density_without_panicking() {
        for density in [0, 256, u32::MAX] {
            let config = NativeUiConfig {
                struct_size: core::mem::size_of::<NativeUiConfig>(),
                logical_width: 32,
                logical_height: 16,
                raster_density: density,
                tick_hz: 60,
            };
            let mut core = ptr::null_mut();
            assert_eq!(unsafe { pocketjs_native_ui_create(&config, &mut core) }, -1);
            assert!(core.is_null());
        }
    }

    #[test]
    fn instance_core_and_transactional_software_renderer_roundtrip() {
        unsafe {
            let config = NativeUiConfig {
                struct_size: core::mem::size_of::<NativeUiConfig>(),
                logical_width: 32,
                logical_height: 16,
                raster_density: 1,
                tick_hz: 60,
            };
            let mut core = ptr::null_mut();
            assert_eq!(pocketjs_native_ui_create(&config, &mut core), 0);
            let mut actual_config = NativeUiConfig {
                struct_size: core::mem::size_of::<NativeUiConfig>(),
                logical_width: 0,
                logical_height: 0,
                raster_density: 0,
                tick_hz: 0,
            };
            assert_eq!(pocketjs_native_ui_get_config(core, &mut actual_config), 0);
            assert_eq!(actual_config.logical_width, 32);
            assert_eq!(actual_config.logical_height, 16);
            assert_eq!(actual_config.raster_density, 1);
            assert_eq!(actual_config.tick_hz, 60);
            pocketjs_native_ui_tick(core);
            let mut frame = NativeFrameView {
                struct_size: core::mem::size_of::<NativeFrameView>(),
                epoch: 0,
                raster_revision: 0,
                logical_width: 0,
                logical_height: 0,
                raster_density: 0,
                draw_words: ptr::null(),
                draw_word_count: 0,
                private_core: ptr::null_mut(),
            };
            assert_eq!(pocketjs_native_ui_draw(core, &mut frame), 0);
            assert_eq!((frame.logical_width, frame.logical_height), (32, 16));

            let renderer_config = NativeRendererConfig {
                struct_size: core::mem::size_of::<NativeRendererConfig>(),
                scale: 1,
                min_fill_pixels: 1,
                min_blend_pixels: 1,
                min_srm_pixels: 1,
            };
            let mut renderer = ptr::null_mut();
            let mut target = ptr::null_mut();
            assert_eq!(
                pocketjs_native_renderer_create(&renderer_config, &mut renderer),
                0
            );
            assert_eq!(pocketjs_native_render_target_create(&mut target), 0);
            let mut plan = NativeDamagePlan {
                struct_size: core::mem::size_of::<NativeDamagePlan>(),
                region_count: 0,
                full_redraw: false,
                regions: [NativeRect::default(); MAX_DAMAGE_REGIONS],
            };
            assert_eq!(
                pocketjs_native_renderer_prepare(renderer, target, &frame, &mut plan),
                0
            );
            assert!(plan.full_redraw);
            assert_eq!(plan.region_count, 1);
            let region = plan.regions[0];
            let mut pixels = vec![0xffffu16; 32 * 16];
            let mut stats = NativeRenderStats {
                struct_size: core::mem::size_of::<NativeRenderStats>(),
                ppa_fills: 0,
                ppa_blends: 0,
                ppa_srm: 0,
                software_ops: 0,
                software_words: 0,
                damage_regions: 0,
                damage_pixels: 0,
                damage_bounds: NativeRect::default(),
                full_redraw: false,
            };
            assert_eq!(
                pocketjs_native_renderer_render_strip(
                    renderer,
                    &frame,
                    pixels.as_mut_ptr(),
                    pixels.len(),
                    region,
                    ptr::null(),
                    &mut stats,
                ),
                0
            );
            assert!(pixels.iter().all(|pixel| *pixel == 0));
            assert_eq!(pocketjs_native_renderer_commit(renderer, target, &frame), 1);
            assert_eq!(
                pocketjs_native_renderer_commit(renderer, target, &frame),
                -1
            );
            let previous = frame;
            assert_eq!(pocketjs_native_ui_draw(core, &mut frame), 0);
            assert_ne!(previous.epoch, frame.epoch);
            assert_eq!(
                pocketjs_native_renderer_prepare(renderer, target, &previous, &mut plan),
                -1
            );
            assert_eq!(
                pocketjs_native_renderer_prepare(renderer, target, &frame, &mut plan),
                0
            );
            let prepared = frame;
            assert_eq!(pocketjs_native_ui_draw(core, &mut frame), 0);
            assert_eq!(
                pocketjs_native_renderer_commit(renderer, target, &prepared),
                -1
            );
            assert_eq!(
                pocketjs_native_ui_touch_hits(core, ptr::null(), 0, ptr::null_mut(), 0),
                0
            );
            pocketjs_native_ui_tick(core);
            assert_eq!(
                pocketjs_native_renderer_prepare(renderer, target, &frame, &mut plan),
                -1
            );
            assert_eq!(pocketjs_native_ui_draw(core, &mut frame), 0);
            let mismatched_config = NativeRendererConfig {
                struct_size: core::mem::size_of::<NativeRendererConfig>(),
                scale: 2,
                min_fill_pixels: 1,
                min_blend_pixels: 1,
                min_srm_pixels: 1,
            };
            let mut mismatched_renderer = ptr::null_mut();
            let mut mismatched_target = ptr::null_mut();
            assert_eq!(
                pocketjs_native_renderer_create(&mismatched_config, &mut mismatched_renderer),
                0
            );
            assert_eq!(
                pocketjs_native_render_target_create(&mut mismatched_target),
                0
            );
            assert_eq!(
                pocketjs_native_renderer_prepare(
                    mismatched_renderer,
                    mismatched_target,
                    &frame,
                    &mut plan,
                ),
                -1
            );
            pocketjs_native_render_target_destroy(mismatched_target);
            pocketjs_native_renderer_destroy(mismatched_renderer);

            pocketjs_native_render_target_destroy(target);
            pocketjs_native_renderer_destroy(renderer);
            pocketjs_native_ui_destroy(core);
        }
    }
}
