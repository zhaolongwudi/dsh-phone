"""从 Termux 官方仓库准备 Android arm64 Node 运行时（libnode.so 与依赖库）。

方法与上游 scripts/prepare-native.py 相同：官方 deb 包、SHA256 校验、
纯解包、不执行任何安装脚本。按 nodejs 的 Depends 自动补齐拆包依赖
（openssl / icu / c-ares / zlib 等）。Node 二进制与其依赖库的版本号
后缀（如 libuv.so.1）在 ELF 内做等长补丁抹平为 libuv.so，Android 打包
提取后可被 dlopen / exec 正确解析。产物放入 app/src/main/jniLibs/arm64-v8a/。
"""
import gzip
import hashlib
import re
import shutil
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
# 【钉死运行时版本 2026-11-03】此前每次构建都取 Termux 当时的 nodejs 最新版，
# 导致 2026-11-02 构建的 Node 从 26.4.0 静默跳到 26.13.0：该版本默认 CA 存储为
# openssl，而包内不存在 /data/data/com.termux/files/usr/etc/tls/cert.pem，
# 于是所有 HTTPS 请求报 SELF_SIGNED_CERT_IN_CHAIN（上层表现为 fetch failed），
# JetHub 加账号、聚合模型、直连 api.deepseek.com 全部失败。
# 26.13.0 是经实测（配合 NodeRunner 的 --use-bundled-ca）可用的版本，
# 故钉在此处；Termux 仓库若不匹配，构建会明确失败并要求人工确认，
# 而不是换掉运行时后等到装机才暴露。升级需真机验证 TLS 与网络后再改此值。
PINNED_VERSION = "26.13.0"
# Android 系统分区自带、无需随包携带的库
SYSTEM_LIBS = {"libc.so", "libdl.so", "libm.so", "liblog.so"}

_index = {}


def fetch(url: str) -> bytes:
    req = urllib.request.Request(url, headers={"User-Agent": "dsh-phone-build"})
    with urllib.request.urlopen(req, timeout=180) as resp:
        return resp.read()


def get_index() -> str:
    if "text" not in _index:
        _index["text"] = gzip.decompress(
            fetch(REPO + "/dists/stable/main/binary-aarch64/Packages.gz")).decode()
    return _index["text"]


def find_package(name: str, wanted: str | None = None):
    for stanza in get_index().split("\n\n"):
        fields = {}
        for line in stanza.splitlines():
            if ": " in line:
                key, value = line.split(": ", 1)
                fields[key] = value
        if fields.get("Package") == name:
            # 【钉死版本】只接受指定版本，避免上游更新静默改变运行时行为。
            if wanted is not None and not fields.get("Version", "").startswith(wanted):
                raise SystemExit(
                    f"{name} 版本不匹配：仓库为 {fields.get(Version)}，"
                    f"仓库钉死为 {wanted}。请先在真机验证新版本的 TLS/网络行为，"
                    f"再修改 PINNED_VERSION。")
            return fields
    return None


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
        subprocess.run(["zstd", "-d", str(member), "-o", str(dest / "data.tar"), "-f"],
                       check=True, capture_output=True)
        member = dest / "data.tar"
    # 包内成员自带 data/ 前缀（与上游 prepare-native.py 的解包布局一致）
    with tarfile.open(member) as tar:
        tar.extractall(dest)


def unpack_package(name: str, dest: Path):
    """下载并解包一个 Termux 包（SHA256 校验），返回其 usr 目录；索引无此包返回 None。"""
    fields = find_package(name)
    if fields is None:
        print(f"跳过（索引无此包）: {name}")
        return None
    dest.mkdir(parents=True, exist_ok=True)
    deb = fetch(REPO + "/" + fields["Filename"])
    got = hashlib.sha256(deb).hexdigest()
    if got != fields["SHA256"]:
        raise SystemExit(f"{name} SHA256 不匹配: {got}")
    unpack_deb(deb, dest)
    return dest / "data/data/com.termux/files/usr"


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


def depends(fields: dict) -> list:
    """解析 Depends 字段为包名列表（去掉版本约束）。"""
    raw = fields.get("Depends", "")
    return [d.strip().split(" ")[0] for d in raw.split(",") if d.strip()]


def main() -> None:
    root = Path(tempfile.mkdtemp(prefix="dsh-node-"))
    try:
        fields = find_package(PACKAGE, PINNED_VERSION)
        usr = unpack_package(PACKAGE, root / PACKAGE)
        node = usr / "bin/node"
        if not node.is_file():
            sample = [str(p.relative_to(root)) for p in list(root.rglob("*"))[:15]]
            raise SystemExit(f"包内没有 bin/node。解包样本: {sample}")
        print(f"Termux {PACKAGE} {fields['Version']} 就绪")

        # nodejs 的拆包依赖也解包，作为依赖库来源（ca-certificates 等无库包自动跳过）
        lib_dirs = [usr / "lib"]
        for dep in depends(fields):
            if dep == PACKAGE:
                continue
            dusr = unpack_package(dep, root / dep)
            if dusr is not None and (dusr / "lib").is_dir():
                lib_dirs.append(dusr / "lib")

        TARGET.mkdir(parents=True, exist_ok=True)
        (TARGET / "libnode.so").write_bytes(fix_elf_names(node.read_bytes()))

        # BFS 收集 node 及其依赖库的全部 bionic 动态依赖
        queue = needed(node)
        done = {"libnode.so"}
        while queue:
            original = queue.pop()
            if original in SYSTEM_LIBS:
                continue
            name = strip_version(original)
            if name in done:
                continue
            src = next((d / original for d in lib_dirs if (d / original).is_file()), None)
            if src is None:
                raise SystemExit(f"缺少依赖库: {original}")
            (TARGET / name).write_bytes(fix_elf_names(src.read_bytes()))
            done.add(name)
            queue |= needed(src)
        print(f"已生成 {len(done)} 个文件：", ", ".join(sorted(done)))
    finally:
        shutil.rmtree(root, ignore_errors=True)

    for item in sorted(TARGET.glob("*")):
        print(f"  {item.name}  {item.stat().st_size} 字节")


if __name__ == "__main__":
    sys.exit(main())
