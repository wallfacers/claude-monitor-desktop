# 猫咪宠物形态(Cat Pet Mode)设计

日期:2026-06-17
状态:已批准设计,待写实现计划

## 目标

在现有「药丸条(pill)」「列表面板(list)」之外,新增**第三形态「猫咪(cat)」**:一只活在透明悬浮窗里的 SVG 矢量卡通猫,用**情绪和动作**反映 Claude Code 监控状态。少女心风格(粉嫩配色 + 可选小配饰)。

**硬约束:不丢任何现有功能。** 三状态计数、待确认闪烁+响铃+自动展开、消音🔔、移除记录✕、卡住检测、离线标、完成蓝闪、鼠标穿透降透明度、托盘重配钩子 toast —— 全部保留并复用。猫只是新增的一层皮,所有原始信息照样可达(角标显示数字 + 单击展开完整列表)。

**核心理念:** 药丸/列表是「仪表盘」,猫是「会撒娇的提醒员」——平时趴着省心,有事用动作戳你,而不是逼你盯数字。

## 形态与切换

三形态互斥(`[hidden]` 控制,沿用现有约定),同一时刻只显示一个:

- `pill` —— 现有药丸条(默认)
- `list` —— 现有列表面板
- `cat` —— 新增猫咪

**切换方式:托盘菜单**。托盘加一级子菜单「外观 ▸ 药丸 / 列表 / 猫咪」(单选,带勾)。选择持久化到设置,启动时按上次选择恢复;无记录时默认 `pill`。

注意:`list`(展开)在现有逻辑里是「有新待确认时自动展开」的目标态。猫咪态下「单击猫」也展开到 `list`。即 `list` 既是用户可选的常驻形态,也是 pill/cat 的「展开详情」目标。形态切换统一收敛为 `setMode('pill'|'list'|'cat')`,取代现有布尔 `setExpanded`;`setExpanded(true/false)` 的现有调用点改为 `setMode('list')` / `setMode(基础态)`,其中「基础态」是用户当前选的 pill 或 cat。

## 状态 → 猫的行为映射

猫同一刻只演**优先级最高**的状态。优先级:**待确认 > 卡住 > 运行 > 完成 > 空闲**。

| 状态(pose) | 触发条件 | 猫的姿态/动作 | 角标 | 睡帽 | 复用的现有逻辑 |
|---|---|---|---|---|---|
| `waiting` | waiting 计数 > 0(排除已消音) | 坐起举爪、耳朵竖起、身体轻微抖动催你,头顶 `!` 气泡 | 黄底 `n` | 否 | `alert` 类闪烁 + `chimeWaiting` 响铃 + 自动 `setMode('list')` |
| `stuck` | running 且 idle_sec ≥ STUCK_SEC | 歪头、头顶 `?`、动作放慢 | 黄 `?` | 否 | `stuck` 判据(render.js 已算) |
| `running` | running 计数 > 0 | 埋头拍键盘 / 玩毛线球,尾巴摆动 | 绿 `n` | 否 | running 计数 |
| `done` | done 计数 > 0 且无更高优先态 | 满足趴下/比心,短暂星星特效(到点停) | 蓝 `✓n` | 否 | `done-alert` 蓝闪 + `chimeDone`,沿用 `doneFlashUntil` 计时 |
| `idle` | 全 0 | 打盹、身体呼吸起伏 | 无 | **是** | idle |

**全程 idle 微动作:** 随机眨眼(与主 pose 叠加),让猫"活着"。

**角标即迷你计数:** 角标默认显示当前 pose 对应状态的数字(如运行态显示绿 `2`)。hover 猫时,角标展开成三色完整计数(绿 n / 黄 n / 蓝 n),**所以计数信息一个不少**。

## 交互

- **单击猫** → `setMode('list')`,展开现有列表面板(消音🔔、移除✕、计时、卡住提示全在里面,零改动)。
- **拖动猫** → 移动窗口(复用 `data-tauri-drag-region`,内部装饰元素 `pointer-events:none`,事件落到拖动区)。
- **托盘切换** → 见上「形态与切换」。
- 鼠标穿透降透明度的现有提示保留。

