#pragma once
#include <pebble.h>

// Height reserved for a single wrapped info / error row in a menu.
#define INFO_CELL_HEIGHT 150

// Draw a word-wrapped informational paragraph inside a menu cell, picking a
// text color that contrasts with the (possibly highlighted) background.
void ui_draw_info_cell(GContext *ctx, const Layer *cell_layer, const char *text);
