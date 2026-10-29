# 给 CodeBuddy 的任务书（整段复制到 CNB issue，@ 触发）

## 给你的操作指引（这部分不要贴进 issue）

1. 打开 https://cnb.cool/zhaolongwudi/dsh-phone → 「合并请求/议题」→ 新建议题（或用现有 issue）；
2. 把下面分隔线以下的内容**全部复制**进 issue 正文（CodeBuddy 要用代码块精确提取，保持 \`\`\` 围栏原样）；
3. 发送时在正文里 @ 触发 CodeBuddy（@codebuddy 或你平时用的触发方式）；
4. 它提交完成后告诉我结果，我来做定时任务同步和构建验证。

（注意：issue 里贴长 YAML 时确认代码块围栏完整，否则 AI 可能提取不完整。）

---

## 任务：向本仓库 main 分支提交 3 个文件的变更（不要走 git push，用你的内部提交通道）

### 背景
仓库的 HTTPS git push 当前被平台故障拦截（对象库缺对象），任何 git push 都失败；
因此请使用你能绕过 git push 的内部提交方式完成以下变更。

### 变更 1：整体替换根目录文件 \`.cnb.yml\` 为以下内容（一字不改）：

\`\`\`yaml
# DSH 手机版（Android）云原生构建
#
# 上游仓库（GitHub jwoo1982217-eng/dsh-phone，由定时任务自动同步）只发布源码，
# 不包含从其他 APK 提取的原生二进制。
# 本流水线负责补齐这些原生部分，再产出可安装的 debug APK：
#   1. 官方 Termux 软件包 -> Android arm64 Node 运行时与依赖库（校验 SHA256，不执行安装脚本）
#   2. 官方 Termux 软件包 -> Bash / ripgrep 及其依赖库（仓库自带脚本，同样校验 SHA256）
#   3. NDK r28c + Rust  -> libnoema.so / libdshflock.so / libdshlandlock.so
#   4. pnpm             -> 组装 dsh-tree.tar / dsh-home.tar 资源包
#   5. Gradle           -> :app:assembleDebug
#
# 构建节点必须是 amd64：Android SDK / NDK 的命令行工具只有 x86-64 Linux 版本。
main:
  # 手动触发（API）入口，与 push 使用同一份构建配置，避免两处维护
  api_trigger:
    - name: build-apk (manual)
      runner:
        tags: cnb:arch:amd64
        cpus: 16
      docker:
        image: ubuntu:24.04
        volumes:
          # Gradle 依赖与 wrapper 分发缓存，跨构建复用
          - main:/root/.gradle:copy-on-write
          # pnpm 内容寻址存储缓存
          - main:/root/.local/share/pnpm:copy-on-write
      env:
        # Android SDK / NDK 的安装位置，同时供 Gradle 与构建脚本读取
        ANDROID_HOME: /opt/android-sdk
        ANDROID_SDK_ROOT: /opt/android-sdk
        ANDROID_NDK_HOME: /opt/android-sdk/ndk/28.2.13676358
        JAVA_HOME: /usr/lib/jvm/java-17-openjdk-amd64
        # Gradle 与 pnpm 需要可写的 HOME
        GRADLE_USER_HOME: /root/.gradle
        DEBIAN_FRONTEND: noninteractive
      stages:
        - name: 安装构建工具
          script: |
            #!/bin/bash
            set -eux
            export DEBIAN_FRONTEND=noninteractive
            export TZ=Asia/Shanghai
            echo "$TZ" > /etc/timezone

            # CNB 构建容器把宿主机的 /etc/localtime 以只读方式绑定挂载进来
            # （mount 输出为 /dev/vda1 on /etc/localtime type ext4 (ro,noatime)），
            # 而基础镜像不含 tzdata；python3 经 libpython3.12-stdlib 硬依赖 tzdata，
            # 其 postinst 用 mv 覆盖该路径时必然 EBUSY 失败，并连累 python3 全系列
            # 报 “Errors were encountered while processing”。先尝试卸载该挂载。
            ls -la /etc/localtime || true
            mount | grep -i localtime || true
            umount /etc/localtime 2>/dev/null || true
            grep -q " /etc/localtime " /proc/mounts \
              && echo "localtime 仍为只读挂载点" || echo "localtime 已不再是挂载点"

            apt-get update
            PACKAGES="tzdata openjdk-17-jdk-headless python3 python3-venv \
              curl unzip zip xz-utils git ca-certificates build-essential"
            if ! apt-get install -y --no-install-recommends $PACKAGES; then
              # 无法卸载时，把 tzdata 的 postinst 换成空实现后重新配置；
              # 时区仍由 TZ 与 /etc/timezone 决定，不影响构建。
              echo "首次安装未完成，改用空 postinst 重新配置 tzdata"
              printf '#!/bin/sh\nexit 0\n' > /var/lib/dpkg/info/tzdata.postinst
              chmod 755 /var/lib/dpkg/info/tzdata.postinst
              dpkg --configure -a
              apt-get install -y --no-install-recommends $PACKAGES
            fi

            # Android 命令行工具（sdkmanager 等）
            mkdir -p "$ANDROID_HOME/cmdline-tools"
            curl -fsSL -o /tmp/cmdline-tools.zip \
              https://dl.google.com/android/repository/commandlinetools-linux-16111833_latest.zip
            unzip -q /tmp/cmdline-tools.zip -d /tmp/cmdline-tools-unpacked
            mv /tmp/cmdline-tools-unpacked/cmdline-tools "$ANDROID_HOME/cmdline-tools/latest"
            rm -rf /tmp/cmdline-tools.zip /tmp/cmdline-tools-unpacked

            export PATH="$ANDROID_HOME/cmdline-tools/latest/bin:$PATH"
            # compileSdk 36 需要 platforms;android-36；NDK 固定 r28c 与仓库文档一致
            # yes 收到 SIGPIPE 属正常；这里以 sdkmanager 的退出码为准
            yes | sdkmanager --sdk_root="$ANDROID_HOME" --licenses > /dev/null || true
            sdkmanager --sdk_root="$ANDROID_HOME" --install "platform-tools" "platforms;android-36" \
              "build-tools;36.0.0" "ndk;28.2.13676358"

            # Rust 与 Android 目标，用于编译 Noema 记忆引擎
            curl -fsSL https://sh.rustup.rs -o /tmp/rustup.sh
            sh /tmp/rustup.sh -y --default-toolchain stable --profile minimal
            . "$HOME/.cargo/env"
            rustup target add aarch64-linux-android

            # Node 与 pnpm：仓库要求 Node 22.19+ 或 24+，pnpm 10+
            curl -fsSL https://nodejs.org/dist/v22.19.0/node-v22.19.0-linux-x64.tar.xz -o /tmp/node.tar.xz
            tar -xJf /tmp/node.tar.xz -C /usr/local --strip-components=1
            npm install -g pnpm@10.34.6

            node -v
            pnpm -v
            java -version
            python3 -V

        - name: 准备原生运行时
          script: |
            #!/bin/bash
            set -eux
            # Node 运行时：官方 Termux nodejs 及其依赖，固定 SHA256
            python3 scripts/prepare-node-android.py
            # Bash / ripgrep 及其依赖：仓库自带脚本，固定 SHA256
            python3 scripts/prepare-native.py

            . "$HOME/.cargo/env"
            python3 scripts/build-noema-android.py
            python3 scripts/build-flock-android.py
            python3 scripts/build-landlock-android.py

            ls -l app/src/main/jniLibs/arm64-v8a/

        - name: 组装运行时资源
          script: |
            #!/bin/bash
            set -eux
            cd runtime
            pnpm install --frozen-lockfile --ignore-scripts
            cd ..
            python3 scripts/build-assets.py
            ls -l app/src/main/assets/

        - name: 编译 APK
          script: |
            #!/bin/bash
            set -eux
            export PATH="$ANDROID_HOME/cmdline-tools/latest/bin:$PATH"
            ./gradlew :app:clean :app:assembleDebug --no-daemon
            ls -l app/build/outputs/apk/debug/

        - name: 保存构建产物
          image: cnbcool/attachments:latest
          settings:
            # 上传到本次 commit 的附件，构建完成后可在仓库页面下载
            attachments:
              - "./app/build/outputs/apk/debug/app-debug.apk"

  # 构建结束后发送邮件通知（只含下载链接，不附带 APK）。
  # 放在 endStages 是因为它的成败不影响流水线最终状态：SMTP 异常或
  # 密钥尚未配置时，邮件任务标红，但已编译成功的构建仍为成功。
  # 凭据由密钥仓库注入，格式见 ci/README.md。
      endStages:
        - name: 邮件通知
          imports:
            - https://cnb.cool/zhaolongwudi/dsh-build-secrets/-/blob/main/mail.yml
          script: |
            #!/bin/bash
            set -eu
            python3 ci/notify-mail.py

  push:
    - name: build-apk
      runner:
        tags: cnb:arch:amd64
        cpus: 16
      docker:
        image: ubuntu:24.04
        volumes:
          # Gradle 依赖与 wrapper 分发缓存，跨构建复用
          - main:/root/.gradle:copy-on-write
          # pnpm 内容寻址存储缓存
          - main:/root/.local/share/pnpm:copy-on-write
      env:
        # Android SDK / NDK 的安装位置，同时供 Gradle 与构建脚本读取
        ANDROID_HOME: /opt/android-sdk
        ANDROID_SDK_ROOT: /opt/android-sdk
        ANDROID_NDK_HOME: /opt/android-sdk/ndk/28.2.13676358
        JAVA_HOME: /usr/lib/jvm/java-17-openjdk-amd64
        # Gradle 与 pnpm 需要可写的 HOME
        GRADLE_USER_HOME: /root/.gradle
        DEBIAN_FRONTEND: noninteractive
      stages:
        - name: 安装构建工具
          script: |
            #!/bin/bash
            set -eux
            export DEBIAN_FRONTEND=noninteractive
            export TZ=Asia/Shanghai
            echo "$TZ" > /etc/timezone

            # CNB 构建容器把宿主机的 /etc/localtime 以只读方式绑定挂载进来
            # （mount 输出为 /dev/vda1 on /etc/localtime type ext4 (ro,noatime)），
            # 而基础镜像不含 tzdata；python3 经 libpython3.12-stdlib 硬依赖 tzdata，
            # 其 postinst 用 mv 覆盖该路径时必然 EBUSY 失败，并连累 python3 全系列
            # 报 “Errors were encountered while processing”。先尝试卸载该挂载。
            ls -la /etc/localtime || true
            mount | grep -i localtime || true
            umount /etc/localtime 2>/dev/null || true
            grep -q " /etc/localtime " /proc/mounts \
              && echo "localtime 仍为只读挂载点" || echo "localtime 已不再是挂载点"

            apt-get update
            PACKAGES="tzdata openjdk-17-jdk-headless python3 python3-venv \
              curl unzip zip xz-utils git ca-certificates build-essential"
            if ! apt-get install -y --no-install-recommends $PACKAGES; then
              # 无法卸载时，把 tzdata 的 postinst 换成空实现后重新配置；
              # 时区仍由 TZ 与 /etc/timezone 决定，不影响构建。
              echo "首次安装未完成，改用空 postinst 重新配置 tzdata"
              printf '#!/bin/sh\nexit 0\n' > /var/lib/dpkg/info/tzdata.postinst
              chmod 755 /var/lib/dpkg/info/tzdata.postinst
              dpkg --configure -a
              apt-get install -y --no-install-recommends $PACKAGES
            fi

            # Android 命令行工具（sdkmanager 等）
            mkdir -p "$ANDROID_HOME/cmdline-tools"
            curl -fsSL -o /tmp/cmdline-tools.zip \
              https://dl.google.com/android/repository/commandlinetools-linux-16111833_latest.zip
            unzip -q /tmp/cmdline-tools.zip -d /tmp/cmdline-tools-unpacked
            mv /tmp/cmdline-tools-unpacked/cmdline-tools "$ANDROID_HOME/cmdline-tools/latest"
            rm -rf /tmp/cmdline-tools.zip /tmp/cmdline-tools-unpacked

            export PATH="$ANDROID_HOME/cmdline-tools/latest/bin:$PATH"
            # compileSdk 36 需要 platforms;android-36；NDK 固定 r28c 与仓库文档一致
            # yes 收到 SIGPIPE 属正常；这里以 sdkmanager 的退出码为准
            yes | sdkmanager --sdk_root="$ANDROID_HOME" --licenses > /dev/null || true
            sdkmanager --sdk_root="$ANDROID_HOME" --install "platform-tools" "platforms;android-36" \
              "build-tools;36.0.0" "ndk;28.2.13676358"

            # Rust 与 Android 目标，用于编译 Noema 记忆引擎
            curl -fsSL https://sh.rustup.rs -o /tmp/rustup.sh
            sh /tmp/rustup.sh -y --default-toolchain stable --profile minimal
            . "$HOME/.cargo/env"
            rustup target add aarch64-linux-android

            # Node 与 pnpm：仓库要求 Node 22.19+ 或 24+，pnpm 10+
            curl -fsSL https://nodejs.org/dist/v22.19.0/node-v22.19.0-linux-x64.tar.xz -o /tmp/node.tar.xz
            tar -xJf /tmp/node.tar.xz -C /usr/local --strip-components=1
            npm install -g pnpm@10.34.6

            node -v
            pnpm -v
            java -version
            python3 -V

        - name: 准备原生运行时
          script: |
            #!/bin/bash
            set -eux
            # Node 运行时：官方 Termux nodejs 及其依赖，固定 SHA256
            python3 scripts/prepare-node-android.py
            # Bash / ripgrep 及其依赖：仓库自带脚本，固定 SHA256
            python3 scripts/prepare-native.py

            . "$HOME/.cargo/env"
            python3 scripts/build-noema-android.py
            python3 scripts/build-flock-android.py
            python3 scripts/build-landlock-android.py

            ls -l app/src/main/jniLibs/arm64-v8a/

        - name: 组装运行时资源
          script: |
            #!/bin/bash
            set -eux
            cd runtime
            pnpm install --frozen-lockfile --ignore-scripts
            cd ..
            python3 scripts/build-assets.py
            ls -l app/src/main/assets/

        - name: 编译 APK
          script: |
            #!/bin/bash
            set -eux
            export PATH="$ANDROID_HOME/cmdline-tools/latest/bin:$PATH"
            ./gradlew :app:clean :app:assembleDebug --no-daemon
            ls -l app/build/outputs/apk/debug/

        - name: 保存构建产物
          image: cnbcool/attachments:latest
          settings:
            # 上传到本次 commit 的附件，构建完成后可在仓库页面下载
            attachments:
              - "./app/build/outputs/apk/debug/app-debug.apk"

      # 构建结束后发送邮件通知（只含下载链接，不附带 APK）。
      # 放在 endStages 是因为它的成败不影响流水线最终状态：SMTP 异常或
      # 密钥尚未配置时，邮件任务标红，但已编译成功的构建仍为成功。
      # 凭据由密钥仓库注入，格式见 ci/README.md。
      endStages:
        - name: 邮件通知
          imports:
            - https://cnb.cool/zhaolongwudi/dsh-build-secrets/-/blob/main/mail.yml
          script: |
            #!/bin/bash
            set -eu
            python3 ci/notify-mail.py

  # 每天 08:00 与 20:00（Asia/Shanghai）检查上游是否有新提交。
  # 有更新则合并并推送回本仓库，由上面的 push 流水线负责构建与邮件通知，
  # 因此构建步骤只有一份，定时任务本身不重复实现构建。
  # 定时任务只支持单一明确分支，不支持 glob；执行身份是最后修改本配置的用户。
  "crontab: 0 8,20 * * *":
    - name: sync-upstream
      runner:
        tags: cnb:arch:amd64
      docker:
        image: ubuntu:24.04
      env:
        # 上游改为 GitHub 上的最新发布仓库（公开仓库，匿名 HTTPS 拉取，无需任何令牌）。
        # 原先跟随的 CNB applecabal/dsh-phone 镜像不再使用。
        UPSTREAM_REPO: jwoo1982217-eng/dsh-phone
        MIRROR_REPO: zhaolongwudi/dsh-phone
        # 可选：日后若在 CNB 上建立了该 GitHub 仓库的镜像仓库（如
        # zhaolongwudi/dsh-phone-github-mirror），把「组织/仓库名」填到这里，
        # 同步将优先走 CNB 内网，稳定且快；留空则按 GitHub 直连 + 公共加速回退。
        UPSTREAM_CNB_MIRROR: ""
      stages:
        - name: 同步上游更新
          # 注意：CNB 不遵循脚本首行的 shebang，任务实际由 sh(dash) 执行，
          # 因此这里只使用 POSIX 语法（不用 PIPESTATUS、[[ ]] 等 bash 特性）。
          script: |
            #!/bin/bash
            set -eu
            export DEBIAN_FRONTEND=noninteractive
            apt-get update -qq
            apt-get install -y -qq --no-install-recommends git ca-certificates

            cd "$CNB_BUILD_WORKSPACE"
            git config user.name "dsh-build"
            git config user.email "dsh-build@users.noreply.cnb.cool"

            # 上游改为 GitHub 仓库（公开，匿名 HTTPS 读取，无需令牌）。
            # 定时任务的 CNB_TOKEN 只作用于本仓库，仅用于推送回 MIRROR_REPO。
            # 构建节点访问 GitHub 可能抖动，按顺序尝试多个地址：
            #   1) CNB 平台内镜像（UPSTREAM_CNB_MIRROR 非空时）
            #   2) GitHub 直连
            #   3) 公共加速前缀
            FETCH_URLS=""
            if [ -n "${UPSTREAM_CNB_MIRROR:-}" ]; then
              FETCH_URLS="$FETCH_URLS https://cnb.cool/${UPSTREAM_CNB_MIRROR}.git"
            fi
            FETCH_URLS="$FETCH_URLS https://github.com/${UPSTREAM_REPO}.git"
            for PFX in https://gh-proxy.com/ https://ghfast.top/ https://ghproxy.net/; do
              FETCH_URLS="$FETCH_URLS ${PFX}https://github.com/${UPSTREAM_REPO}.git"
            done

            FETCHED=""
            for U in $FETCH_URLS; do
              echo "尝试拉取上游：$U"
              if git fetch --no-tags "$U" main; then
                FETCHED="$U"
                break
              fi
            done
            if [ -z "$FETCHED" ]; then
              echo "所有上游地址均拉取失败，本次同步中止。"
              exit 1
            fi
            echo "已从 $FETCHED 获取上游 main。"

            # 上游提交已在本地历史中，说明没有新内容，本次不构建、不发邮件。
            if git merge-base --is-ancestor FETCH_HEAD HEAD; then
              echo "上游无新提交，跳过本次构建。"
              exit 0
            fi

            echo "检测到上游更新："
            git log --oneline HEAD..FETCH_HEAD | head -20

            # ── 保护清单机制（ci/upstream-guard.txt）────────────────────
            # 清单内路径在同步时一律以本仓库为准：
            #   1) 合并前备份清单内文件；
            #   2) 合并冲突时，清单内路径自动保留本仓库版本（其余冲突报人工）；
            #   3) 合并完成后无条件恢复清单内文件，覆盖「上游删除」与
            #      「自动合并吞掉本地改动」两类静默丢失，有变化则追加恢复提交。
            GUARD_FILE="ci/upstream-guard.txt"
            BACKUP="$(mktemp -d)"
            trap 'rm -rf "$BACKUP"' EXIT
            if [ -f "$GUARD_FILE" ]; then
              while IFS= read -r P || [ -n "$P" ]; do
                case "$P" in ''|'#'*) continue ;; esac
                if [ -e "$P" ]; then
                  mkdir -p "$BACKUP/$(dirname "$P")"
                  cp -r "$P" "$BACKUP/$P"
                fi
              done < "$GUARD_FILE"
            fi

            if git merge --no-edit FETCH_HEAD; then
              echo "上游合并完成。"
            else
              if [ -f "$GUARD_FILE" ]; then
                while IFS= read -r P || [ -n "$P" ]; do
                  case "$P" in ''|'#'*) continue ;; esac
                  if git status --porcelain -- "$P" | grep -Eq '^(UU|AA|DD|AU|UA|DU|UD)'; then
                    git checkout --ours -- "$P"
                    git add -- "$P"
                    echo "冲突路径已按保护清单保留本仓库版本：$P"
                  fi
                done < "$GUARD_FILE"
              fi
              if git status --porcelain | grep -Eq '^(UU|AA|DD|AU|UA|DU|UD)'; then
                echo "存在保护清单之外的合并冲突，需人工处理："
                git status --porcelain | grep -E '^(UU|AA|DD|AU|UA|DU|UD)'
                exit 1
              fi
              git commit --no-edit
              echo "冲突已按保护清单解决并完成合并提交。"
            fi

            # 合并完成后无条件恢复保护清单（含上游删除的情况）。
            if [ -f "$GUARD_FILE" ]; then
              RESTORED=no
              while IFS= read -r P || [ -n "$P" ]; do
                case "$P" in ''|'#'*) continue ;; esac
                if [ -e "$BACKUP/$P" ]; then
                  mkdir -p "$(dirname "$P")"
                  rm -rf "$P"
                  cp -r "$BACKUP/$P" "$P"
                  git add -A -- "$P"
                  if ! git diff --cached --quiet -- "$P"; then
                    RESTORED=yes
                    echo "已恢复保护路径：$P"
                  fi
                fi
              done < "$GUARD_FILE"
              if [ "$RESTORED" = yes ]; then
                git commit --no-edit -m "chore(ci): 同步上游后恢复保护清单内的本仓库定制"
              fi
            fi

            # 历史坑：合并会静默吞掉可执行位（mode 100755→100644，无内容 diff），
            # 推送前复查并恢复。
            if git ls-files -s gradlew desktop/start.command | grep -vq '^100755'; then
              chmod +x gradlew desktop/start.command
              git add gradlew desktop/start.command
              git commit --amend --no-edit
            fi

            # 推送回镜像仓库，触发上面的 push 流水线完成构建与邮件通知。
            # 此处不能带 [ci skip]，否则构建不会启动。
            git push "https://cnb:${CNB_TOKEN}@cnb.cool/${MIRROR_REPO}.git" \
              HEAD:refs/heads/main

            echo "已同步上游并触发构建。"
\`\`\`

### 变更 2：整体替换文件 \`ci/README.md\` 为以下内容（一字不改）：

\`\`\`markdown
# 构建自动化说明

本目录存放云原生构建用到的辅助脚本与配置说明。

## 自动化流程

```
定时任务（每天 08:00 / 20:00）
        │
        │  检查上游 jwoo1982217-eng/dsh-phone（GitHub）是否有新提交
        │  （GitHub 直连失败自动回退公共加速镜像）
        ▼
   有新提交？ ──否──▶ 结束，不构建、不发邮件
        │
       是
        ▼
  合并上游（保护清单内路径保留本仓库版本）并 push 回 main
        │
        ▼
