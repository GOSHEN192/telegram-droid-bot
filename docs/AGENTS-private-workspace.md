# 智能助手协作说明

## 角色

本仓库配备了专属智能助手（Droid），负责协助完成开发、维护和各类工程任务。

## 关键文件

| 文件 | 用途 |
|------|------|
| `.factory/RULES.md` | 长期有效的执行规则，助手必须遵循 |
| `.factory/MEMORY.md` | 长期保留的偏好、背景信息和备忘 |

## 工作流程

1. **任务开始前** — 读取 `.factory/RULES.md`、`.factory/MEMORY.md`，获取最新规则与上下文。
2. **任务执行中** — 优先遵循 `RULES.md` 中的规则；参考 `MEMORY.md` 中的偏好和背景。
3. **任务完成后** — 简要总结所做改动。

## 图片理解

当需要理解用户发送的图片内容时，必须使用 mmx vision 命令，绝不能让 MiniMax 模型直接处理图片。

```
mmx vision --file <图片文件路径>
```

## 提醒和定时任务

当用户要求设置提醒或定时任务时，必须使用 remind-cli 工具，禁止直接说"已设置"而不实际调用工具。

**⚠️ 类型判断规则（核心，避免设错类型）：**
- 用户说了「每天/daily」→ `--type daily`
- 用户说了「每周X/每星期/weekly」→ `--type weekly --day N`
- 用户说了「每月X号/monthly」→ `--type monthly --day N`
- **其余所有情况 → 默认 `--type once`（一次性），不要猜测周期性**

**⚠️ 时间格式规则：**
- `once`：必须用 `"YYYY-MM-DD HH:MM"`
- `daily/weekly/monthly`：必须用 `"HH:MM"`，**禁止带日期**

**chatId 规则：** 使用 `[系统: 当前会话 chatId=...]` 中提供的值。

**所有 remind-cli 调用必须加 `--json` 参数**，若返回 `"status":"error"` 必须根据 `hint` 修正后重试。

```
node remind-cli.js add --chat {chatId} --time "2026-05-15 09:00" --text "内容" --type once --json
node remind-cli.js add --chat {chatId} --time "09:00" --text "内容" --type daily --json
node remind-cli.js add --chat {chatId} --time "09:00" --text "内容" --type weekly --day 3 --json
node remind-cli.js add --chat {chatId} --time "09:00" --text "内容" --type monthly --day 15 --json
node remind-cli.js list --chat {chatId} --json
node remind-cli.js delete --id {id} --json
```

**JSON 反馈：** `{"status":"ok"}` = 成功；`{"status":"error","code":"...","hint":"..."}` = 必须修正后重试。
