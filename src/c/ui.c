#include <pebble.h>
#include "ui.h"

void ui_draw_info_cell(GContext *ctx, const Layer *cell_layer, const char *text) {
  bool highlighted = menu_cell_layer_is_highlighted(cell_layer);
  graphics_context_set_text_color(ctx, highlighted ? GColorWhite : GColorBlack);

  GRect bounds = layer_get_bounds(cell_layer);
  GRect box = grect_inset(bounds, GEdgeInsets(6, 8));

  graphics_draw_text(ctx, text,
                     fonts_get_system_font(FONT_KEY_GOTHIC_18),
                     box, GTextOverflowModeWordWrap,
                     PBL_IF_ROUND_ELSE(GTextAlignmentCenter, GTextAlignmentLeft),
                     NULL);
}
