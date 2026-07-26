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

int main(void)
{
    return pocketjsSymbianNormalizeKey('d') == 'D' ? 0 : 1;
}
