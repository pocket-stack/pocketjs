/*
 * mgba_runner.c — headless GBA emulator test runner for PocketJS-AOT.
 *
 * Links against libmgba 0.10.5 (Homebrew). Runs a ROM under a scripted
 * "scenario" of input/advance/read/screenshot steps and prints a JSON
 * result to stdout.
 *
 *   Usage: mgba_runner <rom.gba> <scenario.json>
 *
 * Scenario shape (see README of the harness):
 *   { "steps": [
 *       { "op": "advance", "frames": 30 },
 *       { "op": "press", "buttons": ["UP"], "frames": 16 },
 *       { "op": "press", "buttons": ["A"], "frames": 1, "release": 30 },
 *       { "op": "read", "name": "player_x", "addr": 33554432, "size": 2 },
 *       { "op": "screenshot", "path": "/abs/out.ppm" }
 *   ] }
 *
 * Output on success:  {"reads": {"player_x": 8, ...}, "ok": true}
 * Output on failure:  {"ok": false, "error": "..."}  (exit code 1)
 *
 * Dependency-free apart from libc + libmgba.
 */

#include <mgba/core/core.h>
#include <mgba/gba/core.h>
#include <mgba/core/interface.h>
#include <mgba-util/vfs.h>

#include <fcntl.h>
#include <stdarg.h>
#include <stdbool.h>
#include <stdint.h>
#include <stdio.h>
#include <stdlib.h>
#include <string.h>

/* ------------------------------------------------------------------ *
 * GBA key bit indices (from <mgba/internal/gba/input.h>, enum GBAKey).
 * The core's setKeys() takes a bitmask of (1 << index).
 * ------------------------------------------------------------------ */
#define GBA_KEY_A_BIT      0
#define GBA_KEY_B_BIT      1
#define GBA_KEY_SELECT_BIT 2
#define GBA_KEY_START_BIT  3
#define GBA_KEY_RIGHT_BIT  4
#define GBA_KEY_LEFT_BIT   5
#define GBA_KEY_UP_BIT     6
#define GBA_KEY_DOWN_BIT   7
#define GBA_KEY_R_BIT      8
#define GBA_KEY_L_BIT      9

/* ------------------------------------------------------------------ *
 * Error reporting: emit the failure JSON and bail out.
 * ------------------------------------------------------------------ */
static void die(const char* fmt, ...) {
	char msg[512];
	va_list ap;
	va_start(ap, fmt);
	vsnprintf(msg, sizeof(msg), fmt, ap);
	va_end(ap);

	/* Escape quotes/backslashes so the JSON stays well-formed. */
	fputs("{\"ok\": false, \"error\": \"", stdout);
	for (const char* p = msg; *p; ++p) {
		if (*p == '"' || *p == '\\') {
			putchar('\\');
			putchar(*p);
		} else if (*p == '\n' || *p == '\r' || *p == '\t') {
			putchar(' ');
		} else {
			putchar(*p);
		}
	}
	fputs("\"}\n", stdout);
	fflush(stdout);
	exit(1);
}

/* ================================================================== *
 * Minimal JSON parser (objects, arrays, strings, numbers, bool, null)
 * Produces a small owned DOM. Allocations are intentionally never
 * freed — this is a short-lived, one-shot CLI process.
 * ================================================================== */

enum jtype { J_NULL, J_BOOL, J_NUM, J_STR, J_ARR, J_OBJ };

typedef struct JVal {
	enum jtype type;
	double num;             /* J_NUM, and 0/1 for J_BOOL */
	char* str;              /* J_STR (NUL-terminated, owned) */
	struct JVal** items;    /* J_ARR */
	int nitems;
	char** keys;            /* J_OBJ */
	struct JVal** vals;     /* J_OBJ */
	int nfields;
} JVal;

typedef struct {
	const char* p;
	bool err;
} JParser;

static JVal* jparse_value(JParser* J);

static void jskipws(JParser* J) {
	while (*J->p == ' ' || *J->p == '\t' || *J->p == '\n' || *J->p == '\r') {
		J->p++;
	}
}

