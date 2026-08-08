# PocketJS Nintendo 3DS host — run INSIDE the devkitpro/devkitarm container.
#
# tools/3ds.ts builds the Rust staticlib and QuickJS on macOS, then invokes
# this with CWD hosts/3ds and every path already translated to a container
# path. All inputs arrive as ENVIRONMENT variables, so the recipes below only
# ever read them:
#
#   POCKETJS_TARGET          target id to publish as ui.__host
#   POCKETJS_HOST_ABI        ABI number to publish as ui.__hostAbi
#   POCKETJS_LOGICAL_WIDTH   guest viewport, baked into the host
#   POCKETJS_LOGICAL_HEIGHT
#   POCKETJS_RASTER_DENSITY  raster samples per logical pixel
#   POCKETJS_CORE_LIB        libpocketjs_3ds_core.a
#   POCKETJS_QUICKJS_DIR     directory holding quickjs.h and libquickjs.a
#   POCKETJS_APP_JS          guest bundle to embed
#   POCKETJS_APP_PAK         guest pak to embed
#   POCKETJS_BUILD_DIR       scratch for objects, the .shbin, the .elf, romfs
#   POCKETJS_OUT_3DSX        the .3dsx to write
#   POCKETJS_SMDH_TITLE      SMDH metadata
#   POCKETJS_SMDH_AUTHOR
#   POCKETJS_SMDH_DESC
#   POCKETJS_CAPTURE         "1" builds the deterministic e2e binary
#   POCKETJS_CAPTURE_INPUT   baked input tape, "frame:mask,frame:mask"
#   POCKETJS_CAP_START       first frame to dump
#   POCKETJS_CAP_N           how many frames to dump
#
# The tape and the capture window travel INSIDE the binary: a capture run never
# reads the emulator's filesystem for its input. Nothing is written outside
# POCKETJS_BUILD_DIR and POCKETJS_OUT_3DSX.

DEVKITPRO ?= /opt/devkitpro
DEVKITARM ?= $(DEVKITPRO)/devkitARM

SOURCE := $(CURDIR)/src
INCLUDE_DIR := $(CURDIR)/include
BUILD := $(POCKETJS_BUILD_DIR)
OUT := $(POCKETJS_OUT_3DSX)
# 3dsxtool reads the guest out of a RomFS directory, so the two embedded files
# are staged under one.
ROMFS := $(BUILD)/romfs
ICON ?= $(CURDIR)/icon.png

CC := $(DEVKITARM)/bin/arm-none-eabi-gcc
PICASSO := $(DEVKITPRO)/tools/bin/picasso
BIN2S := $(DEVKITPRO)/tools/bin/bin2s
SMDHTOOL := $(DEVKITPRO)/tools/bin/smdhtool
THREEDSXTOOL := $(DEVKITPRO)/tools/bin/3dsxtool

# The ARM11 in both console revisions: ARMv6K, MPCore tuning, hardware float,
# and the soft thread pointer libctru is built against. -mword-relocations is
# what keeps the 3dsx loader's relocation table expressible.
ARCH := -march=armv6k -mtune=mpcore -mfloat-abi=hard -mtp=soft

# JS_NO_NAN_BOXING is not optional and not cosmetic: quickjs.h turns NaN boxing
# ON by default for any 32-bit target, which makes JSValue 8 bytes instead of
# 16. libquickjs.a is built with it defined (the Vita treatment in
# libquickjs-sys/build.rs), so a translation unit that includes quickjs.h
# without it links cleanly and then hands the library differently shaped
# values — the guest boots and QuickJS's GC walks garbage pointers.
CFLAGS := -Wall -Wextra -O2 -g -std=gnu11 -mword-relocations -ffunction-sections -fdata-sections \
  $(ARCH) -D__3DS__ -DJS_NO_NAN_BOXING \
  -DPOCKETJS_TARGET_ID='"$(POCKETJS_TARGET)"' \
  -DPOCKETJS_HOST_ABI=$(POCKETJS_HOST_ABI) \
  -DPOCKETJS_VIEW_W=$(POCKETJS_LOGICAL_WIDTH) \
  -DPOCKETJS_VIEW_H=$(POCKETJS_LOGICAL_HEIGHT) \
  -DPOCKETJS_RASTER_DENSITY=$(POCKETJS_RASTER_DENSITY) \
  -I$(INCLUDE_DIR) -I$(BUILD) -I$(POCKETJS_QUICKJS_DIR) \
  -I$(DEVKITPRO)/libctru/include

