.SUFFIXES:

ifeq ($(strip $(DEVKITPRO)),)
$(error "Please set DEVKITPRO (normally /opt/devkitpro)")
endif

TOPDIR ?= $(CURDIR)
include $(DEVKITPRO)/libnx/switch_rules

TARGET := pocketjs-switch
BUILD := build
SOURCES := source
ROMFS := romfs
RUST_TARGET := aarch64-nintendo-switch-freestanding
RUST_PROFILE ?= release
RUSTLIB := $(TOPDIR)/target/$(RUST_TARGET)/$(RUST_PROFILE)/libpocketjs_switch.a

APP_TITLE ?= PocketJS
APP_AUTHOR ?= PocketJS
APP_VERSION ?= 0.1.0

ARCH := -march=armv8-a+crc+crypto -mtune=cortex-a57 -mtp=soft -fPIE
CFLAGS := -g -Wall -Wextra -O2 -ffunction-sections $(ARCH) $(DEFINES)
CFLAGS += $(INCLUDE) -D__SWITCH__
ASFLAGS := -g $(ARCH)
LDFLAGS = -specs=$(DEVKITPRO)/libnx/switch.specs -g $(ARCH) \
	-Wl,-Map,$(notdir $*.map)
LIBS := $(RUSTLIB) -lm -lnx
LIBDIRS := $(PORTLIBS) $(LIBNX)

ifneq ($(BUILD),$(notdir $(CURDIR)))

export OUTPUT := $(CURDIR)/$(TARGET)
export TOPDIR := $(CURDIR)
export VPATH := $(foreach dir,$(SOURCES),$(CURDIR)/$(dir))
export DEPSDIR := $(CURDIR)/$(BUILD)

CFILES := $(foreach dir,$(SOURCES),$(notdir $(wildcard $(dir)/*.c)))
SFILES := $(foreach dir,$(SOURCES),$(notdir $(wildcard $(dir)/*.s)))

export LD := $(CC)
export OFILES := $(CFILES:.c=.o) $(SFILES:.s=.o)
export INCLUDE := $(foreach dir,$(LIBDIRS),-I$(dir)/include) -I$(CURDIR)/$(BUILD)
export LIBPATHS := $(foreach dir,$(LIBDIRS),-L$(dir)/lib)

.PHONY: all clean

all: $(BUILD)

$(BUILD):
	@[ -d $@ ] || mkdir -p $@
	@build_romfs $(CURDIR)/$(ROMFS) $(CURDIR)/$(BUILD)/pocketjs.romfs >/dev/null
	@$(MAKE) --no-print-directory -C $(BUILD) -f $(CURDIR)/Makefile \
		NROFLAGS="--icon=$(LIBNX)/default_icon.jpg \
		--nacp=$(CURDIR)/$(TARGET).nacp \
		--romfs=$(CURDIR)/$(BUILD)/pocketjs.romfs"

clean:
	@rm -rf $(BUILD) $(TARGET).elf $(TARGET).map $(TARGET).nacp $(TARGET).nro

else

DEPENDS := $(OFILES:.o=.d)

.PHONY: all

all: $(OUTPUT).nro

$(OUTPUT).nro: $(OUTPUT).elf $(OUTPUT).nacp

$(OUTPUT).elf: $(OFILES) $(RUSTLIB)

-include $(DEPENDS)

endif
