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

static inline int pocketjsSymbianNormalizeKey(int key)
{
    return POCKETJS_SYMBIAN_NORMALIZED_ASCII_KEY(key);
}

#endif