push 流水线 build-apk（安装工具 → 原生运行时 → 资源 → 编译 APK → 上传附件）
        │
        ▼
   endStages 邮件通知（只发下载链接）
```

构建与邮件通知都挂在 `push` 流水线上，定时任务只负责「检测 + 同步 + 推送」，
因此构建步骤只有一份，手动 push 和定时同步走的是同一条流水线。

`main` 下另有 `api_trigger` 事件，stage 与 `push` 逐字一致，用于手动触发
（见「手动触发 APK 构建」）。改动构建步骤时两个事件都要同步。

## 上游同步与保护清单

上游在 2026-10-10 起由 CNB 镜像 `applecabal/dsh-phone` 改为 GitHub
`jwoo1982217-eng/dsh-phone`（最新发布仓库）。公开仓库匿名拉取，不需要任何令牌；
构建节点访问 GitHub 不稳定时自动按顺序回退公共加速前缀（gh-proxy.com、
ghfast.top、ghproxy.net）。日后若在 CNB 上建立了上游镜像仓库，把
「组织/仓库名」填入 `.cnb.yml` 定时任务环境变量 `UPSTREAM_CNB_MIRROR`，
即可优先走 CNB 内网拉取，最稳最快。

**保护清单** `ci/upstream-guard.txt`：每行一个路径。同步时这些路径一律以
本仓库为准——合并冲突自动保留本仓库版本；合并完成后无条件恢复，防止
上游删除或自动合并吞掉本地定制（`.cnb.yml`、`ci/`、构建脚本加固、
Gemini OAuth 密钥兜底等，清单内有逐项说明）。

两点注意：

1. 清单内文件收不到上游对它们的更新；需要跟进时人工对照上游改动手工合并。
2. 清单外的文件（如 `vendor/dsh-providers-hub/` 下的 Jet Hub 源码）正常
   三方合并：上游改、本地没改的部分自动取上游；双方都改过的文件若冲突，
   同步任务会失败并列出文件，**人工合并时不要简单 `checkout --ours`**，
   否则会丢掉上游功能（例如「在用模型」胶囊定制与上游面板大改重叠时，
   需要把胶囊接线重新移植到上游新代码上）。

## 邮件通知

### 配置 SMTP 凭据

邮件凭据不写入本仓库，而是放在**密钥仓库**中（密钥仓库不支持 git 克隆，
只能在网页上编辑）。

1. 打开密钥仓库 `zhaolongwudi/dsh-build-secrets`；
2. 在 `main` 分支新建 `mail.yml`，内容如下（QQ 邮箱示例）：

```yaml
# 收发都使用同一个 QQ 邮箱
SMTP_HOST: smtp.qq.com
SMTP_PORT: "465"
SMTP_USER: 245188127@qq.com
# QQ 邮箱的「授权码」，不是登录密码：设置 → 账户 → POP3/SMTP 服务 → 生成授权码
SMTP_PASSWORD: 你的授权码
MAIL_FROM: 245188127@qq.com
MAIL_TO: 245188127@qq.com

