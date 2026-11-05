# 新加坡桥牌 AI：自博弈 PPO 训练

规则只以 `server/gameLogic.js` 为准。`bridge_ai/engine.py` 是它的 torch 向量化移植。`tests/test_engine_js.py` 会拿 JS 引擎生成的对局逐步对拍，每一步的行动者、合法动作集合和最后结果都必须一致。

## 方案

- **自博弈**：四个座位共用一个 actor，座位都按"相对当前行动者"来编码。端到端 PPO，从第一步起就自博弈：不做课程学习，不做奖励塑形。奖励只在终局给 ±1，γ=1。
- **actor 的输入**：自己的手牌和全部公开记录。
  - 竞叫历史是无损编码：每个叫品是谁叫的，以及它有效期间谁 Pass 了。
  - 合约、主公、叫的忠臣牌。
  - 每张已出的牌：谁出的、第几墩第几张、是否首出、是否赢墩、是否压过当时的赢家、当时谁在赢、是否将吃。"压不压主公""压不压其他反贼"这类信号就靠它学。
- **推理特征**：每个座位是否还可能是忠臣，都是精确推理出来的。
  - 排除在叫牌花色上已缺门的人。
  - 墩数反证：如果某两人墩数之和已经够胜利条件，局却还没结束，说明这两人不全是反贼。
  - 每个候选人假设下，双方各自还差几墩。
- **critic**：带特权信息，只在训练时用。它能看到四家牌和真忠臣，输出四个座位各自的终局价值。GAE 沿全局时间轴按四个座位各算一条通道。
- **辅助头**：每张没见过的牌在谁手里、谁是忠臣、不完美信息价值。最后一个留给以后做搜索。
- **对手池**：20% 的对局里有 1–2 个座位由自己的历史快照来打，防止自博弈原地打转。

## 目录

| 路径 | 内容 |
|---|---|
| `bridge_ai/engine.py` | 规则引擎（B 局并行，CPU/GPU 通用） |
| `bridge_ai/features.py` | actor/critic 观测、推理特征、辅助目标；改了就要升 `OBS_VERSION` |
| `bridge_ai/model.py` | 残差 MLP 的 actor 和 critic，采样，`load_actor` |
| `bridge_ai/ppo.py` | rollout、4 通道 GAE、PPO 更新 |
| `bridge_ai/train.py` | 训练入口：续训、对手池、定期打擂台、日志 |
| `bridge_ai/arena.py` | 复式评测（1+3、2+2）和多 run 循环赛 |
| `bridge_ai/bots.py` | 随机和启发式对手，只用来评测 |
| `bridge_ai/config.py` | 超参数和预设：`base` `wide` `explore` `lam98` `smoke` |
| `bridge_ai/export.py` `report.py` | 导出 actor；汇总指标 |
| `scripts/` | NSCC 安装脚本和 PBS 作业；`gen_js_fixtures.mjs` 用来重新生成对拍数据 |
| `requirements.txt` | 环境依赖 |

## 在 NSCC 上训练（ASPIRE 2A，4×A100）

所有 `qsub` 都要带项目号：`-P <项目号>`，个人账户通常是 `personal-<学号>`，见 NSCC 欢迎邮件。

1. **在登录节点 clone 到 scratch**。仓库是私有的话，用 GitHub 的 PAT 作为密码。
   ```bash
   cd ~/scratch
   git clone -b claude/codebase-qa-review-rug1jj https://github.com/msguidie/bridge_sg.git
   cd bridge_sg/ai
   ```
2. **装环境**。只需装一次，在登录节点上跑，大约 10 分钟：
   ```bash
   bash scripts/nscc_setup.sh
   ```
   它会把 conda 环境建在 `~/scratch/conda-envs/bridge_ai`，先装 CUDA 12.8 版的 torch，再装 `requirements.txt`。
3. **冒烟测试**。1 张卡，30 分钟：
   ```bash
   qsub -P <项目号> scripts/nscc_smoke.pbs
   ```
   跑完看 `bridge-smoke.o<作业号>`，要满足三点：
   - pytest 全过（其中包括和 JS 引擎的对拍）。
   - 训练日志里的 `k/s` 是单卡吞吐。
   - 第二段日志要出现 `resumed at iteration`。
