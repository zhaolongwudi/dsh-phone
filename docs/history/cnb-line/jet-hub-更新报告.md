# Jet Hub 插件更新报告

日期：2026-10-07
目标：把手机 DSH 内置插件 `dsh-codearts-auth`（显示名 "Jet Hub"）更新到 npm 最新版。

## 结果

| 项 | 值 |
|---|---|
| 更新前 | 0.1.0（APK 厂商私有构建） |
| 更新后 | **1.0.261007**（npm 最新，= gitee `iJetLi/deepseek-harness-codearts` master） |
| 安装位置 1 | `$DSH_HOME/profiles/phone/node_modules/dsh-codearts-auth` |
| 安装位置 2 | `$TREE/node_modules/dsh-codearts-auth`（运行时实际加载的那份） |
| 来源 | `https://registry.npmjs.org/dsh-codearts-auth/-/dsh-codearts-auth-1.0.261007.tgz` |
| 完整性 | `sha512-JA30yjsusRm12mJSd1Vm2WaR8ofbkqRVP+T82cgwTujuXqLrvOlypkr0WbKHUS+yeENTEe/8GrYKn7Dio5DOhw==`（与 registry 一致） |

## 验证（全部通过）

- 下载包 sha512 与 npm registry 记录一致
- `import()` 成功：162 个模块、450 条相对 import 全部解析，无缺失
- DSH 兼容性闸门：`evaluatePluginCompatibility` = compatible（宿主 0.2.1-alpha.1）
- `dsh --profile phone --dump-config` 正常组合配置树
- 账号数据完好：`jet-hub/state.json` 13 个账号原样保留，
  其中 `AutoClaw (0811)` 记录经新版的 `sanitizeAccounts` 处理后仍保留

## 本次更新带来的变化

新增：Gemini provider（Google Cloud Code Assist）、用量账本 token-ledger、
auto-adapter 自动选号、loop-recovery 思考死循环续跑、reasoning-ladder、
refresh-scheduler、dead-model-store、trae/lobsterai 积分等。

**移除**（公开上游没有这两项，属厂商私有分支功能）：
- AutoClaw（智谱 `autoglm-acceleration-api.zhipuai.cn`）
- ChatGPT 会员面板（`chatgpt-plan/*`）

## 遗留事项

`profiles/phone/cordis.patch.yml` 中仍有 4 条 `autoclaw/*` 模型条目
（`zai_auto`、`zai_auto-fast`、`zaicoding_glm-5.3`、`zai_glm-5.3-flash`）。
新版插件不再注册 `autoclaw` provider，选中这些条目会失败。
未擅自删除用户配置；如需清理请告知。

## 回滚方法

回滚素材（已校验与线上 0.1.0 逐字节一致）：
```
$DSH_HOME/jet-hub-update-backup/2026-10-07/
├── dsh-codearts-auth-0.1.0-installed.tgz      # 更新前完整备份
├── dsh-codearts-auth-1.0.261007.tgz           # 本次使用的新包
└── prev/
    ├── tree-dsh-codearts-auth/                # 旧版 tree 副本（原样）
    └── profile-dsh-codearts-auth/             # 旧版 profile 副本（原样）
```

回滚步骤：
1. 停止 DSH 服务
2. 把 `prev/tree-dsh-codearts-auth` 覆盖回 `$TREE/node_modules/dsh-codearts-auth`
3. 把 `prev/profile-dsh-codearts-auth` 覆盖回 `$DSH_HOME/profiles/phone/node_modules/dsh-codearts-auth`
4. 重新启动 DSH

（`$TREE` = `/data/data/com.dshphone/files/tree`，
 `$DSH_HOME` = `/data/data/com.dshphone/files/dsh-home`）
