"""Launcher that runs an upstream BOPBTL script with every CUDA call redirected to MPS.

  python bopbtl_mps.py test.py --gpu_ids 0 ...

The upstream code hardcodes `.cuda()` and `torch.cuda.*`; rather than editing a dozen files,
patch those entry points on the torch module before the script runs. Pass `--gpu_ids 0` so
the upstream code takes its GPU path. Device from BOPBTL_DEVICE (default mps).
"""
from __future__ import annotations

import os
import runpy
import sys

import torch

DEV = torch.device(os.environ.get("BOPBTL_DEVICE", "mps"))


def _to_dev(self, *args, **kwargs):  # replaces Tensor.cuda / Module.cuda (ignores device index)
    return self.to(DEV)


def _typed_factory(dtype):
    def make(*args, **kwargs):
        if len(args) == 1 and not isinstance(args[0], int):
            return torch.tensor(args[0], dtype=dtype, device=DEV)
        return torch.empty(*args, dtype=dtype, device=DEV)
    return make


torch.Tensor.cuda = _to_dev
torch.nn.Module.cuda = _to_dev
torch.cuda.set_device = lambda *a, **k: None
torch.cuda.is_available = lambda: True
torch.cuda.device_count = lambda: 1
torch.cuda.current_device = lambda: 0
torch.cuda.empty_cache = (lambda: torch.mps.empty_cache()) if DEV.type == "mps" else (lambda: None)
torch.cuda.synchronize = (lambda *a, **k: torch.mps.synchronize()) if DEV.type == "mps" else (lambda *a, **k: None)
torch.cuda.FloatTensor = _typed_factory(torch.float32)
torch.cuda.LongTensor = _typed_factory(torch.int64)
torch.cuda.ByteTensor = _typed_factory(torch.uint8)
torch.cuda.IntTensor = _typed_factory(torch.int32)

_load = torch.load


def _load_cpu(*args, **kwargs):
    kwargs.setdefault("map_location", "cpu")
    return _load(*args, **kwargs)


torch.load = _load_cpu

if __name__ == "__main__":
    if len(sys.argv) < 2:
        sys.exit(__doc__)
    script = sys.argv[1]
    sys.argv = sys.argv[1:]
    sys.path.insert(0, os.path.dirname(os.path.abspath(script)) or os.getcwd())  # as if run as `python script.py`
    runpy.run_path(script, run_name="__main__")
