"""从 Termux 官方仓库准备 Android arm64 Node 运行时（libnode.so 与依赖库）。

方法与上游 scripts/prepare-native.py 相同：官方 deb 包、SHA256 校验、
纯解包、不执行任何安装脚本。Node 二进制与其依赖库的版本号后缀
（如 libuv.so.1）在 ELF 内做等长补丁抹平为 libuv.so，Android 打包
提取后可被 dlopen / exec 正确解析。产物放入 app/src/main/jniLibs/arm64-v8a/。
"""
import gzip
import hashlib
import re
import subprocess
import sys
import tarfile
import tempfile
import urllib.request
from pathlib import Path

REPO = "https://packages.termux.dev/apt/termux-main"
ROOT = Path(__file__).resolve().parents[2]
TARGET = ROOT / "app/src/main/jniLibs/arm64-v8a"
PACKAGE = "nodejs"
# Android 系统分区自带、无需随包携带的库
SYSTEM_LIBS = {"libc.so", "libdl.so", "libm.so", "liblog.so"}


def fetch(url: str) -> bytes:
    req = urllib.request.Request(url, headers={"User-Agent": "dsh-phone-build"})
    with urllib.request.urlopen(req, timeout=180) as resp:
        return resp.read()


def find_package(index_text: str, name: str) -> dict:
    for stanza in index_text.split("\n\n"):
        fields = {}
        for line in stanza.splitlines():
            if ": " in line:
                key, value = line.split(": ", 1)
                fields[key] = value
        if fields.get("Package") == name:
            return fields
    raise SystemExit(f"索引中找不到包: {name}")


def unpack_deb(data: bytes, dest: Path) -> None:
    """解析 deb 的 ar 归档并解出 data.tar（与上游 prepare-native.py 相同方法）。"""
    assert data[:8] == b"!<arch>\n", "不是 deb 归档"
    offset = 8
    while offset < len(data):
        header = data[offset : offset + 60]
        size = int(header[48:58])
        name = header[:16].decode().strip().rstrip("/")
        if name in ("data.tar.xz", "data.tar.zst", "data.tar.gz"):
            (dest / name).write_bytes(data[offset + 60 : offset + 60 + size])
        offset += 60 + size + (size % 2)
    member = next(dest.glob("data.tar.*"))
    if member.name.endswith(".zst"):
        raw = subprocess.run(["zstd", "-d", str(member), "-o", str(dest / "data.tar"), "-f"],
                             check=True, capture_output=True)
        member = dest / "data.tar"
    with tarfile.open(member) as tar:
        tar.extractall(dest / "data")


def strip_version(lib: str) -> str:
    """libuv.so.1 -> libuv.so；libcrypto.so.3 -> libcrypto.so"""
    return re.sub(r"\.so\.[0-9.]+$", ".so", lib)


def fix_elf_names(data: bytes) -> bytes:
    """ELF 内等长补丁：DT_NEEDED 'libuv.so.1\\0' -> 'libuv.so\\0\\0\\0'"""
    out = data
    for stem, ver in set(re.findall(rb"(lib[A-Za-z0-9_+.-]*\.so)\.([0-9][0-9.]*)\x00", out)):
        old = stem + b"." + ver + b"\x00"
        new = stem + b"\x00" + b"\x00" * (len(old) - len(stem) - 1)
        assert len(old) == len(new)
        out = out.replace(old, new)
    return out


def needed(path: Path) -> set:
    out = subprocess.run(["readelf", "-d", str(path)],
                         capture_output=True, text=True, check=True).stdout
    return {m.group(1) for line in out.splitlines()
            if "Shared library:" in line
            for m in [re.search(r"\[(.+?)\]", line)]}


def main() -> None:
    index = fetch(REPO + "/dists/stable/main/binary-aarch64/Packages.gz")
    fields = find_package(gzip.decompress(index).decode(), PACKAGE)
    print(f"Termux {PACKAGE} {fields['Version']}")

    deb = fetch(REPO + "/" + fields["Filename"])
    got = hashlib.sha256(deb).hexdigest()
    if got != fields["SHA256"]:
        raise SystemExit(f"SHA256 不匹配: {got}")
    print("SHA256 校验通过")

    with tempfile.TemporaryDirectory(prefix="dsh-node-") as td:
        tmp = Path(td)
        unpack_deb(deb, tmp)
        usr = tmp / "data/data/com.termux/files/usr"
        node = usr / "bin/node"
        if not node.is_file():
            raise SystemExit("包内没有 bin/node")

        TARGET.mkdir(parents=True, exist_ok=True)
        (TARGET / "libnode.so").write_bytes(fix_elf_names(node.read_bytes()))

        # BFS 收集 node 及其依赖库的全部 bionic 动态依赖
        usr_lib = usr / "lib"
        queue = needed(node)
        done = {"libnode.so"}
        while queue:
            original = queue.pop()
            if original in SYSTEM_LIBS:
                continue
            name = strip_version(original)
            if name in done:
                continue
            src = usr_lib / original
            if not src.is_file():
                raise SystemExit(f"缺少依赖库: {original}")
            (TARGET / name).write_bytes(fix_elf_names(src.read_bytes()))
            done.add(name)
            queue |= needed(src)
        print(f"已生成 {len(done)} 个文件：", ", ".join(sorted(done)))

    for item in sorted(TARGET.glob("*")):
        print(f"  {item.name}  {item.stat().st_size} 字节")


if __name__ == "__main__":
    sys.exit(main())
