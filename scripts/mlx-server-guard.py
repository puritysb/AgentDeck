#!/usr/bin/env python3
"""Operator-only MLX-VLM 0.6.15 guard. Not bundled in the AgentDeck app.

Run with the server's existing Python and normal server flags, including --model.
AGENTDECK_MLX_MEMORY_GIB is required: the operator budgets the entire server.
The adapter refuses other models/kinds/adapters and exits on OOM so a configured
supervisor can recover it. It does not install or start a supervisor itself.
"""
import logging
import os
import sys
from threading import Event, Thread


def install(server, model, memory, mlx, exit_process=os._exit):
    if server.__version__ != '0.6.15':
        raise RuntimeError('MLX server guard requires verified mlx-vlm 0.6.15; review adapter before upgrading')
    from fastapi import HTTPException
    original = server.get_cached_model
    sentinel = server._app_module._INHERIT_ADAPTER

    def resident_only(model_path, adapter_path=sentinel, *, model_kind='auto'):
        if model_path != model or adapter_path not in (sentinel, None) or model_kind not in ('auto', 'text_generation'):
            raise HTTPException(status_code=409, detail='Operating server is pinned; model replacement is disabled')
        return original(model_path, adapter_path, model_kind=model_kind)

    # Both the startup factory and the request dependency lookup must be gated.
    server.get_cached_model = resident_only
    server._app_module.get_cached_model = resident_only
    mlx.set_memory_limit(memory)
    mlx.set_wired_limit(memory)
    mlx.set_cache_limit(min(memory // 16, 1024**3))

    class ExitOnOOM(logging.Handler):
        def emit(self, record):
            if record.levelno < logging.ERROR: return
            text = record.getMessage()
            if record.exc_info and record.exc_info[1]:
                text += ' ' + str(record.exc_info[1])
            if any(marker in text.lower() for marker in ('outofmemory', 'out of memory', 'insufficient memory', 'memory limit', 'bad_alloc')):
                # No logging recursion, no cooperative shutdown that may hang
                # on a stuck GPU thread. launchd/systemd must own this process.
                os.write(2, b'MLX guard: allocator failure; exiting for supervised recovery\n')
                exit_process(70)

    logging.getLogger().addHandler(ExitOnOOM())
    return resident_only


def enforce_budget(mlx, memory, exit_process=os._exit):
    if mlx.get_peak_memory() > memory:
        os.write(2, b'MLX guard: GPU memory budget exceeded; exiting for supervised recovery\n')
        exit_process(70)


def main():
    if '--reload' in sys.argv:
        raise SystemExit('Guard forbids reload: it can start an unguarded child')
    try:
        model = sys.argv[sys.argv.index('--model') + 1]
        memory = int(os.environ['AGENTDECK_MLX_MEMORY_GIB']) * 1024**3
        if not model or model.startswith('-') or memory <= 0:
            raise ValueError('invalid model or memory budget')
    except (ValueError, IndexError, KeyError):
        raise SystemExit('Set AGENTDECK_MLX_MEMORY_GIB and pass --model MODEL explicitly')
    import mlx.core as mx
    import mlx_vlm.server as server
    install(server, model, memory, mx)
    # set_memory_limit is only an allocator guideline (swap may exceed it).
    # Independently enforce the process GPU high-water mark; no GPU eval here.
    stop = Event()
    def watch_memory():
        while not stop.wait(0.5):
            enforce_budget(mx, memory)
    Thread(target=watch_memory, name="mlx-memory-budget", daemon=True).start()
    server.main()


if __name__ == '__main__':
    main()
