REPO_ROOT := ../..
BUILD_DIR := build
DIST_DIR ?= $(REPO_ROOT)/dist/nspire
TARGET_JSON := $(CURDIR)/targets/armv5te-nspire-eabi.json
CORE_MANIFEST := $(REPO_ROOT)/engine/symbian/Cargo.toml
CORE_ARCHIVE := $(REPO_ROOT)/engine/symbian/target/armv5te-nspire-eabi/release/libpocketjs_symbian_core.a
APP_DATA := $(BUILD_DIR)/app_data.c

GCC := nspire-gcc
LD := nspire-ld
GENZEHN := genzehn
MAKE_PRG := make-prg

ifeq ($(QUICKJS_DIR),)
ifneq ($(MAKECMDGOALS),clean)
$(error QUICKJS_DIR is required and must contain libquickjs-sys/embed/quickjs)
endif
endif
QJS_SRC := $(QUICKJS_DIR)/libquickjs-sys/embed/quickjs
QJS_NAMES := quickjs cutils libregexp libunicode dtoa
QJS_OBJS := $(addprefix $(BUILD_DIR)/qjs/,$(addsuffix .o,$(QJS_NAMES)))
HOST_OBJS := $(BUILD_DIR)/main.o $(BUILD_DIR)/input.o $(BUILD_DIR)/framebuffer.o \
             $(BUILD_DIR)/compat.o \
             $(BUILD_DIR)/pocket_runtime.o $(BUILD_DIR)/app_data.o

COMMON_CFLAGS := -std=gnu11 -Os -marm -ffunction-sections -fdata-sections \
  -fno-strict-aliasing -funsigned-char -Wall -Wextra \
  -I. -I../iphone2g -I$(QJS_SRC) \
  -DPOCKETJS_TARGET_ID='"nspire-cx2-dev"' -DPOCKETJS_HOST_ABI=9 \
  -DPOCKET_RASTER_DENSITY=1 -DPOCKET_RUNTIME_REPORT_BOOT_STAGE=1 \
  -DPOCKET_RUNTIME_INCLUDE_EXCEPTION_STACK=1 \
  -DPOCKET_RUNTIME_JS_STACK_SIZE=65536 \
  -DPOCKETJS_NO_MALLOC_USABLE_SIZE=1
QJS_CFLAGS := $(COMMON_CFLAGS) -D_GNU_SOURCE \
  -DPOCKETJS_NO_ATOMICS=1 -DPOCKETJS_FIXED_TIMEZONE=1 \
  -DCONFIG_VERSION='"pocket-nspire-cx2"' -D__TM_GMTOFF=tm_gmtoff \
  -include malloc.h -Wno-sign-compare -Wno-unused-parameter
LDFLAGS := -Wl,--gc-sections -Wl,-Map,$(BUILD_DIR)/pocketjs-cx2.map

.PHONY: all clean core check-app-data
all: $(DIST_DIR)/pocketjs-cx2.tns

check-app-data:
	@test -f $(APP_DATA) || (echo "missing $(APP_DATA); run bun nspire bundle"; exit 1)

core:
	cd $(REPO_ROOT)/engine/symbian && cargo build --release --locked \
	  --no-default-features --features software-only,boot-stage \
	  --target $(TARGET_JSON) -Z json-target-spec \
	  -Z build-std=core,alloc,compiler_builtins \
	  -Z build-std-features=compiler-builtins-mem

$(BUILD_DIR) $(BUILD_DIR)/qjs $(DIST_DIR):
	mkdir -p $@

$(BUILD_DIR)/main.o: main.c | $(BUILD_DIR)
	$(GCC) $(COMMON_CFLAGS) -c $< -o $@

$(BUILD_DIR)/input.o: input.c | $(BUILD_DIR)
	$(GCC) $(COMMON_CFLAGS) -c $< -o $@

$(BUILD_DIR)/framebuffer.o: framebuffer.c | $(BUILD_DIR)
	$(GCC) $(COMMON_CFLAGS) -c $< -o $@

$(BUILD_DIR)/compat.o: compat.c | $(BUILD_DIR)
	$(GCC) $(COMMON_CFLAGS) -c $< -o $@

$(BUILD_DIR)/pocket_runtime.o: ../iphone2g/pocket_runtime.c | $(BUILD_DIR)
	$(GCC) $(COMMON_CFLAGS) -c $< -o $@

$(BUILD_DIR)/app_data.o: check-app-data $(APP_DATA) | $(BUILD_DIR)
	$(GCC) $(COMMON_CFLAGS) -c $(APP_DATA) -o $@

$(BUILD_DIR)/qjs/%.o: $(QJS_SRC)/%.c | $(BUILD_DIR)/qjs
	$(GCC) $(QJS_CFLAGS) -c $< -o $@

$(BUILD_DIR)/pocketjs-cx2.elf: core $(HOST_OBJS) $(QJS_OBJS) | $(BUILD_DIR)
	$(LD) $(HOST_OBJS) $(QJS_OBJS) $(CORE_ARCHIVE) -o $@ $(LDFLAGS) -lm

$(DIST_DIR)/pocketjs-cx2.tns: $(BUILD_DIR)/pocketjs-cx2.elf | $(DIST_DIR)
	$(GENZEHN) --input $< --output $(BUILD_DIR)/pocketjs-cx2.zehn \
	  --name "PocketJS CX II" --uses-lcd-blit true
	$(MAKE_PRG) $(BUILD_DIR)/pocketjs-cx2.zehn $@

clean:
	rm -rf $(BUILD_DIR)
	rm -f $(DIST_DIR)/pocketjs-cx2.tns