4. **正式训练一天**。4 个预设各占一张卡：
   ```bash
   qsub -P <项目号> scripts/nscc_train.pbs
   ```
   - 中途被杀或断了，重新提交同一条命令即可，四个 run 都会从各自的 `runs/<预设>/latest.pt` 续上。
   - 想再训第二天：`qsub -P <项目号> -v HOURS=46.6 scripts/nscc_train.pbs`。`HOURS` 是每个 run 的累计总时长。学习率和熵系数是按"已用时间 / 总时长"插值的，所以延长后它们会先回升，再衰减到新的终点，相当于一次温和重启。
5. **监控**：
   ```bash
   qstat -answ1 $USER
   tail -f runs/base/train.log
   python -m bridge_ai.report runs      # 每个 run 最新的一行指标和擂台成绩（不需要 GPU）
   ```
6. **评测并导出**：
   ```bash
   qsub -P <项目号> scripts/nscc_eval.pbs
   ```
   结果写入 `runs/eval.json`：每个 run 对启发式打 1+3，各 run 之间打 2+2 循环赛。所有 actor 和最佳的那个会导出到 `exports/actor_*.pt` 和 `exports/actor_best.pt`。
7. **拷回笔记本**：
   ```bash
   scp <用户>@aspire2a.nus.edu.sg:~/scratch/bridge_sg/ai/exports/actor_best.pt .
   ```

## 日志怎么读

`train.log` 每 10 轮打一行，例如：
```
it 120 | 3.20h 13.7% | 31.5M steps 140k/s | lord 0.48 lvl 2.9 auc 9.1 len 52.3 | ent 1.10/2.40/0.85 kl 0.0120 clip 0.080 ev 0.62 | loyal 0.71/0.52 belief 0.48
```

- `lord`（主公方胜率）和 `lvl`（平均合约阶数）
  - 正常：开局主公方胜率通常偏低（随机打牌很难完成合约）；随后竞叫学会量力而行，胜率逐渐稳定在 0.4–0.6，合约阶数分布会慢慢散开。
  - 异常：全部挤到 1 阶或 7 阶。
- `ent a/c/p`（竞叫 / 叫忠臣牌 / 出牌三个阶段的熵）
  - 正常：缓慢下降。
  - 异常：头几个小时就掉到接近 0，说明策略过早固化。
- `kl` 和 `clip`
  - 正常：`kl` 一般在 0.005–0.03，`clip` 在 0.05–0.2。
  - 异常：长期明显偏高，就调低 `lr`。
- `ev`（critic 解释方差）
  - 正常：逐渐升到 0.5 以上。critic 看得到四家牌，所以它应该很准。
- `loyal 准确率/基线`
  - 正常：几小时后忠臣识别准确率应明显高于基线。基线 = 只靠推理掩码在候选人里均匀乱猜的准确率。
- `belief`（暗牌持有者准确率）
  - 正常：随机猜是 1/3，应该稳定在它之上。
- `arena` 行（每小时一次）
  - `vs_heuristic` 应是正数且逐渐上升。
  - `vs_2h_ago`、`vs_6h_ago` 为正，说明还在变强；接近 0 说明到平台期了。

## 本地 CPU（可选）

```bash
pip install torch --index-url https://download.pytorch.org/whl/cpu && pip install -r requirements.txt
python -m pytest -q
python -m bridge_ai.train --preset smoke --run-dir runs/local --set device=cpu
```

重新生成对拍数据：在仓库根目录执行 `node ai/scripts/gen_js_fixtures.mjs`（改了 `gameLogic.js` 才需要）。

## 以后部署（本轮不做，这里只记思路）

- **接入方式**：笔记本上起一个 Python 旁路进程，用 `load_actor` 加载 `actor_best.pt`。服务端把整副牌和动作历史发给它；它用 `BridgeEnv.set_deal` 和 `step` 重放出当前局面，再用 `actor_obs` 只取该座位能看到的信息。泄露测试保证 actor 看不到暗牌。
- **性格**：三个调节手段，都在推理时设置：
  - 采样温度（`sample(..., temperature=)`）。
  - 叫牌激进度：给叫品 logits 加一个偏置。
  - 搜索层数：以后在 actor 之上加粒子滤波加推演。
