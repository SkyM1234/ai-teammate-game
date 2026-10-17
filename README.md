# LAST OXYGEN · 最后的氧气

基于 [Pi Agent](https://github.com/earendil-works/pi) 的 AI 队友救援游戏原型。

你受伤后无法移动，氧气正在流失。你需要通过对话、共享标记和资源取舍，指挥机器人 R-07 探索空间站、取得补给、修复气闸，最终把你搬运到出口撤离。游戏使用 Three.js 呈现空间站，并提供无需模型凭据的本地规则演示。

## 仓库结构

```text
.
├── README.md
├── ai-teammate-game/   # 游戏源码、地图、文档和测试
└── pi-main/            # Pi 上游源码及其 MIT 许可证
```

游戏直接复用相邻 `pi-main` 中的构建工具、Agent、模型接口和凭据管理模块。请下载或克隆整个仓库，保持这两个目录同级及名称不变。

## 环境要求

- Node.js **24.4 或更新版本**，以及随附的 npm。
- 支持现代 JavaScript 的浏览器；推荐支持 WebGL 2 的浏览器，以使用 3D 场景。
- 首次安装依赖需要联网。

可用以下命令检查环境：

```shell
node --version
npm --version
```

## 首次安装与启动

下载并解压仓库，或使用 Git 克隆后，在仓库根目录打开终端。按顺序执行以下命令，每一步成功后再执行下一步。

先安装并构建 Pi：

```shell
cd pi-main
npm ci
npm run build:offline
```

`build:offline` 使用仓库已有的模型目录数据进行构建；这里的 offline 不表示安装依赖可以离线。如果提示模型数据缺失或过期，在当前 `pi-main` 目录执行 `npm run build`，联网生成模型数据并完成构建。

然后安装并启动游戏：

```shell
cd ../ai-teammate-game
npm ci
npm run dev
```

浏览器打开 **http://127.0.0.1:4317**。保持终端运行，按 `Ctrl+C` 停止服务。

`npm run dev` 会先构建游戏前端，再启动本地服务，无需另开终端运行 Pi CLI。

## 开始游玩

首次启动默认使用本地规则演示，**不请求模型，也没有模型调用费用**，仍通过 Pi Agent 执行工具与生命周期钩子。可以在“救援目标”中使用“规则通关”体验当前地图的预设救援流程。

要使用 AI 队友对话，在页面的“模型设置”中选择服务商和模型，并配置你自己的凭据。游戏也支持读取本机已有的 Pi 凭据。实际模型调用可能产生对应服务商的费用。

操作说明、模型设置和存档说明见 [游戏 README](ai-teammate-game/README.md)，地图介绍见 [地图资料](ai-teammate-game/docs/maps/README.md)。

## 后续启动

首次安装与构建完成后，在仓库根目录执行：

```shell
cd ai-teammate-game
npm run dev
```

游戏启动时会重新构建前端。更新 Pi 源码后，需要重新在 `pi-main` 中构建；依赖锁文件更新后，需要在对应目录重新执行 `npm ci`。

## 开发命令

在 `ai-teammate-game` 目录中运行：

| 命令 | 用途 |
| --- | --- |
| `npm run dev` | 构建前端并启动游戏 |
| `npm run build` | 仅构建游戏前端 |
| `npm run check` | TypeScript 类型检查 |
| `npm test` | 运行游戏测试 |
| `npm run art:preview` | 启动共享美术库预览 |

如果默认端口被占用，可以在 PowerShell 中指定其他端口：

```powershell
$env:PORT = '4318'
npm run dev
```

然后访问 http://127.0.0.1:4318。

## Pi 来源与许可证

本项目使用 Mario Zechner 等贡献者开发的 [Pi](https://github.com/earendil-works/pi)。`pi-main` 中的 Pi 代码采用 **MIT License**，原版权声明为 `Copyright (c) 2025 Mario Zechner`，完整许可证见 [pi-main/LICENSE](pi-main/LICENSE)。

MIT 许可证允许使用、修改和再分发 Pi，包括商业使用；复制或分发 Pi 代码或其实质性部分时，必须保留原版权声明及完整许可证。其他第三方依赖遵循各自的许可证。Pi 的 MIT 许可证不自动为本项目的原创游戏代码授予许可。
