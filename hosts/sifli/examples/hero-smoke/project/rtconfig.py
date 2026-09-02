
# SiFli's bundled QuickJS predates GCC 14's incompatible-pointer-types error.
# Keep SDK warnings visible without promoting that upstream warning to a hard
# failure; PocketJS sources are compiled with -Werror separately.
WERROR = False
