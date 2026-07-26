#include "../../hosts/symbian/runtime/pocketjs_symbian_keys.h"

#if POCKETJS_SYMBIAN_NORMALIZED_ASCII_KEY('w') != 'W'
#error unshifted W must normalize to Qt::Key_W
#endif

#if POCKETJS_SYMBIAN_NORMALIZED_ASCII_KEY('r') != 'R'
#error unshifted R must normalize to Qt::Key_R
#endif

#if POCKETJS_SYMBIAN_NORMALIZED_ASCII_KEY('A') != 'A'
#error uppercase letters must remain unchanged
#endif

#if POCKETJS_SYMBIAN_NORMALIZED_ASCII_KEY(0x01000013) != 0x01000013
#error Qt special keys must remain unchanged
#endif

#if POCKETJS_SYMBIAN_CONTROL_KEY('1', 'W') != 'W'
#error physical W must win over its translated secondary glyph
#endif

#if POCKETJS_SYMBIAN_CONTROL_KEY('d', 'D') != 'D'
#error physical D must remain a controller letter
#endif

#if POCKETJS_SYMBIAN_CONTROL_KEY('r', 0) != 'R'
#error events without a scan code must retain the logical fallback
#endif

#if POCKETJS_SYMBIAN_CONTROL_KEY(0x01000013, 0x0000000e) != 0x01000013
#error non-letter scan codes must not replace Qt special keys
#endif

#if POCKETJS_SYMBIAN_CONTROL_KEY(0x01000013, 0x61) != 0x01000013
#error Symbian F2 scan code must not be mistaken for lowercase A
#endif

#if POCKETJS_SYMBIAN_CONTROL_KEY(0x01000013, 0x79) != 0x01000013
#error Symbian comma scan code must not be mistaken for lowercase Y
#endif

int main(void)
{
    return pocketjsSymbianControlKey('4', 'R') == 'R' ? 0 : 1;
}
