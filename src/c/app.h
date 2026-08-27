#pragma once
#include <pebble.h>

// Wire format delimiters (must match src/pkjs/index.js)
#define REC_SEP  '\x1e'   // between records
#define FLD_SEP  '\x1f'   // between fields in a record

#define MAX_THEATERS   16
#define MAX_MOVIES     24
#define NAME_LEN       52
#define RATING_LEN     8
#define DIST_LEN       12
#define TIMES_LEN      180

typedef struct {
  char name[NAME_LEN];
  char rating[RATING_LEN];   // Google star rating, e.g. "4.3" (may be empty)
  char distance[DIST_LEN];   // e.g. "1.2 mi" (may be empty)
} Theater;

typedef struct {
  char title[NAME_LEN];
  char rating[RATING_LEN];   // IMDb rating, e.g. "7.8" (may be empty)
  char times[TIMES_LEN];     // pre-formatted, comma separated, e.g. "6:00pm, IMAX 9:15pm"
} Movie;

typedef enum {
  STATE_LOADING_THEATERS,
  STATE_THEATERS,
  STATE_LOADING_MOVIES,
  STATE_MOVIES,
  STATE_ERROR,
} AppState;

// --- global data store (defined in main.c) ---
extern Theater g_theaters[MAX_THEATERS];
extern int     g_theater_count;
extern int     g_selected_theater;

extern Movie   g_movies[MAX_MOVIES];
extern int     g_movie_count;

extern AppState g_state;
extern char     g_error_msg[128];

// --- actions (main.c) ---
void request_theaters(void);
void request_movies(int theater_idx);

// --- windows ---
void theaters_window_push(void);
void theaters_window_reload(void);   // refresh menu + title for current g_state

void movies_window_push(void);
void movies_window_reload(void);

void showtimes_window_push(int movie_idx);
