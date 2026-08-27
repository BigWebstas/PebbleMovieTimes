#include <pebble.h>
#include "app.h"

// Favorite theaters are persisted as a single REC_SEP-delimited list of
// theater names. Matching is by exact name (the identifier the JS side gives us).

#define PERSIST_KEY_FAVORITES 1
#define FAV_BUF_BYTES 512

static char s_favs[FAV_BUF_BYTES];  // e.g. "AMC Empire 25\x1eRegal Union Square"

void favorites_load(void) {
  s_favs[0] = '\0';
  if (persist_exists(PERSIST_KEY_FAVORITES)) {
    persist_read_string(PERSIST_KEY_FAVORITES, s_favs, sizeof(s_favs));
  }
}

static void favorites_save(void) {
  persist_write_string(PERSIST_KEY_FAVORITES, s_favs);
}

// Is `name` present as a whole record inside s_favs?
bool favorites_is_pinned(const char *name) {
  size_t name_len = strlen(name);
  if (name_len == 0) return false;

  const char *p = s_favs;
  while (*p) {
    const char *rec_end = p;
    while (*rec_end && *rec_end != REC_SEP) rec_end++;
    if ((size_t)(rec_end - p) == name_len && strncmp(p, name, name_len) == 0) {
      return true;
    }
    p = (*rec_end == REC_SEP) ? rec_end + 1 : rec_end;
  }
  return false;
}

static void favorites_remove(const char *name) {
  size_t name_len = strlen(name);
  char out[FAV_BUF_BYTES];
  size_t oi = 0;

  const char *p = s_favs;
  while (*p) {
    const char *rec_end = p;
    while (*rec_end && *rec_end != REC_SEP) rec_end++;
    size_t rec_len = (size_t)(rec_end - p);

    bool match = (rec_len == name_len) && (strncmp(p, name, name_len) == 0);
    if (!match && rec_len > 0) {
      if (oi > 0 && oi < sizeof(out) - 1) out[oi++] = REC_SEP;
      size_t copy = rec_len;
      if (oi + copy >= sizeof(out)) copy = sizeof(out) - 1 - oi;
      memcpy(out + oi, p, copy);
      oi += copy;
    }
    p = (*rec_end == REC_SEP) ? rec_end + 1 : rec_end;
  }
  out[oi] = '\0';
  strncpy(s_favs, out, sizeof(s_favs));
  s_favs[sizeof(s_favs) - 1] = '\0';
}

static void favorites_add(const char *name) {
  if (favorites_is_pinned(name)) return;
  size_t cur = strlen(s_favs);
  size_t need = strlen(name) + (cur ? 1 : 0);
  if (cur + need >= sizeof(s_favs) - 1) return;  // out of room, keep existing

  if (cur) s_favs[cur++] = REC_SEP;
  strcpy(s_favs + cur, name);
}

void favorites_apply(void) {
  // 1. flag
  for (int i = 0; i < g_theater_count; i++) {
    g_theaters[i].favorite = favorites_is_pinned(g_theaters[i].name);
  }
  // 2. stable partition: pinned first, original order preserved within groups
  Theater sorted[MAX_THEATERS];
  int n = 0;
  for (int i = 0; i < g_theater_count; i++) {
    if (g_theaters[i].favorite) sorted[n++] = g_theaters[i];
  }
  for (int i = 0; i < g_theater_count; i++) {
    if (!g_theaters[i].favorite) sorted[n++] = g_theaters[i];
  }
  memcpy(g_theaters, sorted, sizeof(Theater) * n);
}

void favorites_toggle(int theater_idx) {
  if (theater_idx < 0 || theater_idx >= g_theater_count) return;
  const char *name = g_theaters[theater_idx].name;

  if (favorites_is_pinned(name)) {
    favorites_remove(name);
  } else {
    favorites_add(name);
  }
  favorites_save();
  favorites_apply();
}
