/*
 * hero-smoke: the repository's hero demo on a SiFli SF32LB58 board through
 * hosts/sifli. Everything below main() is the reusable host; this file only
 * hands over the generated catalog.
 *
 *   bun tools/sifli.ts assets hosts/sifli/examples/hero-smoke
 *   cd hosts/sifli/examples/hero-smoke/project
 *   source $SIFLI_SDK/export.sh && scons --board=sf32lb58-lcd_n16r32n1_a1_dpi -j8
 */
#include "pocketjs_host.h"

extern const PocketjsCatalog pocketjs_catalog;

int main(void)
{
    return pocketjs_host_run(&pocketjs_catalog);
}
