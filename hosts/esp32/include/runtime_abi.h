#pragma once

#include <cstddef>
#include <cstdint>

extern const std::uint8_t symbian_pocket_qbc[];
extern const std::size_t symbian_pocket_qbc_len;
extern const std::uint8_t symbian_pocket_pak[];
extern const std::size_t symbian_pocket_pak_len;

extern "C" {
int pocketjs_runtime_init(
    const std::uint8_t* bytecode,
    std::size_t bytecode_len,
    const std::uint8_t* pak,
    std::size_t pak_len,
    std::uint32_t width,
    std::uint32_t height);
int pocketjs_runtime_frame(std::uint32_t buttons);
int pocketjs_runtime_render_rgb565(std::uint16_t* framebuffer, std::size_t pixel_count);
std::size_t pocketjs_runtime_qjs_peak_bytes();
void pocketjs_runtime_shutdown();
}
