#---------------------------------------------------------------------------------
# PocketJS 3DS host Makefile — devkitARM 3ds_rules (adapted from the proven
# dreamcart runtime-3ds/Makefile). Builds source/ (the C host) + quickjs/ (the
# bundled Bellard fork) and links libpocketjs_3ds_ffi.a (the Rust bridge, cross-
# built for armv6k-nintendo-3ds by scripts/3ds.ts). Output: pocketjs-3ds.3dsx.
#
# `quickjs/` is NOT vendored in this repo — populate it from the proven 3DS fork
# (dreamcart runtime-3ds/quickjs) before building; see native-3ds/README.md.
#---------------------------------------------------------------------------------
.SUFFIXES:

ifeq ($(strip $(DEVKITARM)),)
$(error "Please set DEVKITARM (export DEVKITARM=<devkitpro>/devkitARM)")
endif

TOPDIR ?= $(CURDIR)
include $(DEVKITARM)/3ds_rules

#---------------------------------------------------------------------------------
TARGET   := pocketjs-3ds
BUILD    := build
SOURCES  := source quickjs
DATA     := data
INCLUDES := source quickjs
NO_SMDH  := 1

# The Rust bridge staticlib (scripts/3ds.ts cross-builds it here).
RUST_LIBDIR := $(TOPDIR)/ffi/target/armv6k-nintendo-3ds/release

#---------------------------------------------------------------------------------
ARCH := -march=armv6k -mtune=mpcore -mfloat-abi=hard -mtp=soft

CFLAGS := -g -Wall -O2 -mword-relocations -ffunction-sections $(ARCH)

# QuickJS config (matches the PSP/dreamcart build: no CONFIG_BIGNUM). -fpermissive
# downgrades int/int32_t pointer mismatches (int32_t is `long` on this ABI) from
# gcc-14 hard errors to warnings.
CFLAGS += $(INCLUDE) -D__3DS__ -D_GNU_SOURCE -DCONFIG_VERSION='"2021-03-27"' \
          -fpermissive \
          -Wno-incompatible-pointer-types -Wno-implicit-function-declaration \
          -Wno-int-conversion -Wno-unused-variable -Wno-unused-but-set-variable \
          -Wno-unused-function -Wno-format-truncation -Wno-array-bounds -Wno-sign-compare

CXXFLAGS := $(CFLAGS) -fno-rtti -fno-exceptions -std=gnu++11
ASFLAGS  := -g $(ARCH)
LDFLAGS   = -specs=3dsx.specs -g $(ARCH) -Wl,-Map,$(notdir $*.map)

# v1 renders via libctru gfx (no citro); the Rust bridge is linked first. If the
# bridge is built with -Z build-std=std you may also need -lpthread; see README.
LIBS := -L$(RUST_LIBDIR) -lpocketjs_3ds_ffi -lctru -lm

#---------------------------------------------------------------------------------
LIBDIRS := $(CTRULIB)

#---------------------------------------------------------------------------------
ifneq ($(BUILD),$(notdir $(CURDIR)))
#---------------------------------------------------------------------------------
export OUTPUT  := $(CURDIR)/$(TARGET)
export TOPDIR  := $(CURDIR)
export VPATH   := $(foreach dir,$(SOURCES),$(CURDIR)/$(dir)) \
                  $(foreach dir,$(DATA),$(CURDIR)/$(dir))
export DEPSDIR := $(CURDIR)/$(BUILD)

CFILES   := $(foreach dir,$(SOURCES),$(notdir $(wildcard $(dir)/*.c)))
CPPFILES := $(foreach dir,$(SOURCES),$(notdir $(wildcard $(dir)/*.cpp)))
SFILES   := $(foreach dir,$(SOURCES),$(notdir $(wildcard $(dir)/*.s)))
BINFILES := $(foreach dir,$(DATA),$(notdir $(wildcard $(dir)/*.*)))

ifeq ($(strip $(CPPFILES)),)
	export LD := $(CC)
else
	export LD := $(CXX)
endif

export OFILES_SOURCES := $(CPPFILES:.cpp=.o) $(CFILES:.c=.o) $(SFILES:.s=.o)
export OFILES_BIN     := $(addsuffix .o,$(BINFILES))
export OFILES         := $(OFILES_BIN) $(OFILES_SOURCES)
export HFILES         := $(addsuffix .h,$(subst .,_,$(BINFILES)))
export INCLUDE  := $(foreach dir,$(INCLUDES),-I$(CURDIR)/$(dir)) \
                   $(foreach dir,$(LIBDIRS),-I$(dir)/include) \
                   -I$(CURDIR)/$(BUILD)
export LIBPATHS := $(foreach dir,$(LIBDIRS),-L$(dir)/lib)

.PHONY: all clean
all: $(BUILD)
	@$(MAKE) --no-print-directory -C $(BUILD) -f $(CURDIR)/Makefile
$(BUILD):
	@mkdir -p $@
clean:
	@echo clean ...
	@rm -fr $(BUILD) $(TARGET).3dsx $(OUTPUT).smdh $(TARGET).elf

#---------------------------------------------------------------------------------
else
#---------------------------------------------------------------------------------
$(OUTPUT).3dsx : $(OUTPUT).elf
$(OUTPUT).elf  : $(OFILES)

%.bin.o %_bin.h : %.bin
	@echo $(notdir $<)
	@$(bin2o)

-include $(DEPSDIR)/*.d
#---------------------------------------------------------------------------------
endif
#---------------------------------------------------------------------------------
