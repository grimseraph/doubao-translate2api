# doubao-translate2api

将豆包网页翻译转换为 OpenAI Chat、OpenAI Responses 和 Anthropic Messages API，供翻译客户端调用。支持多 Cookie 管理、故障切换和按请求轮询。

仅提供文本翻译，不是通用聊天模型。

## 项目入口

| 入口 | 用途 |
| --- | --- |
| [Docker Hub 镜像](https://hub.docker.com/r/muzileee/doubao-translate2api) | 当前镜像，用于在 NAS 或服务器部署 API 服务 |
| [API 服务源码与完整部署文档](https://github.com/mu-zi-lee/doubao-translate2api) | 查看源码、Compose 模板、配置、升级和使用说明 |
| [Magpie 直连插件](https://github.com/mu-zi-lee/opencode-doubao-translate) | 在 Magpie 中导入豆包 Cookie，直接翻译，无须部署 API 服务或 Docker |

服务版和插件版共用翻译核心，可按使用场景选择。需要管理页、Cookie 池、API Key 或为多个客户端提供服务时，部署此镜像；只在 Magpie 中翻译时安装直连插件即可。

## Docker 部署

镜像：`muzileee/doubao-translate2api:latest`，支持 AMD64 / ARM64。

1. 下载 [NAS Compose 模板](https://github.com/mu-zi-lee/doubao-translate2api/blob/main/docker-compose.nas.yml)，保存为项目目录中的 `docker-compose.yml`，或粘贴到 NAS 的 Compose 创建窗口。
2. 准备数据目录并启动：

```sh
mkdir -p data/admin
sudo chown 1000:1000 data/admin
sudo chmod 700 data/admin
docker compose up -d
```

3. 打开 `http://服务器IP:8390/admin`。

默认运行用户为 `1000:1000`，需与数据目录所有者匹配。只在本机访问时，使用 [本机 Compose 模板](https://github.com/mu-zi-lee/doubao-translate2api/blob/main/docker-compose.hub.yml)。公网部署请使用 HTTPS 反向代理。

## 首次使用

查看自动生成的管理密码：

```sh
docker compose exec doubao-translate2api cat /admin-data/initial-password.txt
```

登录管理页后，在「Cookie 池」导入本人或已获授权的豆包 Cookie 并检测有效性，再到「连接」复制 API Key。

| 客户端 / 协议 | Base URL |
| --- | --- |
| OpenAI Chat / Responses | `http://服务器IP:8390/v1` |
| Anthropic 官方 SDK | `http://服务器IP:8390` |

模型可选 `doubao-ai`、`volcengine-translate`、`microsoft-translator`，均通过豆包网页接口调用。默认翻译为简体中文，可在管理页修改。

Cookie 过期后需手动更新。升级时保留并备份 `data/admin`，其中包含 Cookie、管理凭据和 API Key，请勿公开。

## Magpie 直连安装

在 Magpie「插件 → 发现」底部的安装框填写：

```text
github:mu-zi-lee/opencode-doubao-translate
```

安装后选择 **Doubao Translation → Import Doubao Cookie**，模型选择 `doubao-translate/doubao-ai`。这种方式直接调用豆包，无须部署此镜像。

## 更新

```sh
docker compose pull
docker compose up -d
```

运行中的容器不会自行升级。完整配置与恢复说明见 [API 服务 README](https://github.com/mu-zi-lee/doubao-translate2api#readme)。

## 免责声明

本项目是非官方实现，与豆包及其他相关平台不存在隶属或合作关系。仅使用本人或已获合法授权的账号与 Cookie，并遵守适用法律法规及相关平台服务条款。

软件按 MIT 许可证以「现状」提供，不保证接口持续可用、翻译准确、账号安全或适用于特定用途。使用前请阅读 [完整免责声明](https://github.com/mu-zi-lee/doubao-translate2api#readme) 和 [MIT 许可证](https://github.com/mu-zi-lee/doubao-translate2api/blob/main/LICENSE)。
