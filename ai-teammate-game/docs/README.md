# 项目文档

## 当前制作与使用说明

- [地图资料](maps/README.md)：正式地图、运行预算、游戏内规则通关、验证结果。
- [地图制作](maps/authoring.md)：新增 JSON、不同尺寸、资源、预算、通关路线和存档。
- [通关说明](maps/walkthroughs.md)：每张地图的主路线与备用策略。
- [共享美术库](art-library.md)：跨地图复用模型、墙面材质、主题及预览工具。

地图配置以 `content/levels/*.json` 为准；逐动作结果通过 `npm run verify:routes` 更新到 [maps/route-ledgers.json](maps/route-ledgers.json)。

## 历史评审与阶段记录

以下文件保留当时的方案与验证结果，不作为当前地图尺寸、物资位置、预算或通关结果的依据：

- [2026-10-14 优化评审](optimization-review-2026-10-14.md)
- [2026-10-14 前端与 3D 评审](frontend-pixel-3d-review-2026-10-14.md)
- [2026-10-15 模型甲板记录](models-deck-2026-10-15.md)
- [2026-10-15 场景风格记录](scene-style-2026-10-15.md)
