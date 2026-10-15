# 工业微缩沙盘：第一版视觉调整

使中央 3D 场景与圆形工业终端协调。本版调整渲染、材质、光照和纹理，沿用已有模型结构。

- 取消低分辨率放大与 CSS 像素插值，启用抗锯齿，按视窗尺寸渲染；设备像素比上限为 2。
- 使用 PCF 阴影、2048 阴影贴图及弱补光，改善阴影边缘和模型暗部。
- 将结构色调整为中性绿灰、灰白，保留荧光黄交互提示；材质使用哑光金属参数。
- 地板取消明暗棋盘交替和重复铆钉，保留低对比接缝；墙板纹理采用线性与各向异性过滤。
- 提升世界标签的纹理分辨率，使用平滑文字，与界面字体协调。

## 验证

- `npm run check`、`npm run build`、`git diff --check` 通过。
- Chromium：1440×900、390×844、320×568，地图清晰显示，无横向溢出。
- 模拟 DPR 3 手机，292 CSS 像素视窗使用 584 像素绘图缓冲，符合 DPR 2 上限。
- 鼠标旋转、平移、原生滚轮；Chromium 原生触屏旋转及双指缩放；点击选格；四个方向共 16 次坐标点选通过。
- 相机复位前后的参数与截图像素一致；相机操作没有推进游戏状态。
- 模拟无 WebGL 2 时，平面地图正常显示。
- 合成展示覆盖 9 类设备、开关及门柜状态、搬运伤员、移除旧观察和未知回波。连续切换 60 次后 GPU 资源保持 3 个几何体和 11 张纹理，展示场景为 70 次绘制调用。
- 浏览器交互和合成场景检查的页面运行错误均为 0。未请求付费模型。

截图和一次性检查脚本位于忽略的 `output/playwright/`。实际手机 GPU、Safari 和 Firefox 尚未验证；高分辨率及柔和阴影会增加 GPU 开销。

## 预览

- [桌面改造前](../output/playwright/industrial-before-desktop.png)
- [桌面改造后](../output/playwright/industrial-after-1440.png)
- [手机改造后](../output/playwright/industrial-after-390.png)
- [高分屏手机](../output/playwright/industrial-after-mobile-hidpi.png)
- [完整设备展示，合成数据](../output/playwright/industrial-device-gallery.png)
