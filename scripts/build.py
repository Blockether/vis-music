"""Build the generated part of vis-music.

python scripts/build.py    bundle js/ into src/vis_music/engine/engine.mjs
"""

import subprocess
import sys
from pathlib import Path

ROOT = Path(__file__).resolve().parents[1]


def run(argv, cwd=ROOT):
    print("+", " ".join(map(str, argv)), flush=True)
    return subprocess.run(argv, cwd=cwd).returncode == 0


def engine():
    js = ROOT / "js"
    if not (js / "node_modules").is_dir() and not run(["npm", "ci"], js):
        sys.exit("npm ci failed")
    if not run(["npm", "run", "build"], js):
        sys.exit("the engine bundle failed")


if __name__ == "__main__":
    engine()