# 可选：限制只有本仓库的流水线能读取本文件（推荐）
allow_slugs: zhaolongwudi/dsh-phone
```

> `SMTP_PORT` 建议加引号写成字符串，避免被解析成数字。

字段说明：

| 字段 | 说明 |
| --- | --- |
| `SMTP_HOST` | SMTP 服务器地址 |
| `SMTP_PORT` | 端口，`465` 为隐式 SSL（本脚本用 `SMTP_SSL`） |
| `SMTP_USER` | 登录用户名 |
| `SMTP_PASSWORD` | 登录密码/授权码，QQ 邮箱必须填授权码 |
| `MAIL_FROM` | 发件人地址 |
| `MAIL_TO` | 收件人，多个用英文逗号分隔 |

> 需要多个收件人时写成 `a@x.com,b@y.com`。
> 换成其他邮箱服务商只需改 `SMTP_HOST` / `SMTP_PORT`；若服务商使用 587 端口的
> STARTTLS，需要相应调整 `ci/notify-mail.py` 中的连接方式。

### 邮件内容

邮件**只包含下载链接**，不附带 APK（APK 约 134 MB，超出多数邮箱的附件上限）。
正文包含：应用版本、提交短 SHA、分支、触发事件、APK 大小，以及下载按钮。
下载链接形如：

```
https://cnb.cool/zhaolongwudi/dsh-phone/-/commit-assets/download/<commit>/app-debug.apk
```

仓库为公开仓库，该链接可直接匿名下载。

### 邮件失败不影响构建

邮件任务放在 `endStages` 中。`endStages` 的成败**不计入**流水线最终状态：
凭据未配置、SMTP 不通等情况只会让「邮件通知」这个任务标红，
已经编译成功的 APK 仍会正常上传，流水线整体保持成功。

## 手动触发 APK 构建

`.cnb.yml` 里 `main` 下有 `push` 与 `api_trigger` 两个事件，stage 完全一致。
想让当前 `main` 重新出一个 APK，任选一种方式：

1. **调用 API 触发 `api_trigger`**（需要 `repo-cnb-trigger` 权限）：

   ```bash
   cnb build start-build --repo zhaolongwudi/dsh-phone --branch main \
     --event api_trigger
   ```

   仓库页面「流水线 → 运行」等价。**推荐这种**：不动 git 历史。
2. **向 `main` 推一次提交**：任何 push（含空提交 `git commit --allow-empty`）
   都会触发 `push` 流水线。仅在顺手带上代码改动时用。
3. **等定时任务**：每天 08:00 / 20:00 检查上游有新提交时自动构建
   （无更新不构建，指望不上）。

构建完成后 APK 作为该 commit 的附件可下载：

```
https://cnb.cool/zhaolongwudi/dsh-phone/-/commit-assets/download/<commit>/app-debug.apk
```

> `push` 与 `api_trigger` 用的是同一份 stage 定义，改构建步骤时**两个事件都要同步**。
> 另外 `start-build` 只接受 `api_trigger` 开头的事件名，传 `push` / `crontab`
> 会报 `Event must be apitrigger`。

## 「准备原生运行时」阶段超时（signal 9 / exit -1）

`prepare-node-android.py` 与 `prepare-native.py` 从 `packages.termux.dev`
下载已校验的 Termux 包。构建节点偶尔会短暂失去对该站点的 DNS／路由，
若下载函数没有重试与超时，脚本会一直阻塞，直到 runner 在**整阶段
10 分钟**时把进程 SIGKILL（日志表现为 `exit code: -1, signal: 9`）。

两个脚本统一使用 curl 下载：`--connect-timeout 30 --max-time 300
--retry 5 --retry-all-errors --retry-delay 5`。这样瞬时抖动会自动重试，
单次真正失败也会在 5 分钟内明确报错，而不是拖到阶段被杀。

同一 commit 历史上成功过一次（约 560s），说明流水线配置本身没问题；
再次失败时优先看该阶段日志里最先卡住的是哪个 `python3 scripts/*.py`。

## 「编译 APK」阶段 `./gradlew: Permission denied`（code 126）

`126` 表示文件存在但不可执行，即 `gradlew` 的可执行位丢了。仓库记录里
应为 `100755`，用 `git ls-files -s gradlew` 确认。

这个位**会在合并时被静默吞掉**：出现过一次合并提交，两个父提交都是
`100755`、blob 内容完全没变，合并结果却记成了 `100644`。这类变更没有
冲突、没有内容 diff，`git show` 只显示 `mode 100755,100755..100644`，
过 diff 时极易漏看。修复就是恢复可执行位：

```bash
chmod +x gradlew desktop/start.command
git add gradlew desktop/start.command   # 只提交 mode 变更，内容不变
```

不要在流水线里用 `chmod +x` 兜底：那只是掩盖问题，任何 clone / checkout
出来的文件仍不可执行。合并后建议复查一次 `git ls-files -s gradlew`。

## 「保存构建产物」阶段 403（APK 已编译成功但传不上去）

APK 编译成功、只在上传附件时失败，日志形如：

```
文件 .../app-debug.apk大小：140971553
请求失败: status:403; statusText:Forbidden; errcode:10023;
errmsg: The token's authorization scope does not match this request.
        Missing required scopes: repo-code:rw
第1次/第2次重试…… Request failed with status code 403
```

`./app/build/outputs/apk/debug/app-debug.apk` 已产出，缺的是把 commit 附件
写回仓库所需的 `repo-code:rw` 权限。**编译结果有效**，用 `api_trigger`
手动触发的构建尤其容易碰到：NPC 工作模式下 `CNB_TOKEN` 以只读为主，
写不回附件。这类失败**不要重新编译**（一次完整构建约 7.5 分钟），
先确认权限来源：

- 人工从仓库页面「流水线 → 运行」触发，或用有写权限的令牌调 `start-build`；
- `push` / 定时任务链路本身带写权限，正常不受影响。

## 本地校验

```bash
python3 -c "import yaml,sys; yaml.safe_load(open('.cnb.yml'))" && echo ".cnb.yml 语法正确"
python3 -m py_compile ci/notify-mail.py && echo "notify-mail.py 语法正确"
```

## 注意事项

- **任务脚本由 `sh`(dash) 执行，不遵循首行 shebang。** 虽然脚本里写了
  `#!/bin/bash`，但实测 `BASH_VERSION` 为空、`set -o pipefail` 不受支持，
  因此脚本中只能使用 POSIX 语法（不要用 `PIPESTATUS`、`[[ ]]`、数组等）。
- 定时任务按**平台时区**（`__ENV__TZ`）执行。本平台为东八区：构建记录里
  API 返回 `2026-10-08T21:58:42Z`（UTC）时，runner 日志显示 `05:58`，
  相差正好 8 小时，因此 `0 8,20 * * *` 即北京时间 08:00 与 20:00。
- 定时任务的 `CNB_TOKEN` 只对本仓库有效，无法通过 API 读取上游仓库，
  所以上游检测走匿名 HTTPS 的 git 协议。
- 定时任务的执行身份是**最后修改 `crontab` 配置的用户**，定时任务的
  同步/推送即以该身份进行；实测该身份下 push 触发的构建，
  触发者仍是仓库所有者本人（而非机器人账号），因此可以正常读取
  私有密钥仓库中的 `mail.yml`。
- 定时任务只支持**单一明确分支**，不支持 glob 表达式；最小间隔 5 分钟。
- 定时任务不会自动生效，修改 `.cnb.yml` 后需要同步一次：
  `POST /{repo}/-/build/crontab/sync/{branch}`（仓库页面「定时任务」处
  也有对应按钮）。
- 上游与本仓库同名但内容不同的文件，在保护清单内的自动保留本仓库版本；
  清单外的会冲突并导致定时任务失败，此时需要人工介入（不要简单取自己
  的版本，先确认上游改动是否需要一并保留，见「上游同步与保护清单」）。
\`\`\`

### 变更 3：新建文件 \`ci/upstream-guard.txt\`，内容如下（一字不改）：

\`\`\`text
# 上游同步保护清单
# 作用：本清单内的路径在定时同步上游时一律以本仓库为准，不会被上游覆盖或删除。
# 机制见 .cnb.yml 的 sync-upstream 任务：
#   1) 合并前备份清单内文件；
#   2) 合并冲突时，清单内路径自动保留本仓库版本（其余冲突报人工处理）；
#   3) 合并完成后无条件恢复清单内文件，覆盖「上游删除」与「自动合并
#      吞掉本地改动」两类静默丢失，有变化则追加一个恢复提交。
#
# 规则：
#   * 每行一个路径，相对仓库根；可写目录（如 ci/），整目录生效。
#   * # 开头为注释行，空行忽略。
#   * 只放「本仓库自有、不跟随上游」的定制；想继续接收上游更新的文件
#     不要放进来（例如 vendor/dsh-providers-hub/ 下的上游插件源码）。
#   * 清单内文件因此收不到上游对它们的更新；需要跟进时请人工对照上游
#     改动手工合并，再更新本仓库版本。
#
# 当前清单的由来：
#   .cnb.yml / ci/                 本仓库的云构建流水线（上游没有这些文件）
#   scripts/prepare-native.py      本仓库对 Termux 包下载加重试与超时的加固
#   scripts/prepare-node-android.py、native/termux-node.json
#                                  本仓库的 Android arm64 Node 运行时准备脚本
#   vendor/dsh-providers-hub/src/gemini-oauth.ts
#                                  保留内置 Google OAuth 客户端兜底；GitHub
#                                  公开上游已把该文件改为必须显式设置
#                                  CMDC_PAK_GOOGLE_CLIENT_ID/SECRET 环境变量，
#                                  直接合并会让 APK 的 Gemini 授权不可用。
#                                  上游若再改此文件，请人工对照合并。
.cnb.yml
ci/
scripts/prepare-native.py
scripts/prepare-node-android.py
native/termux-node.json
vendor/dsh-providers-hub/src/gemini-oauth.ts
\`\`\`

### 提交要求

- 提交信息（commit message）使用：

ci: 上游改拉 GitHub jwoo1982217-eng/dsh-phone，新增保护清单防自有定制被覆盖

- 三个文件在同一提交或连续提交均可；
- 提交后请逐个 cat 输出三个文件的前 20 行与总行数，让我核对；
- 除这三个文件外不要改动任何其他文件。

### 变更说明（供你理解，不必执行）

- 定时任务上游从 CNB applecabal/dsh-phone 切换为 GitHub jwoo1982217-eng/dsh-phone；
- 新增 ci/upstream-guard.txt 保护清单：同步上游时清单内路径一律保留本仓库版本；
- 合并后复查 gradlew / desktop/start.command 可执行位。
