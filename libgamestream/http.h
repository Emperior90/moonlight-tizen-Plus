/*
 * This file is part of Moonlight Embedded.
 *
 * Copyright (C) 2015 Iwan Timmer
 *
 * Moonlight is free software; you can redistribute it and/or modify
 * it under the terms of the GNU General Public License as published by
 * the Free Software Foundation; either version 3 of the License, or
 * (at your option) any later version.
 *
 * Moonlight is distributed in the hope that it will be useful,
 * but WITHOUT ANY WARRANTY; without even the implied warranty of
 * MERCHANTABILITY or FITNESS FOR A PARTICULAR PURPOSE.  See the
 * GNU General Public License for more details.
 *
 * You should have received a copy of the GNU General Public License
 * along with Moonlight; if not, see <http://www.gnu.org/licenses/>.
 */

#pragma once

#include <stdlib.h>

#ifdef __cplusplus
extern "C" {
#endif

// The largest answer of a host that http_request() accepts: 4 MiB for the XML answers (the app list of a large Playnite
// or Steam library is a few hundred KiB) and 16 MiB for box art. A larger answer fails with GS_RESPONSE_TOO_LARGE
// instead of growing the heap of the WebAssembly module without a limit. The idea comes from the fork of mmadej20
// (moonlight-tizen-modern, http_buffer.h), with more generous limits.
#define HTTP_MAX_RESPONSE_SIZE ((size_t)4 * 1024 * 1024)
#define HTTP_MAX_BOX_ART_RESPONSE_SIZE ((size_t)16 * 1024 * 1024)

typedef struct _HTTP_DATA {
  char *memory;
  size_t size;
  // The limit of the answer, HTTP_MAX_RESPONSE_SIZE unless the caller sets another one
  size_t maxSize;
  // Set when the answer went over maxSize
  int tooLarge;
} HTTP_DATA, *PHTTP_DATA;

PHTTP_DATA http_create_data();
int http_request(const char* url, const char* ppkstr, PHTTP_DATA data);
void http_free_data(PHTTP_DATA data);

#ifdef __cplusplus
}
#endif
