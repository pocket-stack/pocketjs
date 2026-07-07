// aot/runtime/shared/actor.c — per-frame NPC updates.
//
// v1 ships MOVE_STATIC actors (the world's NPCs stand still and are turned
// only by scripts via FACE_PLAYER). Wander/patrol movement kinds are reserved
// and currently treated as static so collision/interaction stay deterministic.
#include "runtime.h"

void actors_update(void) {
  for (int i = 0; i < g.n_actors && i < BUDGET_MAX_ACTORS_PER_MAP; i++) {
    // MOVE_STATIC: nothing to do. (Other move kinds reserved for v2.)
    (void)i;
  }
}
