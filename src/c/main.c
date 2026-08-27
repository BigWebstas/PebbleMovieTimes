#include <pebble.h>
#include "app.h"

// ---------------------------------------------------------------------------
// Global data store
// ---------------------------------------------------------------------------
Theater g_theaters[MAX_THEATERS];
int     g_theater_count = 0;
int     g_selected_theater = 0;

Movie   g_movies[MAX_MOVIES];
int     g_movie_count = 0;

AppState g_state = STATE_LOADING_THEATERS;
char     g_error_msg[128] = {0};

// ---------------------------------------------------------------------------
// Small parsing helpers
// ---------------------------------------------------------------------------

// Copy up to dst_len-1 bytes of [start, end) into dst, NUL terminating.
static void copy_field(char *dst, size_t dst_len, const char *start, const char *end) {
  size_t n = (size_t)(end - start);
  if (n >= dst_len) n = dst_len - 1;
  memcpy(dst, start, n);
  dst[n] = '\0';
}

// Advance *cursor to the next field within the current record (delimited by
// FLD_SEP) or to record_end. Returns the field bounds via out_start/out_end.
static bool next_field(const char **cursor, const char *record_end,
                       const char **out_start, const char **out_end) {
  if (*cursor >= record_end) return false;
  const char *s = *cursor;
  const char *p = s;
  while (p < record_end && *p != FLD_SEP) p++;
  *out_start = s;
  *out_end = p;
  *cursor = (p < record_end) ? p + 1 : record_end;
  return true;
}

// ---------------------------------------------------------------------------
// AppMessage: inbound
// ---------------------------------------------------------------------------

static void parse_theaters(const char *payload) {
  g_theater_count = 0;
  const char *p = payload;
  const char *end = payload + strlen(payload);

  while (p < end && g_theater_count < MAX_THEATERS) {
    const char *rec_end = p;
    while (rec_end < end && *rec_end != REC_SEP) rec_end++;

    if (rec_end > p) {
      Theater *t = &g_theaters[g_theater_count];
      t->name[0] = t->rating[0] = t->distance[0] = '\0';

      const char *cur = p;
      const char *fs, *fe;
      if (next_field(&cur, rec_end, &fs, &fe)) copy_field(t->name, NAME_LEN, fs, fe);
      if (next_field(&cur, rec_end, &fs, &fe)) copy_field(t->rating, RATING_LEN, fs, fe);
      if (next_field(&cur, rec_end, &fs, &fe)) copy_field(t->distance, DIST_LEN, fs, fe);

      if (t->name[0]) g_theater_count++;
    }
    p = (rec_end < end) ? rec_end + 1 : end;
  }
}

static void parse_movies(const char *payload) {
  g_movie_count = 0;
  const char *p = payload;
  const char *end = payload + strlen(payload);

  while (p < end && g_movie_count < MAX_MOVIES) {
    const char *rec_end = p;
    while (rec_end < end && *rec_end != REC_SEP) rec_end++;

    if (rec_end > p) {
      Movie *m = &g_movies[g_movie_count];
      m->title[0] = m->rating[0] = m->times[0] = '\0';

      const char *cur = p;
      const char *fs, *fe;
      if (next_field(&cur, rec_end, &fs, &fe)) copy_field(m->title, NAME_LEN, fs, fe);
      if (next_field(&cur, rec_end, &fs, &fe)) copy_field(m->rating, RATING_LEN, fs, fe);
      if (next_field(&cur, rec_end, &fs, &fe)) copy_field(m->times, TIMES_LEN, fs, fe);

      if (m->title[0]) g_movie_count++;
    }
    p = (rec_end < end) ? rec_end + 1 : end;
  }
}

static void inbox_received(DictionaryIterator *iter, void *context) {
  Tuple *err = dict_find(iter, MESSAGE_KEY_ERROR);
  if (err && err->type == TUPLE_CSTRING && err->length > 1) {
    g_state = STATE_ERROR;
    strncpy(g_error_msg, err->value->cstring, sizeof(g_error_msg) - 1);
    g_error_msg[sizeof(g_error_msg) - 1] = '\0';
    theaters_window_reload();
    movies_window_reload();
    return;
  }

  Tuple *status = dict_find(iter, MESSAGE_KEY_STATUS);
  if (status && status->type == TUPLE_CSTRING) {
    // Optional progress text ("Locating…", "Fetching showtimes…")
    strncpy(g_error_msg, status->value->cstring, sizeof(g_error_msg) - 1);
    g_error_msg[sizeof(g_error_msg) - 1] = '\0';
    theaters_window_reload();
    movies_window_reload();
  }

  Tuple *theaters = dict_find(iter, MESSAGE_KEY_THEATERS);
  if (theaters && theaters->type == TUPLE_CSTRING) {
    parse_theaters(theaters->value->cstring);
    g_state = STATE_THEATERS;
    g_error_msg[0] = '\0';
    theaters_window_reload();
  }

  Tuple *movies = dict_find(iter, MESSAGE_KEY_MOVIES);
  if (movies && movies->type == TUPLE_CSTRING) {
    parse_movies(movies->value->cstring);
    g_state = STATE_MOVIES;
    g_error_msg[0] = '\0';
    movies_window_reload();
  }
}

static void inbox_dropped(AppMessageResult reason, void *context) {
  APP_LOG(APP_LOG_LEVEL_WARNING, "inbox dropped: %d", (int)reason);
  g_state = STATE_ERROR;
  snprintf(g_error_msg, sizeof(g_error_msg), "Message dropped.\nTry again.");
  theaters_window_reload();
  movies_window_reload();
}

static void outbox_failed(DictionaryIterator *iter, AppMessageResult reason, void *context) {
  APP_LOG(APP_LOG_LEVEL_WARNING, "outbox failed: %d", (int)reason);
}

// ---------------------------------------------------------------------------
// Actions
// ---------------------------------------------------------------------------

void request_theaters(void) {
  g_state = STATE_LOADING_THEATERS;
  g_error_msg[0] = '\0';
  theaters_window_reload();

  DictionaryIterator *out;
  if (app_message_outbox_begin(&out) != APP_MSG_OK) return;
  dict_write_cstring(out, MESSAGE_KEY_REQUEST, "theaters");
  app_message_outbox_send();
}

void request_movies(int theater_idx) {
  g_selected_theater = theater_idx;
  g_state = STATE_LOADING_MOVIES;
  g_error_msg[0] = '\0';
  g_movie_count = 0;
  movies_window_reload();

  DictionaryIterator *out;
  if (app_message_outbox_begin(&out) != APP_MSG_OK) return;
  dict_write_cstring(out, MESSAGE_KEY_REQUEST, "movies");
  dict_write_int32(out, MESSAGE_KEY_THEATER_IDX, theater_idx);
  app_message_outbox_send();
}

// ---------------------------------------------------------------------------
// Lifecycle
// ---------------------------------------------------------------------------

static void init(void) {
  app_message_register_inbox_received(inbox_received);
  app_message_register_inbox_dropped(inbox_dropped);
  app_message_register_outbox_failed(outbox_failed);
  // Generous inbox: a full theater / movie list arrives as one string.
  app_message_open(4096, 256);

  theaters_window_push();
  request_theaters();
}

static void deinit(void) {
  // Windows own their teardown via .unload handlers.
}

int main(void) {
  init();
  app_event_loop();
  deinit();
}
