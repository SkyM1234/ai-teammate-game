# 共享美术库

游戏界面保留现有圆盘布局。角色、物资、地形与特效从 `StationRenderer` 提取到 `apps/web/src/art/`，所有地图使用同一组模型制作函数。

| 模块 | 职责 |
| --- | --- |
| `resources.ts` | 共享几何体、材质、程序纹理、文字标签、局部合批，以及 GPU 资源释放 |
| `characters.ts` | `createRobot()`、`createHuman()`；返回可独立移动的模型组 |
| `props.ts` | `createProp()`；按已观察实体的 `type`、`itemType`、`state` 选择模型和状态 |
| `terrain.ts` | `createTerrain()`；根据公开平面图生成甲板、墙板、房间边界和出口 |
| `effects.ts` | 选格框、回波框和出口漏气模型 |
| `themes.ts` | 语义色、环境主题、关卡主题引用 |

`StationRenderer` 负责相机、点选、坐标变换、感知范围和状态同步。模型函数在局部原点制作物体，由调用方设置世界位置；函数不读取完整关卡实体，也不自行计算游戏规则。

## 新增地图时如何复用

关卡仍在 `content/levels/` 描述墙地布局与实体。现有实体通过类型自动得到外观，例如：

```json
{ "id": "s-10", "type": "supply", "name": "氧气补给", "position": { "x": 3, "y": 4 }, "itemType": "oxygen", "reflection": 1 }
```

无需复制模型代码。需要环境变色时，在 `themes.ts` 的 `levelArt` 添加引用：

```ts
'station-02': { theme: 'cold' },
```

未配置的地图默认使用 `industrial`。主题控制墙体、盖板和不同感知距离的地面色；氧气青色、电池黄色、维修箱橙色，以及危险、交互和角色标识跨地图保持一致。房间颜色仍由 2D 与 3D 共享。

新增环境主题只需要补齐 `StationTheme` 的颜色字段。新增同类物资会自动复用当前模型；新增外观或设备模型应放入 `props.ts`，不要添加到地图数据中。当前没有为尚未使用的皮肤或外部 GLB 加载器引入额外接口。

地形可以接收不同宽高的公开地图。本轮展示了 12×12、9×14 两种布局；正式游戏的 HTTP 坐标校验和部分 UI 仍针对 12×12，添加可玩的大尺寸关卡时需要另行扩展这些边界。

## 制作约定

- 模型单位沿用一格一单位，局部 Y 轴朝上。位置和状态由渲染器传入，调整视觉大小不能改变交互坐标。
- 使用 `ArtResources.box/tank/ball` 和语义色制作零件。相同颜色可以通过 `paint`、`metal`、`rubber`、`glass` 区分表面，材质缓存按颜色和表面类型共同索引。
- 角色和物资使用轮廓、色块及几何标识共同区分。氧气为双瓶＋青色瓶肩，电池为立式模块＋双端子，维修箱为橙色提手箱＋十字。状态变化仍来自 `ObservedEntity.state`。
- 公共装饰只能依赖公开地图。隐藏物资、柜内物品和危险设备必须在被观察后才实例化，未知回波保留抽象标记。
- `batchMeshes()` 适用于状态确定后的静态零件。独立运动的零件不要合入父模型的静态批次；目前门柜在观察状态变化时重建。
- 每个渲染器持有一个资源池；多个模型共享其中的几何体和材质。`clear(group)` 释放实例缓冲与每个标签自己的材质，保留共用资源供下一张地图使用。最终 `StationRenderer.dispose()` 清理所有模型、资源池和阴影贴图。

## 美术预览

```powershell
npm run art:preview
```

打开 **http://127.0.0.1:4322**。可切换环境主题、地图布局、门柜开合、开关、线缆、控制器修复及搬运伤员状态；支持旋转、平移和缩放。预览页只使用合成观察，不启动游戏服务、不读取存档、不调用模型。

页面和样本位于 `apps/art-gallery/`，独立构建到忽略的 `output/art-preview/`。修改代码后重启命令以重新构建。端口可通过 `ART_PREVIEW_PORT` 设置。

## 验证

`npm run check`、`npm run build`、`npm test`。`tests/art.test.ts` 检查资源所有权、同类模型共享以及嵌套零件合批后的变换。

2026-10-16 验证结果：类型检查、构建及全部 100 项测试通过。Chromium 中两种布局与设备状态连续切换 60 次，GPU 计数保持 5 个几何体、13 张纹理；四个朝向的 16 次坐标点选通过。移除旧观察、未知回波、搬运伤员、出口修复及冷色主题检查通过。销毁时资源池的全部 10 张纹理和阴影目标均释放；Three.js 内部共享的 Sprite 几何体与 BRDF 查找纹理仍计入其统计，不属于地图资源池。

正式页面检查了 1440×900、390×844、320×568，手机无横向溢出；模拟无 WebGL 2 时平面地图正常。预览与截图检查未调用付费模型，未验证真实手机 GPU、Safari 或 Firefox。

截图位于忽略的 `output/playwright/`：`art-library-gallery.png`、`art-library-cold-long.png`、`art-library-mobile.png`、`art-library-game-1440.png`、`art-library-game-390.png`、`art-library-game-320.png`、`art-library-fallback-390.png`。
