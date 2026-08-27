#include <pebble.h>
#include "app.h"
#include "ui.h"

static Window *s_window;
static MenuLayer *s_menu;
static StatusBarLayer *s_status;

static bool is_list_ready(void) {
  return g_state == STATE_MOVIES && g_movie_count > 0;
}

// ---- MenuLayer callbacks ---------------------------------------------------

static uint16_t get_num_sections(struct MenuLayer *menu, void *ctx) {
  return 1;
}

static int16_t get_header_height(struct MenuLayer *menu, uint16_t section, void *ctx) {
  return MENU_CELL_BASIC_HEADER_HEIGHT;
}

static void draw_header(GContext *gctx, const Layer *cell_layer, uint16_t section, void *ctx) {
  const char *name = (g_selected_theater < g_theater_count)
                     ? g_theaters[g_selected_theater].name : "Now Showing";
  menu_cell_basic_header_draw(gctx, cell_layer, name);
}

static uint16_t get_num_rows(MenuLayer *menu, uint16_t section, void *ctx) {
  return is_list_ready() ? g_movie_count : 1;
}

static int16_t get_cell_height(struct MenuLayer *menu, MenuIndex *idx, void *ctx) {
  if (!is_list_ready()) return INFO_CELL_HEIGHT;
#if defined(PBL_ROUND)
  return menu_layer_is_index_selected(menu, idx) ? 66 : 54;
#else
  return 48;
#endif
}

static void draw_row(GContext *gctx, const Layer *cell_layer, MenuIndex *idx, void *ctx) {
  if (!is_list_ready()) {
    const char *msg;
    switch (g_state) {
      case STATE_LOADING_MOVIES:
        msg = g_error_msg[0] ? g_error_msg : "Fetching showtimes…";
        break;
      case STATE_ERROR:
        msg = g_error_msg[0] ? g_error_msg : "Something went wrong.";
        break;
      case STATE_MOVIES:
        msg = "No showtimes listed today.";
        break;
      default:
        msg = "Loading…";
        break;
    }
    ui_draw_info_cell(gctx, cell_layer, msg);
    return;
  }

  Movie *m = &g_movies[idx->row];

  char subtitle[TIMES_LEN + 16];
  if (m->rating[0]) {
    snprintf(subtitle, sizeof(subtitle), "IMDb %s  •  %s", m->rating, m->times);
  } else {
    snprintf(subtitle, sizeof(subtitle), "%s", m->times);
  }

  menu_cell_basic_draw(gctx, cell_layer, m->title, subtitle, NULL);
}

static void select_row(MenuLayer *menu, MenuIndex *idx, void *ctx) {
  if (!is_list_ready()) {
    if (g_state == STATE_ERROR) request_movies(g_selected_theater);
    return;
  }
  showtimes_window_push(idx->row);
}

// ---- Window lifecycle ----------------------------------------------------

static void window_load(Window *window) {
  Layer *root = window_get_root_layer(window);
  GRect bounds = layer_get_bounds(root);

  s_status = status_bar_layer_create();
  status_bar_layer_set_colors(s_status, GColorClear, GColorBlack);

  GRect menu_frame = bounds;
#if !defined(PBL_ROUND)
  menu_frame.origin.y += STATUS_BAR_LAYER_HEIGHT;
  menu_frame.size.h -= STATUS_BAR_LAYER_HEIGHT;
#endif

  s_menu = menu_layer_create(menu_frame);
  menu_layer_set_callbacks(s_menu, NULL, (MenuLayerCallbacks) {
    .get_num_sections = get_num_sections,
    .get_num_rows = get_num_rows,
    .get_header_height = get_header_height,
    .draw_header = draw_header,
    .get_cell_height = get_cell_height,
    .draw_row = draw_row,
    .select_click = select_row,
  });
  menu_layer_set_click_config_onto_window(s_menu, window);
#if defined(PBL_COLOR)
  menu_layer_set_highlight_colors(s_menu, GColorJaegerGreen, GColorWhite);
#endif

  layer_add_child(root, menu_layer_get_layer(s_menu));
  layer_add_child(root, status_bar_layer_get_layer(s_status));
}

static void window_unload(Window *window) {
  menu_layer_destroy(s_menu);
  status_bar_layer_destroy(s_status);
  window_destroy(window);
  s_window = NULL;
  s_menu = NULL;
}

void movies_window_reload(void) {
  if (s_menu) {
    menu_layer_reload_data(s_menu);
  }
}

void movies_window_push(void) {
  if (!s_window) {
    s_window = window_create();
    window_set_window_handlers(s_window, (WindowHandlers) {
      .load = window_load,
      .unload = window_unload,
    });
  }
  window_stack_push(s_window, true);
}
