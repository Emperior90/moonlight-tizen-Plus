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

#define GS_OK 0
#define GS_FAILED -1
#define GS_OUT_OF_MEMORY -2
#define GS_INVALID -3
#define GS_WRONG_STATE -4
#define GS_IO_ERROR -5
#define GS_NOT_SUPPORTED_4K -6
// The host answered the pairing request with a hash that doesn't match the PIN, i.e. the PIN entered on the host was
// wrong (or the host doesn't know the PIN at all)
#define GS_PIN_WRONG -7
// The answer of the host was larger than the limit of http.c
#define GS_RESPONSE_TOO_LARGE -8

#define GS_CERT_MISMATCH -100