static JVal* jnew(enum jtype t) {
	JVal* v = calloc(1, sizeof(JVal));
	if (!v) {
		die("out of memory");
	}
	v->type = t;
	return v;
}

/* Parse a JSON string literal (cursor sits on the opening quote). */
static char* jparse_string_raw(JParser* J) {
	if (*J->p != '"') {
		J->err = true;
		return NULL;
	}
	J->p++;
	size_t cap = 16, len = 0;
	char* out = malloc(cap);
	if (!out) {
		die("out of memory");
	}
	while (*J->p && *J->p != '"') {
		char c = *J->p++;
		if (c == '\\') {
			char e = *J->p++;
			switch (e) {
				case '"':  c = '"';  break;
				case '\\': c = '\\'; break;
				case '/':  c = '/';  break;
				case 'n':  c = '\n'; break;
				case 't':  c = '\t'; break;
				case 'r':  c = '\r'; break;
				case 'b':  c = '\b'; break;
				case 'f':  c = '\f'; break;
				case 'u': {
					/* Accept but flatten \uXXXX to '?' — the scenarios only
					 * ever use ASCII identifiers and paths. */
					for (int i = 0; i < 4 && *J->p; ++i) {
						J->p++;
					}
					c = '?';
					break;
				}
				default:
					c = e;
					break;
			}
		}
		if (len + 1 >= cap) {
			cap *= 2;
			out = realloc(out, cap);
			if (!out) {
				die("out of memory");
			}
		}
		out[len++] = c;
	}
	if (*J->p != '"') {
		J->err = true;
		return NULL;
	}
	J->p++;
	out[len] = '\0';
	return out;
}

static JVal* jparse_string(JParser* J) {
	char* s = jparse_string_raw(J);
	if (J->err) {
		return NULL;
	}
	JVal* v = jnew(J_STR);
	v->str = s;
	return v;
}

static JVal* jparse_number(JParser* J) {
	char* end = NULL;
	double d = strtod(J->p, &end);
	if (end == J->p) {
		J->err = true;
		return NULL;
	}
	J->p = end;
	JVal* v = jnew(J_NUM);
	v->num = d;
	return v;
}

static JVal* jparse_array(JParser* J) {
	J->p++; /* consume '[' */
	JVal* v = jnew(J_ARR);
	size_t cap = 4;
	v->items = malloc(cap * sizeof(JVal*));
	jskipws(J);
	if (*J->p == ']') {
		J->p++;
		return v;
	}
	for (;;) {
		JVal* item = jparse_value(J);
		if (J->err) {
			return NULL;
		}
		if ((size_t)v->nitems >= cap) {
			cap *= 2;
			v->items = realloc(v->items, cap * sizeof(JVal*));
		}
		v->items[v->nitems++] = item;
		jskipws(J);
		if (*J->p == ',') {
			J->p++;
			jskipws(J);
			continue;
		}
		if (*J->p == ']') {
			J->p++;
			break;
		}
		J->err = true;
		return NULL;
	}
	return v;
}

static JVal* jparse_object(JParser* J) {
	J->p++; /* consume '{' */
	JVal* v = jnew(J_OBJ);
	size_t cap = 4;
	v->keys = malloc(cap * sizeof(char*));
	v->vals = malloc(cap * sizeof(JVal*));
	jskipws(J);
	if (*J->p == '}') {
		J->p++;
		return v;
	}
	for (;;) {
		jskipws(J);
		char* key = jparse_string_raw(J);
		if (J->err) {
			return NULL;
		}
		jskipws(J);
		if (*J->p != ':') {
			J->err = true;
			return NULL;
		}
		J->p++;
		JVal* val = jparse_value(J);
		if (J->err) {
			return NULL;
		}
		if ((size_t)v->nfields >= cap) {
			cap *= 2;
			v->keys = realloc(v->keys, cap * sizeof(char*));
			v->vals = realloc(v->vals, cap * sizeof(JVal*));
		}
		v->keys[v->nfields] = key;
		v->vals[v->nfields] = val;
		v->nfields++;
		jskipws(J);
		if (*J->p == ',') {
			J->p++;
			continue;
		}
		if (*J->p == '}') {
			J->p++;
			break;
		}
		J->err = true;
		return NULL;
	}
	return v;
}

