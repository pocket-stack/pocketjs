#ifndef POCKETJS_SYMBIAN_KEYS_H
#define POCKETJS_SYMBIAN_KEYS_H

/*
 * Qt 4.7's Symbian backend forwards ordinary character keysyms directly.
 * The E7 therefore reports an unshifted physical W as 'w', while Qt::Key_W
 * is the uppercase ASCII value. Keep semantic game controls independent of
 * Shift and Caps Lock without changing punctuation or platform control keys.
 */
#define POCKETJS_SYMBIAN_NORMALIZED_ASCII_KEY(key) \
    (((key) >= 'a' && (key) <= 'z') ? ((key) - ('a' - 'A')) : (key))

/*
 * Symbian exposes physical A-Z keys as their uppercase ASCII scan codes.
 * Prefer that stable identity for controller input: the FEP may translate the
 * logical key into the number or symbol printed above an E7 keyboard key.
 * Synthetic/non-Symbian events have no usable letter scan code and retain the
 * normalized logical-key fallback.
 */
#define POCKETJS_SYMBIAN_IS_PHYSICAL_LETTER_SCAN_CODE(key) \
    ((key) >= 'A' && (key) <= 'Z')

#define POCKETJS_SYMBIAN_CONTROL_KEY(key, nativeScanCode) \
    (POCKETJS_SYMBIAN_IS_PHYSICAL_LETTER_SCAN_CODE(nativeScanCode) \
        ? (nativeScanCode) \
        : POCKETJS_SYMBIAN_NORMALIZED_ASCII_KEY(key))

static inline int pocketjsSymbianNormalizeKey(int key)
{
    return POCKETJS_SYMBIAN_NORMALIZED_ASCII_KEY(key);
}

static inline int pocketjsSymbianControlKey(
    int key,
    unsigned int nativeScanCode
)
{
    return POCKETJS_SYMBIAN_CONTROL_KEY(key, nativeScanCode);
}

#endif
