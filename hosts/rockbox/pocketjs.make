POCKETJS_SRCDIR := $(APPSDIR)/plugins/pocketjs
POCKETJS_BUILDDIR := $(BUILDDIR)/apps/plugins/pocketjs

POCKETJS_SRC := \
  $(POCKETJS_SRCDIR)/main.c \
  $(POCKETJS_SRCDIR)/input.c \
  $(POCKETJS_SRCDIR)/compat.c \
  $(POCKETJS_SRCDIR)/runtime_port.c \
  $(POCKETJS_SRCDIR)/app_data.c \
  $(POCKETJS_SRCDIR)/qjs_quickjs.c \
  $(POCKETJS_SRCDIR)/qjs_cutils.c \
  $(POCKETJS_SRCDIR)/qjs_libregexp.c \
  $(POCKETJS_SRCDIR)/qjs_libunicode.c \
  $(POCKETJS_SRCDIR)/qjs_dtoa.c
POCKETJS_OBJ := $(call c2obj,$(POCKETJS_SRC))
POCKETJS_CORE := $(POCKETJS_SRCDIR)/libpocketjs_rockbox_core.a

OTHER_SRC += $(POCKETJS_SRC)
ROCKS += $(POCKETJS_BUILDDIR)/pocketjs.rock

$(POCKETJS_OBJ): $(BUILDDIR)/sysfont.h
$(POCKETJS_BUILDDIR)/pocketjs.rock: $(POCKETJS_OBJ) $(POCKETJS_CORE) $(TLSFLIB)
$(POCKETJS_BUILDDIR)/pocketjs.rock: PLUGINFLAGS += \
  -I$(POCKETJS_SRCDIR) \
  -Wno-sign-compare -Wno-unused-parameter
$(POCKETJS_BUILDDIR)/pocketjs.rock: PLUGINLDFLAGS += -lm
