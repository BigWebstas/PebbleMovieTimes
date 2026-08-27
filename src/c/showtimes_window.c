#include <pebble.h>
#include "app.h"

static Window *s_window;
static ScrollLayer *s_scroll;
static TextLayer *s_title_layer;
static TextLayer *s_body_layer;
static StatusBarLayer *s_status;

static char s_title_buf[NAME_LEN + RATING_LEN + 12];
static char s_body_buf[TIMES_LEN + 8];

static void build_text(int movie_idx) {
  if (movie_idx < 0 || movie_idx >= g_movie_count) {
    s_title_buf[0] = '\0';
    s_body_buf[0] = '\0';
    return;
  }
  Movie *m = &g_movies[movie_idx];

  if (m->rating[0]) {
    snprintf(s_title_buf, sizeof(s_title_buf), "%s\nIMDb %s", m->title, m->rating);
  } else {
    snprintf(s_title_buf, sizeof(s_title_buf), "%s", m->title);
  }

  // One showtime per line for glanceability.
  size_t j = 0;
  for (size_t i = 0; m->times[i] && j < sizeof(s_body_buf) - 1; i++) {
    if (m->times[i] == ',' ) {
      s_body_buf[j++] = '\n';
      if (m->times[i + 1] == ' ') i++;  // swallow the following space
    } else {
      s_body_buf[j++] = m->times[i];
    }
  }
  s_body_buf[j] = '\0';
  if (s_body_buf[0] == '\0') {
    snprintf(s_body_buf, sizeof(s_body_buf), "No times listed.");
  }
}

static void window_load(Window *window) {
  Layer *root = window_get_root_layer(window);
  GRect bounds = layer_get_bounds(root);

  s_status = status_bar_layer_create();
  status_bar_layer_set_colors(s_status, GColorClear, GColorBlack);

  GRect content = bounds;
#if !defined(PBL_ROUND)
  content.origin.y += STATUS_BAR_LAYER_HEIGHT;
  content.size.h -= STATUS_BAR_LAYER_HEIGHT;
#endif

  s_scroll = scroll_layer_create(content);
  scroll_layer_set_click_config_onto_window(s_scroll, window);
#if defined(PBL_COLOR)
  scroll_layer_set_shadow_hidden(s_scroll, false);
#endif

  const int16_t w = content.size.w;
  const int16_t pad = PBL_IF_ROUND_ELSE(18, 6);

  s_title_layer = text_layer_create(GRect(pad, 2, w - 2 * pad, 60));
  text_layer_set_font(s_title_layer, fonts_get_system_font(FONT_KEY_GOTHIC_24_BOLD));
  text_layer_set_text_alignment(s_title_layer, PBL_IF_ROUND_ELSE(GTextAlignmentCenter, GTextAlignmentLeft));
  text_layer_set_overflow_mode(s_title_layer, GTextOverflowModeWordWrap);
  text_layer_set_text(s_title_layer, s_title_buf);
  GSize title_size = text_layer_get_content_size(s_title_layer);
  text_layer_set_size(s_title_layer, GSize(w - 2 * pad, title_size.h + 4));

  const int16_t body_y = title_size.h + 10;
  s_body_layer = text_layer_create(GRect(pad, body_y, w - 2 * pad, 2000));
  text_layer_set_font(s_body_layer, fonts_get_system_font(FONT_KEY_GOTHIC_24));
  text_layer_set_text_alignment(s_body_layer, PBL_IF_ROUND_ELSE(GTextAlignmentCenter, GTextAlignmentLeft));
  text_layer_set_overflow_mode(s_body_layer, GTextOverflowModeWordWrap);
  text_layer_set_text(s_body_layer, s_body_buf);
  GSize body_size = text_layer_get_content_size(s_body_layer);
  text_layer_set_size(s_body_layer, GSize(w - 2 * pad, body_size.h + 4));

  scroll_layer_add_child(s_scroll, text_layer_get_layer(s_title_layer));
  scroll_layer_add_child(s_scroll, text_layer_get_layer(s_body_layer));
  scroll_layer_set_content_size(s_scroll, GSize(w, body_y + body_size.h + 16));

  layer_add_child(root, scroll_layer_get_layer(s_scroll));
  layer_add_child(root, status_bar_layer_get_layer(s_status));
}

static void window_unload(Window *window) {
  text_layer_destroy(s_title_layer);
  text_layer_destroy(s_body_layer);
  scroll_layer_destroy(s_scroll);
  status_bar_layer_destroy(s_status);
  window_destroy(s_window);
  s_window = NULL;
}

void showtimes_window_push(int movie_idx) {
  build_text(movie_idx);
  s_window = window_create();
  window_set_window_handlers(s_window, (WindowHandlers) {
    .load = window_load,
    .unload = window_unload,
  });
  window_stack_push(s_window, true);
}