static JVal* jparse_value(JParser* J) {
	jskipws(J);
	switch (*J->p) {
		case '{': return jparse_object(J);
		case '[': return jparse_array(J);
		case '"': return jparse_string(J);
		case 't':
			if (strncmp(J->p, "true", 4) == 0) {
				J->p += 4;
				JVal* v = jnew(J_BOOL);
				v->num = 1;
				return v;
			}
			break;
		case 'f':
			if (strncmp(J->p, "false", 5) == 0) {
				J->p += 5;
				JVal* v = jnew(J_BOOL);
				v->num = 0;
				return v;
			}
			break;
		case 'n':
			if (strncmp(J->p, "null", 4) == 0) {
				J->p += 4;
				return jnew(J_NULL);
			}
			break;
		default:
			if (*J->p == '-' || (*J->p >= '0' && *J->p <= '9')) {
				return jparse_number(J);
			}
			break;
	}
	J->err = true;
	return NULL;
}

static JVal* jparse(const char* text) {
	JParser J = { text, false };
	JVal* v = jparse_value(&J);
	if (J.err || !v) {
		return NULL;
	}
	return v;
}

/* Object field lookup (returns NULL if absent or not an object). */
static JVal* jget(const JVal* obj, const char* key) {
	if (!obj || obj->type != J_OBJ) {
		return NULL;
	}
	for (int i = 0; i < obj->nfields; ++i) {
		if (strcmp(obj->keys[i], key) == 0) {
			return obj->vals[i];
		}
	}
	return NULL;
}

static double jget_num(const JVal* obj, const char* key, double dflt) {
	JVal* v = jget(obj, key);
	return (v && v->type == J_NUM) ? v->num : dflt;
}

/* ================================================================== *
 * Button name -> GBA key bitmask.
 * ================================================================== */
static uint32_t button_bit(const char* name) {
	if (strcmp(name, "A") == 0)      return 1u << GBA_KEY_A_BIT;
	if (strcmp(name, "B") == 0)      return 1u << GBA_KEY_B_BIT;
	if (strcmp(name, "SELECT") == 0) return 1u << GBA_KEY_SELECT_BIT;
	if (strcmp(name, "START") == 0)  return 1u << GBA_KEY_START_BIT;
	if (strcmp(name, "RIGHT") == 0)  return 1u << GBA_KEY_RIGHT_BIT;
	if (strcmp(name, "LEFT") == 0)   return 1u << GBA_KEY_LEFT_BIT;
	if (strcmp(name, "UP") == 0)     return 1u << GBA_KEY_UP_BIT;
	if (strcmp(name, "DOWN") == 0)   return 1u << GBA_KEY_DOWN_BIT;
	if (strcmp(name, "R") == 0)      return 1u << GBA_KEY_R_BIT;
	if (strcmp(name, "L") == 0)      return 1u << GBA_KEY_L_BIT;
	die("unknown button: %s", name);
	return 0;
}

/* ================================================================== *
 * Recorded reads, printed in the final JSON.
 * ================================================================== */
typedef struct {
	char* name;
	uint32_t value;
} ReadResult;

static ReadResult g_reads[256];
static int g_nreads = 0;

/* ================================================================== *
 * Emulator helpers.
 * ================================================================== */

/* Advance `frames` frames while holding `keys` (a GBA key bitmask). */
static void run_frames(struct mCore* core, uint32_t keys, int frames) {
	core->setKeys(core, keys);
	for (int i = 0; i < frames; ++i) {
		core->runFrame(core);
	}
}

/* Read `size` (1/2/4) bytes little-endian from the emulated bus. */
static uint32_t bus_read(struct mCore* core, uint32_t addr, int size) {
	uint32_t value = 0;
	for (int i = 0; i < size; ++i) {
		uint32_t byte = core->busRead8(core, addr + i) & 0xFF;
		value |= byte << (8 * i);
	}
	return value;
}

