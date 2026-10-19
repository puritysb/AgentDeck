import { readdirSync, readFileSync, statSync } from 'fs';
import { join, relative } from 'path';
import { fileURLToPath } from 'url';
import { describe, expect, it } from 'vitest';

const root = fileURLToPath(new URL('../..', import.meta.url));
const firmware = join(root, 'esp32/src');
const reserve = join(firmware, 'util/internal_reserve.cpp');
const main = join(firmware, 'main.cpp');

function sources(dir: string): string[] {
  return readdirSync(dir).flatMap((name) => {
    const path = join(dir, name);
    if (statSync(path).isDirectory()) return sources(path);
    return /\.(c|cpp|h|hpp)$/.test(name) ? [path] : [];
  });
}

// Comments name these calls while explaining them; only code counts.
function code(file: string): string {
  return readFileSync(file, 'utf-8').replace(/\/\*[\s\S]*?\*\//g, '').replace(/\/\/.*$/gm, '');
}

function callSites(pattern: RegExp): string[] {
  return sources(firmware).flatMap((file) =>
    code(file).split('\n').flatMap((line, i) => (pattern.test(line) ? [`${relative(root, file)}:${i + 1}`] : [])),
  );
}

// The pool's capabilities as internal_reserve.cpp spells them.
function poolCaps(body: string): Set<string> {
  const marker = body.match(/constexpr uint32_t POOL_MARKER = (MALLOC_CAP_\w+);/)?.[1] ?? 'POOL_MARKER';
  const mask = body.match(/constexpr uint32_t POOL_CAPS\s*=([^;]*);/)?.[1] ?? '';
  return new Set(mask.split('|').map((cap) => (cap.trim() === 'POOL_MARKER' ? marker : cap.trim())));
}

// What these wrappers ask heap_caps for on the ESP32 targets (Arduino's
// cores/esp32/Esp.cpp, FreeRTOS's heap_idf.c, esp_system).
const WRAPPERS: [RegExp, string[]][] = [
  [/\bESP\.(?:getHeapSize|getFreeHeap|getMinFreeHeap|getMaxAllocHeap)\s*\(/g, ['MALLOC_CAP_INTERNAL']],
  [/\bxPortGet(?:MinimumEver)?FreeHeapSize\s*\(/g, ['MALLOC_CAP_INTERNAL', 'MALLOC_CAP_8BIT']],
  [/\besp_get_free_internal_heap_size\s*\(/g, ['MALLOC_CAP_INTERNAL', 'MALLOC_CAP_DMA', 'MALLOC_CAP_8BIT']],
];
const QUERY = /\bheap_caps_get_(?:free_size|minimum_free_size|largest_free_block|total_size)\s*\(([^)]*)\)/g;

type Query = { file: string; call: string; gates: string[] };

// Every heap-size query in the firmware that would count a heap carrying
// `caps`, with the preprocessor conditions around it. A query counts each heap
// that has every capability it names, so one naming a capability outside
// `caps` cannot count it. One naming a variable is kept: its value is not
// readable here.
function queriesCounting(caps: Set<string>): Query[] {
  return sources(firmware).flatMap((path) => {
    const text = code(path);
    const open: string[] = [];
    const gatesByLine = text.split('\n').map((line) => {
      const directive = line.match(/^\s*#\s*(if|ifdef|ifndef|elif|else|endif)\b(.*)$/);
      if (directive) {
        const [, kind, rest] = directive;
        const condition =
          kind === 'ifdef' ? `defined(${rest.trim()})` : kind === 'ifndef' ? `!defined(${rest.trim()})` : rest.trim();
        if (kind === 'endif') open.pop();
        else if (kind.startsWith('if')) open.push(condition);
        else open[open.length - 1] = kind === 'else' ? '#else' : condition;
      }
      return [...open];
    });
    const at = (index: number, call: string): Query => ({
      file: relative(root, path),
      call: call.replace(/\s+/g, ' '),
      gates: gatesByLine[text.slice(0, index).split('\n').length - 1],
    });
    const found: Query[] = [];
    for (const match of text.matchAll(QUERY)) {
      const named = match[1].match(/\bMALLOC_CAP_\w+/g) ?? [];
      if (named.every((cap) => caps.has(cap))) found.push(at(match.index!, match[0]));
    }
    for (const [pattern, named] of WRAPPERS) {
      if (!named.every((cap) => caps.has(cap))) continue;
      for (const match of text.matchAll(pattern)) found.push(at(match.index!, match[0]));
    }
    return found;
  });
}

describe('ESP32 internal RAM reserve', () => {
  const body = code(reserve);

  it('registers its pool at the lowest priority only, without the bit malloc() asks for', () => {
    const caps = body.match(/caps\[SOC_MEMORY_TYPE_NO_PRIOS\]\s*=\s*\{([^}]*)\}/)?.[1];
    expect(caps).toBeDefined();
    const slots = caps!.split(',').map((slot) => slot.trim());
    expect(slots).toHaveLength(3);
    // A capability in the first two slots would let a request match the pool
    // before the regular internal heaps have refused it.
    expect(slots.slice(0, 2)).toEqual(['0', '0']);
    const mask = body.match(new RegExp(`constexpr uint32_t ${slots[2]}\\s*=([^;]*);`))?.[1] ?? slots[2];
    expect(mask).toContain('MALLOC_CAP_INTERNAL');
    // malloc() asks for DEFAULT, so with it the pool would drain exactly as
    // ESP-IDF's own reserve does. SPIRAM would make it a PSRAM heap. The
    // compiler holds the whole mask to that, named constants included.
    expect(mask).not.toMatch(/MALLOC_CAP_DEFAULT|MALLOC_CAP_SPIRAM/);
    expect(body).toMatch(
      new RegExp(`static_assert\\(\\(${slots[2]} & \\(MALLOC_CAP_DEFAULT \\| MALLOC_CAP_SPIRAM\\)\\) == 0`),
    );
  });

  it('reads the pool apart by a capability no allocation asks for', () => {
    // The pool's own free and low-water figures are queries for its marker
    // alone, which only the pool carries.
    expect(body).toMatch(/constexpr uint32_t POOL_MARKER = MALLOC_CAP_PID\d;/);
    expect(body).toMatch(/POOL_CAPS\s*=[^;]*POOL_MARKER/);
    expect(body).toMatch(/heap_caps_get_free_size\(POOL_MARKER\)/);
    expect(body).toMatch(/heap_caps_get_minimum_free_size\(POOL_MARKER\)/);
    expect(callSites(/MALLOC_CAP_PID\d/)).toEqual([expect.stringMatching(/^esp32\/src\/util\/internal_reserve\.cpp:/)]);
  });

  it('leaves the pool out of every internal heap figure the firmware reads', () => {
    // A plain query for INTERNAL or DMA counts the pool, whose untouched
    // 16 KB would read as headroom malloc() cannot reach.
    const caps = poolCaps(body);
    expect([...caps].every((cap) => cap.startsWith('MALLOC_CAP_'))).toBe(true);
    expect([...caps]).toEqual(expect.arrayContaining(['MALLOC_CAP_INTERNAL', 'MALLOC_CAP_DMA']));
    const counting = queriesCounting(caps).filter((query) => query.file !== 'esp32/src/util/internal_reserve.cpp');
    // Diagnostics built only for the IPS10, which has no pool: its display
    // path, its voice upload and its opt-in frame profiler. The pool's gate is
    // pinned to t_embed below; a board added there has to answer for these.
    const ips10Only: Record<string, [gate: string, count: number]> = {
      'esp32/src/main.cpp': ['defined(IPS10_PERF_PROFILE)', 1],
      'esp32/src/ui/display.cpp': ['defined(BOARD_IPS10)', 1],
      'esp32/src/net/ws_client.cpp': ['defined(BOARD_VOICE_HTTP_UPLOAD)', 2],
    };
    for (const [file, [gate, count]] of Object.entries(ips10Only)) {
      const here = counting.filter((query) => query.file === file);
      expect(here, file).toHaveLength(count);
      for (const query of here) expect(query.gates, `${file}: ${query.call}`).toContain(gate);
    }
    expect(counting.filter((query) => !(query.file in ips10Only)).map((query) => `${query.file}: ${query.call}`)).toEqual(
      [],
    );
    // BOARD_VOICE_HTTP_UPLOAD comes from the IPS10's board header alone.
    const boards = join(root, 'esp32/boards');
    const voiceUpload = sources(boards).filter((path) => /#define BOARD_VOICE_HTTP_UPLOAD\b/.test(code(path)));
    expect(voiceUpload.map((path) => relative(root, path))).toEqual(['esp32/boards/board_jc8012p4a1c.h']);
    expect(code(join(boards, 'board_config.h'))).toMatch(
      /#elif defined\(BOARD_IPS10\)[^\n]*\n\s*#include "board_jc8012p4a1c\.h"/,
    );
    expect(callSites(/#define BOARD_VOICE_HTTP_UPLOAD\b/)).toEqual([]);
    expect(readFileSync(join(root, 'esp32/platformio.ini'), 'utf-8')).not.toMatch(/BOARD_VOICE_HTTP_UPLOAD/);

    const info = code(join(firmware, 'net/protocol.cpp'));
    for (const [field, helper] of [
      ['freeHeapKb', 'heapFreeBytes'],
      ['minFreeHeapKb', 'heapMinFreeBytes'],
      ['largestFreeBlockKb', 'heapLargestFreeBlock'],
    ]) {
      expect(info, field).toMatch(new RegExp(`resp\\["${field}"\\]\\s*=\\s*InternalReserve::${helper}\\(`));
    }
  });

  it('sends the pool fields by the rule protocol.ts states', () => {
    // Absent: no pool asked for. 0: asked for and none carved. Free and
    // low-water figures exist only for a pool that was carved.
    const info = code(join(firmware, 'net/protocol.cpp'));
    const asked = info.match(/if \(InternalReserve::requestedBytes\(\) > 0\) \{([\s\S]*?)\n    \}/)?.[1] ?? '';
    expect(asked).toMatch(/^\s*resp\["internalReserveKb"\] = InternalReserve::capacityBytes\(\) \/ 1024;/);
    const carved = asked.match(/if \(InternalReserve::capacityBytes\(\) > 0\) \{([\s\S]*?)\}/)?.[1] ?? '';
    expect(carved).toMatch(/resp\["internalReserveFreeKb"\] = InternalReserve::freeBytes\(\)/);
    expect(carved).toMatch(/resp\["internalReserveMinKb"\] = InternalReserve::minFreeBytes\(\)/);
    for (const field of ['internalReserveKb', 'internalReserveFreeKb', 'internalReserveMinKb']) {
      expect(info.split(`resp["${field}"]`).length - 1, field).toBe(1);
    }
  });

  it('is built only into PSRAM boards whose config asks for it', () => {
    // Every other board compiles the helpers down to the plain heap figures.
    const gate = body.match(/^#if (.*)\n#define INTERNAL_RESERVE_POOL 1$/m)?.[1] ?? '';
    expect(gate).toContain('defined(BOARD_HAS_PSRAM)');
    expect(gate).toContain('defined(AGENTDECK_INTERNAL_RESERVE)');
    const config = code(join(firmware, 'config.h'));
    const asks = config.match(/#if ([^\n]*)\n#define AGENTDECK_INTERNAL_RESERVE 1\n(constexpr uint32_t INTERNAL_RESERVE_BYTES = [^;]*;)\n#endif/);
    expect(asks).not.toBeNull();
    // The one board measured with the pool. The heap-query scan above lets
    // IPS10-only diagnostics count the pool on the strength of this line.
    expect(asks![1].trim()).toBe('defined(BOARD_T_EMBED)');
    expect(config.match(/INTERNAL_RESERVE_BYTES/g)).toHaveLength(1);
  });

  it('carves the pool only out of memory that is not already the pool', () => {
    // The pool lacks DEFAULT, so asking for it keeps a second pass of the
    // carve loop from taking a block out of the region it just registered.
    expect(body).toMatch(/CARVE_CAPS\s*=[^;]*MALLOC_CAP_DEFAULT/);
    expect(body).toMatch(/heap_caps_get_largest_free_block\(CARVE_CAPS\)/);
    expect(body).toMatch(/heap_caps_malloc\(next, CARVE_CAPS\)/);
  });

  it('is the only code that adds a heap region or restarts minimum tracking', () => {
    expect(callSites(/heap_caps_add_region(_with_caps)?\s*\(/)).toEqual([
      expect.stringMatching(/^esp32\/src\/util\/internal_reserve\.cpp:/),
    ]);
    expect(callSites(/heap_caps_monitor_local_minimum_free_size_start\s*\(/)).toEqual([
      expect.stringMatching(/^esp32\/src\/util\/internal_reserve\.cpp:/),
    ]);
  });

  it('never stops minimum tracking, which would zero the pool low-water mark', () => {
    // A heap added after startup reports a minimum of 0, and stop() restores
    // the value saved by start(), which for the pool is that 0.
    expect(callSites(/heap_caps_monitor_local_minimum_free_size_stop\s*\(/)).toEqual([]);
  });

  it('is carved at the top of setup(), before Serial or anything else allocates', () => {
    const setup = code(main).match(/void setup\(\) \{([\s\S]*?)\n\}/)?.[1] ?? '';
    const begin = setup.indexOf('InternalReserve::begin();');
    expect(begin).toBeGreaterThan(setup.indexOf('HeapTelemetry::begin();'));
    expect(setup.indexOf('HeapTelemetry::begin();')).toBeGreaterThanOrEqual(0);
    for (const later of ['Serial.setRxBufferSize(', 'Serial.begin(', 'logHeap("boot")']) {
      expect(setup.indexOf(later), later).toBeGreaterThan(begin);
    }
    expect(callSites(/InternalReserve::begin\(\)/)).toHaveLength(1);
  });
});