ifeq ($(POCKETJS_CAPTURE),1)
CFLAGS += -DPOCKETJS_CAPTURE \
  -DPOCKETJS_CAPTURE_INPUT='"$(POCKETJS_CAPTURE_INPUT)"' \
  -DPOCKETJS_CAP_START=$(POCKETJS_CAP_START) \
  -DPOCKETJS_CAP_N=$(POCKETJS_CAP_N)
endif

LDFLAGS := -specs=3dsx.specs $(ARCH) -Wl,--gc-sections -Wl,-Map,$(BUILD)/pocketjs-3ds.map
LIBPATHS := -L$(DEVKITPRO)/libctru/lib
LIBS := -lcitro3d -lctru -lm

OBJECTS := $(BUILD)/main.o $(BUILD)/gfx.o $(BUILD)/qjs.o $(BUILD)/input.o $(BUILD)/vshader_shbin.o
ELF := $(BUILD)/pocketjs-3ds.elf
SMDH := $(BUILD)/pocketjs-3ds.smdh

.PHONY: all clean
all: $(OUT)

$(BUILD) $(ROMFS):
	mkdir -p $@

# The PICA200 vertex shader is assembled and linked in as data; there is no
# fragment shader on this GPU (gfx.c drives TEV stages instead).
$(BUILD)/vshader.shbin: $(SOURCE)/vshader.v.pica | $(BUILD)
	$(PICASSO) -o $@ $<

$(BUILD)/vshader_shbin.s $(BUILD)/vshader_shbin.h: $(BUILD)/vshader.shbin
	cd $(BUILD) && $(BIN2S) -a 4 -H vshader_shbin.h vshader.shbin > vshader_shbin.s

$(BUILD)/vshader_shbin.o: $(BUILD)/vshader_shbin.s
	$(CC) $(ARCH) -c $< -o $@

# The capture window, the input tape and the viewport reach the C sources as -D
# defines, so a rebuild driven by source mtimes alone would keep a previous
# run's values — a stale tape or a short capture window produces a plausible
# .3dsx that dumps the wrong frames. Objects therefore depend on a stamp
# carrying the flags themselves, rewritten only when they actually change (the
# make-side counterpart of cargo:rerun-if-env-changed).
FLAGS_STAMP := $(BUILD)/cflags.stamp
.PHONY: $(FLAGS_STAMP).probe
$(FLAGS_STAMP).probe: | $(BUILD)
	@printf '%s\n' "$(CFLAGS)" > $(FLAGS_STAMP).new
	@cmp -s $(FLAGS_STAMP).new $(FLAGS_STAMP) || mv $(FLAGS_STAMP).new $(FLAGS_STAMP)
	@rm -f $(FLAGS_STAMP).new
$(FLAGS_STAMP): $(FLAGS_STAMP).probe ;

$(BUILD)/%.o: $(SOURCE)/%.c $(BUILD)/vshader_shbin.h $(FLAGS_STAMP) | $(BUILD)
	$(CC) $(CFLAGS) -c $< -o $@

$(ELF): $(OBJECTS)
	$(CC) $(LDFLAGS) $(OBJECTS) $(POCKETJS_CORE_LIB) $(POCKETJS_QUICKJS_DIR)/libquickjs.a \
	  $(LIBPATHS) $(LIBS) -o $@

$(ROMFS)/app.js: $(POCKETJS_APP_JS) | $(ROMFS)
	cp $< $@

$(ROMFS)/app.pak: $(POCKETJS_APP_PAK) | $(ROMFS)
	cp $< $@

# 3dsxtool refuses to embed a RomFS without SMDH metadata, so one is always
# built, from the app's own strings over the host's icon.
$(SMDH): $(ICON) | $(BUILD)
	$(SMDHTOOL) --create "$(POCKETJS_SMDH_TITLE)" "$(POCKETJS_SMDH_DESC)" \
	  "$(POCKETJS_SMDH_AUTHOR)" $(ICON) $@

$(OUT): $(ELF) $(SMDH) $(ROMFS)/app.js $(ROMFS)/app.pak
	mkdir -p $(dir $(OUT))
	$(THREEDSXTOOL) $(ELF) $@ --romfs=$(ROMFS) --smdh=$(SMDH)

clean:
	rm -rf $(BUILD) $(OUT)
