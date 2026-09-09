/* Private, line-oriented worker helper. Each bounded transcript is evaluated
 * in a fresh session against a schema with user learning disabled. */
#include <rime_api.h>
#include <stdio.h>
#include <stdlib.h>
#include <string.h>
#define SELECT 0x1000000
/* Rime reports a UTF-8 byte offset; the guest slices UTF-16 strings. */
static int caret_utf16(const char *s, int bytes) {
  int units = 0;
  if (s) for (int i = 0; i < bytes && s[i]; i++) {
    unsigned char c = (unsigned char)s[i];
    if ((c & 0xc0) != 0x80) units += c >= 0xf0 ? 2 : 1;
  }
  return units;
}
static void string(const char *s) {
  putchar('"');
  if (s) for (const unsigned char *p = (const unsigned char *)s; *p; p++) {
    if (*p == '"' || *p == '\\') { putchar('\\'); putchar(*p); }
    else if (*p < 32) printf("\\u%04x", *p);
    else putchar(*p);
  }
  putchar('"');
}
int main(int argc, char **argv) {
  if (argc != 2) return 2;
  RimeApi *api = rime_get_api();
  RIME_STRUCT(RimeTraits, traits);
  traits.shared_data_dir = argv[1]; traits.user_data_dir = argv[1];
  traits.app_name = "rime.pocketjs"; traits.min_log_level = 2;
  api->setup(&traits); api->initialize(&traits);
  char line[2048];
  while (fgets(line, sizeof line, stdin)) {
    RimeSessionId session = api->create_session();
    if (!session || !api->select_schema(session, "pocket_pinyin")) {
      if (session) api->destroy_session(session);
      puts("{\"error\":\"Rime schema unavailable\"}"); fflush(stdout); continue;
    }
    api->set_option(session, "ascii_mode", False);
    char committed[2048] = {0};
    char *p = line;
    unsigned count = 0;
    while (*p && *p != '\n' && count++ < 128) {
      char *end; long key = strtol(p, &end, 10);
      if (end == p) break;
      p = *end == ',' ? end + 1 : end;
      if (key >= SELECT && key < SELECT + 5) api->select_candidate_on_current_page(session, (size_t)(key - SELECT));
      else api->process_key(session, (int)key, 0);
      RIME_STRUCT(RimeCommit, commit);
      if (api->get_commit(session, &commit)) {
        if (commit.text && strlen(committed) + strlen(commit.text) < sizeof committed) strcat(committed, commit.text);
        api->free_commit(&commit);
      }
    }
    RIME_STRUCT(RimeContext, ctx);
    int has = api->get_context(session, &ctx);
    printf("{\"commit\":"); string(committed);
    printf(",\"preedit\":"); string(has ? ctx.composition.preedit : "");
    printf(",\"caret\":%d,\"page\":%d,\"last\":%s,\"candidates\":[",
      has ? caret_utf16(ctx.composition.preedit, ctx.composition.cursor_pos) : 0, has ? ctx.menu.page_no : 0, !has || ctx.menu.is_last_page ? "true" : "false");
    if (has) for (int i = 0; i < ctx.menu.num_candidates && i < 5; i++) {
      if (i) putchar(','); string(ctx.menu.candidates[i].text);
    }
    puts("]}"); fflush(stdout);
    if (has) api->free_context(&ctx);
    api->destroy_session(session);
  }
  api->finalize(); return 0;
}
