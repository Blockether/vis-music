"""Build the generated parts of vis-music.

    python scripts/build.py engine    bundle js/ into src/vis_music/engine/engine.mjs
    python scripts/build.py native    build doughbox for every platform that it can
    python scripts/build.py all       both

The macOS binaries need the Xcode command line tools. The Linux and Windows
binaries need Zig (`zig` on PATH, or `pip install ziglang`).
"""

import shutil
import subprocess
import sys
from pathlib import Path

ROOT = Path(__file__).resolve().parents[1]
NATIVE = ROOT / "src" / "vis_music" / "native"
SOURCE = NATIVE / "src"
MAC = ["-framework", "CoreAudio", "-framework", "AudioToolbox", "-framework", "CoreFoundation"]
TARGETS = {
    "macos-arm64": (["cc", "-arch", "arm64", "-mmacosx-version-min=11.0"], MAC),
    "macos-x64": (["cc", "-arch", "x86_64", "-mmacosx-version-min=10.15"], MAC),
    "linux-x64": (["zig", "cc", "-target", "x86_64-linux-gnu.2.28"], ["-ldl"]),
    "linux-arm64": (["zig", "cc", "-target", "aarch64-linux-gnu.2.28"], ["-ldl"]),
    "windows-x64": (["zig", "cc", "-target", "x86_64-windows-gnu"], ["-lole32", "-lwinmm"]),
}


def run(argv, cwd=ROOT):
    print("+", " ".join(map(str, argv)), flush=True)
    return subprocess.run(argv, cwd=cwd).returncode == 0


def engine():
    js = ROOT / "js"
    if not (js / "node_modules").is_dir() and not run(["npm", "ci"], js):
        sys.exit("npm ci failed")
    if not run(["npm", "run", "build"], js):
        sys.exit("the engine bundle failed")


def zig():
    if shutil.which("zig"):
        return ["zig"]
    try:
        import ziglang  # noqa: F401
    except ImportError:
        return None
    return [sys.executable, "-m", "ziglang"]


def native():
    failed = []
    for name, (compiler, libraries) in TARGETS.items():
        if compiler[0] == "zig":
            found = zig()
            if found is None:
                print(f"skip {name}: no zig", flush=True)
                failed.append(name)
                continue
            compiler = [*found, *compiler[1:], "-s"]
        elif not shutil.which(compiler[0]) or sys.platform != "darwin":
            print(f"skip {name}: needs macOS with cc", flush=True)
            failed.append(name)
            continue
        out = NATIVE / name / ("doughbox.exe" if name.startswith("windows") else "doughbox")
        out.parent.mkdir(parents=True, exist_ok=True)
        flags = ["-std=gnu11", "-O2", "-w", f"-I{SOURCE}", f"-I{SOURCE / 'libs'}"]
        argv = [*compiler, *flags, str(SOURCE / "doughbox.c"), "-o", str(out), "-lm", "-lpthread", *libraries]
        if not run(argv):
            failed.append(name)
        out.with_suffix(".pdb").unlink(missing_ok=True)
    if failed:
        print("not built: " + ", ".join(failed))


if __name__ == "__main__":
    step = sys.argv[1] if len(sys.argv) > 1 else "all"
    if step in ("engine", "all"):
        engine()
    if step in ("native", "all"):
        native()
