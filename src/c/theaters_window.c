#include <pebble.h>
#include "app.h"
#include "ui.h"

static Window *s_window;
static MenuLayer *s_menu;
static StatusBarLayer *s_status;

static bool is_list_ready(void) {
  return g_state == STATE_THEATERS && g_theater_count > 0;
}

// ---- MenuLayer callbacks ---------------------------------------------------

static uint16_t get_num_rows(MenuLayer *menu, uint16_t section, void *ctx) {
  return is_list_ready() ? g_theater_count : 1;
}

static int16_t get_cell_height(struct MenuLayer *menu, MenuIndex *idx, void *ctx) {
  if (!is_list_ready()) return INFO_CELL_HEIGHT;
#if defined(PBL_ROUND)
  return menu_layer_is_index_selected(menu, idx) ? 60 : 50;
#else
  return 44;
#endif
}

static void draw_row(GContext *gctx, const Layer *cell_layer, MenuIndex *idx, void *ctx) {
  if (!is_list_ready()) {
    const char *msg;
    switch (g_state) {
      case STATE_LOADING_THEATERS:
        msg = g_error_msg[0] ? g_error_msg : "Finding theaters near you…";
        break;
      case STATE_ERROR:
        msg = g_error_msg[0] ? g_error_msg : "Something went wrong.";
        break;
      case STATE_THEATERS:
        msg = "No theaters found nearby.";
        break;
      default:
        msg = "Loading…";
        break;
    }
    ui_draw_info_cell(gctx, cell_layer, msg);
    return;
  }

  Theater *t = &g_theaters[idx->row];

  char subtitle[40];
  if (t->rating[0] && t->distance[0]) {
    snprintf(subtitle, sizeof(subtitle), "★ %s  •  %s", t->rating, t->distance);
  } else if (t->rating[0]) {
    snprintf(subtitle, sizeof(subtitle), "★ %s", t->rating);
  } else if (t->distance[0]) {
    snprintf(subtitle, sizeof(subtitle), "%s", t->distance);
  } else {
    subtitle[0] = '\0';
  }

  menu_cell_basic_draw(gctx, cell_layer, t->name, subtitle[0] ? subtitle : NULL, NULL);
}

static void select_row(MenuLayer *menu, MenuIndex *idx, void *ctx) {
  if (!is_list_ready()) {
    if (g_state == STATE_ERROR) request_theaters();
    return;
  }
  request_movies(idx->row);
  movies_window_push();
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
    .get_num_rows = get_num_rows,
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
  s_window = NULL;
  s_menu = NULL;
}

void theaters_window_reload(void) {
  if (s_menu) {
    menu_layer_reload_data(s_menu);
  }
}

void theaters_window_push(void) {
  if (!s_window) {
    s_window = window_create();
    window_set_window_handlers(s_window, (WindowHandlers) {
      .load = window_load,
      .unload = window_unload,
    });
  }
  window_stack_push(s_window, true);
}
