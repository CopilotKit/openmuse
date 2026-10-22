# OpenMuse agent guidance

## Agent skills

### Issue tracker

OpenBot integration Issues are tracked in GitHub at `1123786563/OpenBot`. Before reading, creating, or updating one, read the parent repository's `../../docs/agents/issue-tracker.md`.

### Domain docs

For OpenBot shared terms, read `../../CONTEXT.md`; for OpenMuse-specific terms, read this submodule's `CONTEXT.md`. See `../../docs/agents/domain.md` for their boundaries.

# Agent 开发工作流

本仓库使用 **Matt Pocock Skills 负责设计**，使用 **Superpowers 负责实现**。
任何阶段只能有一个工作流编排器。

## 事实源

- `../../docs/specs/`：Spec 所在目录；逐份核对状态，只有明确批准的 Spec 才作为实施依据。
- `../../docs/adr/`：OpenBot 架构决策与约束。
- `../../CONTEXT.md`：OpenBot 共享术语；本目录 `CONTEXT.md`：OpenMuse 局部术语。
- `../../docs/plans/`：OpenBot 的 Superpowers 实施计划。
- Git + Superpowers Ledger：执行历史和已完成任务的证据。

如果实施 Plan 与已批准 Spec 冲突，以 Spec 为准。
如果实现与 ADR 或批准需求冲突，应升级处理，而不是在实现阶段静默重新设计。

## Phase A — Matt Skills：WHAT / WHY

使用 Matt Skills 处理：

- `grill-with-docs`
- `grilling`
- `domain-modeling`
- `codebase-design`
- `improve-codebase-architecture`
- `prototype`
- `research`
- `wayfinder`
- `to-spec`
- `to-tickets`
- `handoff`

该阶段除明确标记为一次性原型的代码外，不实现生产代码。

满足以下条件后视为设计完成：重要决策已经解决、领域语言已经记录、相关 ADR 已存在、已有批准的 Spec，并且大型工作已经拆成纵向业务 Ticket。

## Phase B — Superpowers：HOW / EXECUTE

使用 Superpowers 处理：

- `writing-plans`
- `using-git-worktrees`
- `dispatching-parallel-agents`
- `subagent-driven-development`
- `executing-plans`
- `test-driven-development`
- `systematic-debugging`
- `requesting-code-review`
- `receiving-code-review`
- `verification-before-completion`
- `finishing-a-development-branch`

开始实现 OpenBot 集成前先读取 `../../CONTEXT.md`、本目录 `CONTEXT.md`、已批准 Spec、相关 ADR 和当前 Ticket，然后再创建 Implementation Plan。
上述 Superpowers Skill 必须在当前会话中可调用；若未暴露，记录能力缺口并报告，不能声称已执行相应 Skill 或通过其关卡。

### 测试与容器

验证 OpenBot 集成改动时遵守父仓库 `../../docs/agents/testing.md`。测试结束时确认本次新建的测试容器已关闭。

### 分支与 Worktree

创建、复用或清理 Orca 工作区及 Git 分支前，遵守父仓库 `../../docs/agents/worktrees.md`；本子模块属于独立 Git 仓库，分别核对其状态与提交。

### 冲突规则

Superpowers 实现阶段**不要**再调用 Matt 的 `implement`、`implement-spec` 或 `tdd` 作为竞争实现流程。
已经存在批准 Spec 时不要重新启动产品 Brainstorming；Superpowers 只允许澄清尚未解决的实现歧义或真正的冲突。

### 任务粒度

Matt Ticket 应是“业务完整的纵向切片”；Superpowers Task 是 Ticket 内更小的实现单元。
除非属于真正的大范围机械重构，否则不要把纵向 Ticket 替换成“数据库 / 后端 / 前端”这样的水平 Ticket。

### 并行 Agent

只有在任务相互独立、接口已确定、可写文件和共享状态不重叠时才并行。
每个实现流优先使用独立 Git Worktree；主 Agent 负责最终集成。
不要使用共享 `git stash` 作为并行协调机制。

### 子 Agent 上下文

给子 Agent 提供最小必要上下文，并尽量使用这些文件指针：`../../CONTEXT.md`、本目录 `CONTEXT.md`、相关 ADR、批准 Spec、当前 Ticket、Task Brief、前置任务接口。
不要把整个父会话复制给每个 Child Agent。长上下文是储备容量，不是信息倾倒场。

### TDD

Superpowers 负责实现阶段的 TDD 编排。
在适用场景遵循 **RED -> GREEN -> REFACTOR**，优先测试公共 Seam 和可观察行为。
可以吸收 Matt 的测试设计原则，但 Matt `tdd` 不接管实现阶段。

### 调试

实现缺陷使用 Superpowers `systematic-debugging`。
如果根因是架构或领域模型问题，则返回 Matt `domain-modeling` / `codebase-design`，更新 ADR / Spec 后再恢复实现。

### Review

每个任务和实现阶段最终 Review 由 Superpowers 负责。
之后可选运行  `open-code-review`，再做一轮 Standards + Spec Compliance 独立审查。
Review Agent 默认应保持只读。
OpenBot 集成任务还须遵守父仓库 `../../AGENTS.md` 的“Open Code Review（OCR）”两级审查关卡。

## 长上下文 / Context Management 策略

本项目假设存在 1M 级原生上下文，但可持久化项目文件仍然是事实源。

- 不要因为模型能记更多，就推迟记录重要决策。
- 决策一旦稳定，应更新对应范围的 `CONTEXT.md`、ADR 或 Spec。
- 工具输出保持针对性；大体积证据保存到文件，只读取相关范围。
- 到达阶段边界时，如果前一阶段的大量聊天细节已经无用，优先使用新任务 / 新 Session / 干净子 Agent Context。
- 自动压缩或上下文滚动后，从文件 + Git + Superpowers Ledger 重建状态，不依赖模型自己的回忆。

## 完成标准

在必要测试、类型检查 / Lint / 静态分析（适用时）、验收标准、Review Findings 和最终 Diff 范围都经过验证前，不要声称任务完成。
**Evidence over claims（证据优先于声明）。**
