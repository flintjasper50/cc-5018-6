# 软件操作演示直播

把桌面实时共享给观看者，并且让观看者**能看清编辑器里的字、跟得上滚动**。
采集与传输都是浏览器原生能力（`getDisplayMedia` + WebRTC），
媒体经自带的 STUN/TURN 中继转发，不是录屏后转码分发。

- **自适应**：根据画面变化面积决定捕获帧率，根据链路带宽决定编码分辨率与码率上限。
  所有决策都作用在**实际发送**的内容上（采集约束、轨道帧率、发送端编码参数），
  不靠缩小网页预览来伪装。
- **控制环**：中值滤波 + 非对称 EWMA + 斜率限制 + 迟滞 + 保持期，
  降档快、升档慢；带宽刚恢复时逐档试探，不会直接拉满再拥塞。
- **最低清晰度**：硬下限 640×360，到限会给出明确的降级提示。
- **可验证**：自带演示素材页（细字 / 平滑滚动 / 动态图表 / 机器可读校准带），
  记录实际发送帧、编码尺寸、接收统计、端到端延迟与文字可读性，
  并保存两端同一区域的对比图。可读性用裁剪图内部的对比度与字形高度衡量，
  不用单一平均码率代替观看质量。

## 快速开始

```bash
npm install                      # 仅实验脚本需要 playwright-core
./scripts/dev-up.sh              # Web 信令 + TURN 中继
# 打开 http://127.0.0.1:8080/presenter.html?room=DEMO  → 加入房间 → 开始共享
# 打开 http://127.0.0.1:8080/viewer.html?room=DEMO    → 加入观看
```

## 文档

- [两端操作流程](docs/operations.md)：演示者 / 观看者的完整步骤，以及各种异常状态的表现。
- [弱网实验报告](docs/weak-network.md)：带宽塌缩与恢复、静止与动画的帧率差异、
  清晰度下限、生命周期状态；延迟与文字可读性**分开评估**。

## 复现实验

```bash
./scripts/fixture-up.sh                                  # 把验证素材铺到虚拟屏幕
node scripts/experiment.mjs --scenario all --run my-run  # 跑五个场景
node scripts/report.mjs evidence/my-run                  # 生成汇总表
```

证据写入 `evidence/<run>/`：每个场景一份逐秒采样 JSON，以及
`*-presenter-full.png` / `*-viewer-full.png` / `*-strip-*.png` / `*-text-*.png`。

## 组成

```
public/presenter.html      演示者：采集、自适应、发送统计、状态机
public/viewer.html         观看者：解码、延迟与可读性测量、状态机
public/fixture.html        验证素材：细字代码 + 平滑滚动 + 动态图表 + 校准带
public/shared/adaptive.js  自适应控制器（帧率环 + 码率/分辨率环 + 试探）
public/shared/calib.js     校准带编解码与可读性指标
public/shared/rtc.js       信令客户端与 PeerConnection 工具
server/signaling.mjs       信令与静态服务
server/turn.mjs            STUN/TURN 中继 + 可注入的链路整形
server/stun.mjs            STUN 编解码
scripts/experiment.mjs     实验驱动
scripts/report.mjs         证据汇总
```
