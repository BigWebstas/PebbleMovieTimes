#include <pebble.h>
#include "app.h"
#include "ui.h"

static Window *s_window;
static MenuLayer *s_menu;
static StatusBarLayer *s_status;

// The theater list stays usable even while a movie fetch is in progress (or
// errored) on top of it — otherwise navigating back lands on a blank loader.
static bool is_list_ready(void) {
  return g_theater_count > 0 && g_state != STATE_LOADING_THEATERS;
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
  bool selected = menu_cell_layer_is_highlighted(cell_layer);

  // Tint pinned rows. When the row is selected the MenuLayer has already
  // painted its highlight colour, so only override for unselected favorites.
  if (t->favorite && !selected) {
#if defined(PBL_COLOR)
    graphics_context_set_fill_color(gctx, GColorMelon);
    graphics_fill_rect(gctx, layer_get_bounds(cell_layer), 0, GCornerNone);
    graphics_context_set_text_color(gctx, GColorBlack);
#endif
  }

  char title[NAME_LEN + 4];
  if (t->favorite) {
    snprintf(title, sizeof(title), "★ %s", t->name);   // ★ pinned
  } else {
    snprintf(title, sizeof(title), "%s", t->name);
  }

  char subtitle[40];
  if (t->rating[0] && t->distance[0]) {
    snprintf(subtitle, sizeof(subtitle), "%s★  •  %s", t->rating, t->distance);
  } else if (t->rating[0]) {
    snprintf(subtitle, sizeof(subtitle), "Rated %s", t->rating);
  } else if (t->distance[0]) {
    snprintf(subtitle, sizeof(subtitle), "%s", t->distance);
  } else {
    subtitle[0] = '\0';
  }

  menu_cell_basic_draw(gctx, cell_layer, title, subtitle[0] ? subtitle : NULL, NULL);
}

static void select_row(MenuLayer *menu, MenuIndex *idx, void *ctx) {
  if (!is_list_ready()) {
    if (g_state == STATE_ERROR) request_theaters();
    return;
  }
  request_movies(idx->row);
  movies_window_push();
}

// Long-press toggles a theater as a favorite (pinned to the top, persisted).
static void long_select_row(MenuLayer *menu, MenuIndex *idx, void *ctx) {
  if (!is_list_ready()) return;

  char name[NAME_LEN];
  strncpy(name, g_theaters[idx->row].name, sizeof(name));
  name[NAME_LEN - 1] = '\0';

  favorites_toggle(idx->row);
  vibes_short_pulse();
  menu_layer_reload_data(menu);

  // Keep the cursor on the same theater after it is re-sorted.
  for (int i = 0; i < g_theater_count; i++) {
    if (strcmp(g_theaters[i].name, name) == 0) {
      menu_layer_set_selected_index(menu, MenuIndex(0, i), MenuRowAlignCenter, false);
      break;
    }
  }
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
    .select_long_click = long_select_row,
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
