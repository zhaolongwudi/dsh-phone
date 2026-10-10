"""维护 README 末尾的 APK 下载链接区块（自动生成，请勿手改区块内容）。

用法：python3 apk-link.py [README 路径] [release tag]
不传 tag 时生成"暂无产物"占位区块。
"""
import re
import sys
from pathlib import Path

README = Path(sys.argv[1]) if len(sys.argv) > 1 else Path("README.md")
TAG = sys.argv[2].strip() if len(sys.argv) > 2 else ""
BEGIN = "<!-- APK-LINK:BEGIN -->"
END = "<!-- APK-LINK:END -->"

if TAG:
    raw = f"https://github.com/zhaolongwudi/dsh-phone/releases/download/{TAG}/app-debug.apk"
    proxy = "https://gh-proxy.com/" + raw
    block = (
        f"{BEGIN}\n"
        "## 📱 最新 APK（每日自动构建，debug 签名）\n\n"
        f"- 国内加速下载：{proxy}\n"
        f"- GitHub 直链：{raw}\n\n"
        f"- 构建版本：`{TAG}`\n\n"
        f"{END}"
    )
else:
    block = (
        f"{BEGIN}\n"
        "## 📱 最新 APK\n\n"
        "暂无构建产物，等待 build-apk 流水线完成首次构建。\n\n"
        f"{END}"
    )

text = README.read_text(encoding="utf-8")
if BEGIN in text and END in text:
    text = re.sub(re.escape(BEGIN) + r".*?" + re.escape(END), block, text, flags=re.S)
else:
    text = text.rstrip("\n") + "\n\n" + block + "\n"
README.write_text(text, encoding="utf-8")
print("README 下载区块已更新 ->", TAG or "占位")