/* Dump the current video buffer (width*height color_t) to a P6 PPM file.
 *
 * This libmgba build defines color_t as uint32_t with the channel layout
 *   M_COLOR_RED=0x000000FF, GREEN=0x0000FF00, BLUE=0x00FF0000
 * i.e. bytes are R,G,B,A in memory. We emit R,G,B directly.
 *
 * A 16-bit fallback (RGB555 / RGB565) is provided for completeness, though
 * the installed 0.10.5 Homebrew build uses the 32-bit path above.
 */
static void write_ppm(const char* path, const color_t* buffer,
                      unsigned width, unsigned height, size_t stride) {
	FILE* f = fopen(path, "wb");
	if (!f) {
		die("cannot open screenshot path: %s", path);
	}
	fprintf(f, "P6\n%u %u\n255\n", width, height);
	for (unsigned y = 0; y < height; ++y) {
		const color_t* row = buffer + (size_t)y * stride;
		for (unsigned x = 0; x < width; ++x) {
			color_t c = row[x];
			uint8_t rgb[3];
#if BYTES_PER_PIXEL == 4
			rgb[0] = (uint8_t)(c & 0xFF);         /* R */
			rgb[1] = (uint8_t)((c >> 8) & 0xFF);  /* G */
			rgb[2] = (uint8_t)((c >> 16) & 0xFF); /* B */
#else
	#ifdef COLOR_5_6_5
			rgb[0] = (uint8_t)(((c >> 11) & 0x1F) * 0x21 >> 2); /* R */
			rgb[1] = (uint8_t)(((c >> 5) & 0x3F) * 0x41 >> 4);  /* G */
			rgb[2] = (uint8_t)((c & 0x1F) * 0x21 >> 2);         /* B */
	#else /* RGB555 */
			rgb[0] = (uint8_t)((c & 0x1F) * 0x21 >> 2);         /* R */
			rgb[1] = (uint8_t)(((c >> 5) & 0x1F) * 0x21 >> 2);  /* G */
			rgb[2] = (uint8_t)(((c >> 10) & 0x1F) * 0x21 >> 2); /* B */
	#endif
#endif
			if (fwrite(rgb, 1, 3, f) != 3) {
				fclose(f);
				die("short write to screenshot: %s", path);
			}
		}
	}
	fclose(f);
}

/* ================================================================== *
 * Read a whole file into a NUL-terminated buffer.
 * ================================================================== */
static char* slurp(const char* path) {
	FILE* f = fopen(path, "rb");
	if (!f) {
		die("cannot open scenario: %s", path);
	}
	fseek(f, 0, SEEK_END);
	long n = ftell(f);
	if (n < 0) {
		fclose(f);
		die("cannot size scenario: %s", path);
	}
	fseek(f, 0, SEEK_SET);
	char* buf = malloc((size_t)n + 1);
	if (!buf) {
		die("out of memory");
	}
	size_t got = fread(buf, 1, (size_t)n, f);
	fclose(f);
	buf[got] = '\0';
	return buf;
}

/* ================================================================== *
 * Main.
 * ================================================================== */