## 少女心皮肤

- 配色用 CSS 变量:奶粉 `--cat-base`、腮红 `--cat-blush`、薄荷/奶黄点缀。与现有 `--running/--waiting/--done` **并存**;状态语义色不变(角标仍用绿/黄/蓝),保证和药丸/列表语义一致。
- 配饰(SVG 图层,开关式):蝴蝶结、腮红常驻;**睡帽仅 idle 态**戴上。
- 皮肤抽象成一份「主题对象」(颜色 + 配饰 + 表情参数),为以后扩展别的猫/生物留口子。**本次只交付一只默认少女猫**(YAGNI:不做皮肤切换 UI、不做第二只)。

## 架构与改动面

延续现有「纯函数渲染 + 单测」风格(`render.js` / `render.test.js`),无新依赖,纯 CSS/SVG。

### 新增文件

- `src/cat.js` —— **纯函数** `buildCatVM(vm, opts)`:输入现有 `buildViewModel` 的结果 vm(含 counts、rows、各 row 的 stuck)+ `{ mutedCount }`,输出 `{ pose, badgeText, badgeColor, accessories, counts }`。无 DOM、无副作用,可单测。
- `src/cat.test.js` —— 覆盖状态→pose/角标映射:优先级顺序、边界(消音后 waiting 归零、stuck 优先于 running、全 0 → idle+睡帽)。

### 改动文件

- `src/index.html` —— 加 `#cat` 容器(与 `#minibar`/`#panel` 并列,`[hidden]` 互斥)。内含 SVG 猫 + 角标 + 气泡节点。
- `src/styles.css` —— 加 `.cat` 区块:SVG 布局、`--cat-*` 变量、动作 `@keyframes`(摆尾、眨眼、举爪、呼吸、抖动)。沿用透明窗约束:投影/动画扩散半径 ≤ `#app` 的 16px padding,防被窗口直角边裁切。
- `src/app.js` ——
  - `setExpanded(bool)` → `setMode('pill'|'list'|'cat')`;记录用户「基础态」(pill 或 cat)。
  - 猫的渲染:tick 末尾若当前是 cat 态,调 `buildCatVM(lastVm, {...})` → 更新 SVG class/角标/气泡;动作切换走 CSS class。
  - pose 推断复用 `lastVm` + `STUCK_SEC` + `muted`,**不碰**轮询/音频/消音/移除/钩子 toast/离线 逻辑。
  - `fitWindow`:加入 cat 分支,按 `#cat` 盒子自适应窗口尺寸(逻辑同现有 pill/panel)。
  - 托盘事件:监听形态切换事件(payload = 'pill'|'list'|'cat'),持久化读写。
- `src-tauri/src/lib.rs`(及相关)—— 托盘菜单加「外观 ▸ 药丸/列表/猫咪」单选子菜单,emit 切换事件;设置持久化(沿用现有设置存储方式,若无则最简 JSON)。**后端、hooks.rs、report-status 脚本不改。**

### 不改动

后端(claude-monitor 仓库)、hooks、report-status 脚本;app.js 的轮询/响铃/消音/移除/卡住/离线/完成闪 逻辑原样复用。

## 测试

- `cat.test.js`:纯函数映射单测(同 render.test.js 风格,无 DOM)。
- 手动验证:三形态托盘切换 + 持久化;猫在五种状态下的姿态/角标/睡帽;单击展开列表后所有现有功能(消音/移除/计时)正常;待确认时仍响铃+自动展开;完成蓝闪;窗口尺寸自适应不裁切投影。

## 范围外(YAGNI)

- 第二只生物 / 皮肤切换 UI / 配饰自定义面板。
- 拖拽换位以外的猫互动(摸头、喂食等养成玩法)。
- Lottie/GIF/像素精灵渲染(本次纯 SVG)。
