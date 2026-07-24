TEMPLATE = app
TARGET = PocketJsE7Runtime
QT += core gui
CONFIG += release
CONFIG -= debug app_bundle

SOURCES += main.cpp
HEADERS += pocketjs_symbian_core.h
RESOURCES += pocketjs-runtime.qrc

isEmpty(POCKETJS_QUICKJS_INCLUDE): error(POCKETJS_QUICKJS_INCLUDE is required)
isEmpty(POCKETJS_QUICKJS_LIBRARY): error(POCKETJS_QUICKJS_LIBRARY is required)
isEmpty(POCKETJS_CORE_LIBRARY): error(POCKETJS_CORE_LIBRARY is required)
isEmpty(POCKETJS_FRAME_RATE): POCKETJS_FRAME_RATE = 30
isEmpty(POCKETJS_INITIAL_LOGICAL_WIDTH): error(POCKETJS_INITIAL_LOGICAL_WIDTH is required)
isEmpty(POCKETJS_INITIAL_LOGICAL_HEIGHT): error(POCKETJS_INITIAL_LOGICAL_HEIGHT is required)

INCLUDEPATH += $$POCKETJS_QUICKJS_INCLUDE
DEFINES += __STDC_LIMIT_MACROS
DEFINES += POCKETJS_FRAME_RATE=$$POCKETJS_FRAME_RATE
DEFINES += POCKETJS_INITIAL_LOGICAL_WIDTH=$$POCKETJS_INITIAL_LOGICAL_WIDTH
DEFINES += POCKETJS_INITIAL_LOGICAL_HEIGHT=$$POCKETJS_INITIAL_LOGICAL_HEIGHT

# QuickJS is an ordinary archive and resolves symbols referenced by main.o.
LIBS += $$POCKETJS_QUICKJS_LIBRARY
PRE_TARGETDEPS += $$POCKETJS_QUICKJS_LIBRARY

# The no_std Rust archive contains internal registration objects that are not
# all reached through a single object-file symbol. Keep the tested E32 link
# shape: force one public root and retain the complete archive.
QMAKE_LFLAGS += -u ui_init
QMAKE_LFLAGS += --whole-archive
QMAKE_LFLAGS += $$POCKETJS_CORE_LIBRARY
QMAKE_LFLAGS += --no-whole-archive
PRE_TARGETDEPS += $$POCKETJS_CORE_LIBRARY

symbian {
    isEmpty(POCKETJS_SYMBIAN_UID): error(POCKETJS_SYMBIAN_UID is required)
    QMAKE_LINK = /toolchain/current/bin/symbian-gcce-link
    TARGET.UID3 = $$POCKETJS_SYMBIAN_UID
    TARGET.CAPABILITY = None
    TARGET.EPOCSTACKSIZE = 0x100000
    TARGET.EPOCHEAPSIZE = 0x400000 0x2000000

    QMAKE_ELF2E32_FLAGS -= --compressionmethod bytepair
    QMAKE_ELF2E32_FLAGS += --compressionmethod inflate
}