int main(int argc, char** argv) {
	if (argc != 3) {
		die("usage: mgba_runner <rom.gba> <scenario.json>");
	}
	const char* rom_path = argv[1];
	const char* scenario_path = argv[2];

	/* --- Parse the scenario up front so bad input fails fast. --- */
	char* json_text = slurp(scenario_path);
	JVal* root = jparse(json_text);
	if (!root) {
		die("failed to parse scenario JSON");
	}
	JVal* steps = jget(root, "steps");
	if (!steps || steps->type != J_ARR) {
		die("scenario missing \"steps\" array");
	}

	/* --- Create and initialise the GBA core. --- */
	struct mCore* core = GBACoreCreate();
	if (!core) {
		die("GBACoreCreate failed");
	}
	if (!core->init(core)) {
		die("core init failed");
	}
	mCoreInitConfig(core, NULL);

	/* --- Allocate and register the video buffer. --- */
	unsigned width = 0, height = 0;
	core->desiredVideoDimensions(core, &width, &height); /* GBA: 240x160 */
	color_t* video = malloc((size_t)width * height * BYTES_PER_PIXEL);
	if (!video) {
		die("cannot allocate video buffer (%ux%u)", width, height);
	}
	core->setVideoBuffer(core, video, width); /* stride == width pixels */

	/* --- Load the ROM (core takes ownership of the VFile). --- */
	struct VFile* rom = VFileOpen(rom_path, O_RDONLY);
	if (!rom) {
		die("cannot open ROM: %s", rom_path);
	}
	if (!core->loadROM(core, rom)) {
		die("loadROM failed: %s", rom_path);
	}

	/* --- Boot. --- */
	core->reset(core);

	/* --- Execute the scripted steps in order. --- */
	for (int s = 0; s < steps->nitems; ++s) {
		JVal* step = steps->items[s];
		if (step->type != J_OBJ) {
			die("step %d is not an object", s);
		}
		JVal* op_v = jget(step, "op");
		if (!op_v || op_v->type != J_STR) {
			die("step %d missing \"op\"", s);
		}
		const char* op = op_v->str;

		if (strcmp(op, "advance") == 0) {
			int frames = (int)jget_num(step, "frames", 1);
			run_frames(core, 0, frames);

		} else if (strcmp(op, "press") == 0) {
			JVal* buttons = jget(step, "buttons");
			if (!buttons || buttons->type != J_ARR) {
				die("step %d (press) missing \"buttons\" array", s);
			}
			uint32_t mask = 0;
			for (int b = 0; b < buttons->nitems; ++b) {
				JVal* bn = buttons->items[b];
				if (bn->type != J_STR) {
					die("step %d (press) has non-string button", s);
				}
				mask |= button_bit(bn->str);
			}
			int frames = (int)jget_num(step, "frames", 1);
			int release = (int)jget_num(step, "release", 0);
			run_frames(core, mask, frames);  /* hold */
			run_frames(core, 0, release);     /* then release */

		} else if (strcmp(op, "read") == 0) {
			JVal* name_v = jget(step, "name");
			if (!name_v || name_v->type != J_STR) {
				die("step %d (read) missing \"name\"", s);
			}
			JVal* addr_v = jget(step, "addr");
			if (!addr_v || addr_v->type != J_NUM) {
				die("step %d (read) missing \"addr\"", s);
			}
			int size = (int)jget_num(step, "size", 1);
			if (size != 1 && size != 2 && size != 4) {
				die("step %d (read) size must be 1, 2, or 4", s);
			}
			uint32_t addr = (uint32_t)addr_v->num;
			uint32_t value = bus_read(core, addr, size);
			if (g_nreads >= (int)(sizeof(g_reads) / sizeof(g_reads[0]))) {
				die("too many reads");
			}
			g_reads[g_nreads].name = name_v->str;
			g_reads[g_nreads].value = value;
			g_nreads++;

		} else if (strcmp(op, "screenshot") == 0) {
			JVal* path_v = jget(step, "path");
			if (!path_v || path_v->type != J_STR) {
				die("step %d (screenshot) missing \"path\"", s);
			}
			write_ppm(path_v->str, video, width, height, width);

		} else {
			die("step %d has unknown op: %s", s, op);
		}
	}

	/* --- Emit the result JSON. --- */
	fputs("{\"reads\": {", stdout);
	for (int i = 0; i < g_nreads; ++i) {
		if (i) {
			fputs(", ", stdout);
		}
		/* Names are simple identifiers; escape quotes/backslashes anyway. */
		putchar('"');
		for (const char* p = g_reads[i].name; *p; ++p) {
			if (*p == '"' || *p == '\\') {
				putchar('\\');
			}
			putchar(*p);
		}
		printf("\": %u", g_reads[i].value);
	}
	fputs("}, \"ok\": true}\n", stdout);
	fflush(stdout);

	core->deinit(core);
	return 0;
}
