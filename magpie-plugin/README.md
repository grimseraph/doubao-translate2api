# Doubao Translation for Magpie

直接使用本人或已获授权的豆包 Cookie 翻译文本，无须部署 doubao-translate2api 服务、Docker 或额外 API Key。
这是非官方实现，与豆包、Magpie 无隶属或合作关系。服务条款、账号风险及 MIT 免责声明同主项目。

## 项目入口

| 入口 | 用途 |
| --- | --- |
| [Magpie 直连插件](https://github.com/mu-zi-lee/opencode-doubao-translate) | 当前插件的发布仓库，可由本机或远端 Magpie 直接安装 |
| [API 服务源码与部署文档](https://github.com/mu-zi-lee/doubao-translate2api) | 在 NAS 或服务器部署，向多个翻译客户端提供兼容 API |
| [Docker Hub 镜像](https://hub.docker.com/r/muzileee/doubao-translate2api) | 拉取 `muzileee/doubao-translate2api` 部署 API 服务 |

服务版和插件版共用翻译核心，可按使用场景选择。只在 Magpie 中翻译时安装本插件即可；需要管理页、Cookie 池、API Key 或为多个客户端提供服务时，使用 API 服务或 Docker 镜像。

## 直接安装（远端也适用）

在 Magpie「插件 → 发现」底部的安装框填写：

```text
github:mu-zi-lee/opencode-doubao-translate
```

点击安装，再进入「已安装」或「供应商」，选择 **Doubao Translation** 的 **Import Doubao Cookie** 登录。
也可以在运行 Magpie 的机器上使用 CLI：

```sh
magpie plugin add github:mu-zi-lee/opencode-doubao-translate
magpie plugin login doubao-translate
```

GitHub 发布仓库包含已构建的插件和运行时依赖，无须 Node.js 开发环境、Docker 或额外构建步骤。
固定版本时填写 `github:mu-zi-lee/opencode-doubao-translate#v0.1.0`。
更新时在 Magpie 中更新插件，或运行 `magpie plugin update`。

## 从本地主项目构建

在主项目目录运行：

```sh
npm ci
npm run build:plugin
magpie plugin add ./magpie-plugin
magpie plugin login doubao-translate
```

也可以在 Magpie 的「插件 → 添加插件」填写 `magpie-plugin` 文件夹的绝对路径。
文件夹必须先构建；插件包已包含运行时依赖，无安装脚本。

登录时粘贴完整 Cookie Header 或浏览器导出的 Cookie JSON，可填写账号名称。
必须包含 `sessionid`、`sid_tt` 和 `uid_tt`，登录时会请求豆包检测有效性。
每次登录可添加一个账号，调度与故障切换交给 Magpie。
登录信息保存在 Magpie 配置目录的 `plugin-auth.json`（权限 600），包括规范化 Cookie 和账号名称；请勿分享此文件。
插件使用自定义导入流程，检测成功后保存 Cookie，不需要额外填写 API Key 或打开登录浏览器。
Cookie 过期需要重新导入，不提供自动登录或续期。

## 模型与翻译

| 模型 | 引擎 |
| --- | --- |
| `doubao-translate/doubao-ai` | 豆包 AI 翻译 |
| `doubao-translate/volcengine-translate` | 火山翻译 |
| `doubao-translate/microsoft-translator` | 微软翻译 |

三者都通过豆包网页接口调用。供应商使用 Chat Completions，Magpie 负责转换客户端协议。
默认目标语言为简体中文。请求的 `target_lang`、`X-Doubao-Target-Lang` 或明确翻译指令优先于插件默认值。
只翻译最后一条 user 文本，不支持对话记忆、图片、工具、推理或结构化输出。
在翻译客户端显式选择上述模型，避免将其用于聊天、编程或自动路由的通用任务。
模型的 32000 token 输入/输出预算是保守的网关配置，不代表上游额度或精确的字符限制。

长文本自动分段并按原顺序还原换行；全部成功后才返回结果。
流式请求在完整翻译成功后输出 SSE，不是逐 token 实时翻译。
token usage 为 0，未提供可验证的上游套餐额度，不上报虚构用量。
插件不保存原文、译文或独立统计文件。

## 选项

在 Magpie 的插件配置 `options` 中设置，或使用 CLI：

```sh
magpie plugin options opencode-doubao-translate '{"targetLang":"en","maxConcurrency":4}'
```

| 选项 | 默认值 | 含义 |
| --- | --- | --- |
| `targetLang` | `"zh"` | 默认目标语言 |
| `scene` | `2` | 豆包翻译场景，1–6 |
| `maxConcurrency` | `4` | 插件上游总并发及 Magpie 每账号建议上限，1–1000 |
| `requestTimeoutMs` | `45000` | 单次上游请求超时 |
| `totalTimeoutMs` | `180000` | 包含排队、分段与重试的总超时 |
| `authTimeoutMs` | `10000` | 登录检测超时 |
| `maxRetries` | `0` | 单批临时故障重试，0–10；默认交给 Magpie 故障切换 |
| `queueMax` | `100` | 插件内部最大排队数 |
| `queueTimeoutMs` | `30000` | 排队超时 |

修改后关闭再开启插件，使供应商选项重新加载。
插件不读取独立服务的 `.env`、Cookie 文件或账号池。
豆包登录失效返回 `X-Magpie-Sign-In: expired`；HTTP 429 保留为 429，其他失败使用兼容 API 错误格式。
网络或服务临时故障不会标记登录过期。代理使用 Magpie 的账号/供应商代理配置。

## 检测与打包

```sh
magpie provider test doubao-translate doubao-ai
```

该命令验证连通性，翻译验收还应明确发送目标语言和原文。
开发检查使用主项目的 `npm run typecheck`、`npm test` 和 `npm run build`。
本地 mock 和 Bun 加载检查不代表真实 Magpie、Cookie 或豆包翻译验收。
官方 Magpie Bun 插件宿主的模拟上游检查已覆盖加载、Cookie 登录保存和流式返回；真实豆包与远端客户端仍需验收。
插件打包了 Zod，其 MIT 许可证在 `THIRD_PARTY_LICENSES.txt`。

构建后可以创建独立 npm 包，无须运行安装脚本：

```sh
npm pack ./magpie-plugin
```

当前通过 GitHub 发布仓库安装，未发布到 npm 或插件推荐市场。
