# Telegram + MiniMax Bot 部署记录

## 背景

之前使用 cc-connect + droid-acp 连接 Telegram，但存在以下问题：
- droid-acp 不支持 custom model（MiniMax）
- 即使指定了 custom model，droid 仍需要 Factory 订阅验证
- Factory 配额用完后无法继续使用

## 解决方案

创建独立的 Telegram bot，直接调用 MiniMax API，不依赖 Factory 服务。

技术栈：
- Node.js
- telegraf（Telegram bot 框架）
- openai SDK（MiniMax API 兼容 OpenAI 接口）

## 部署步骤

### 1. 创建项目目录

```bash
mkdir -p /root/telegram-minimax-bot
cd /root/telegram-minimax-bot
npm init -y
```

### 2. 安装依赖

```bash
npm install telegraf openai
```

### 3. 创建主程序

创建 `/root/telegram-minimax-bot/index.js`：

```javascript
const { Telegraf } = require('telegraf');
const OpenAI = require('openai');

// 配置 - 从环境变量读取
const TELEGRAM_BOT_TOKEN = process.env.TELEGRAM_BOT_TOKEN;
const MINIMAX_API_KEY = process.env.MINIMAX_API_KEY;
const MINIMAX_BASE_URL = process.env.MINIMAX_BASE_URL || 'https://api.minimaxi.com/v1';
const MINIMAX_MODEL = process.env.MINIMAX_MODEL || 'MiniMax-M2.7';
const ALLOWED_USERS = process.env.ALLOWED_USERS ? process.env.ALLOWED_USERS.split(',').map(id => parseInt(id.trim())) : null;

// 初始化 OpenAI 客户端指向 MiniMax
const openai = new OpenAI({
  apiKey: MINIMAX_API_KEY,
  baseURL: MINIMAX_BASE_URL,
});

// 初始化 Telegram Bot
const bot = new Telegraf(TELEGRAM_BOT_TOKEN);

// 会话存储（内存中）
const sessions = new Map();

function getSession(userId) {
  if (!sessions.has(userId)) {
    sessions.set(userId, { messages: [], createdAt: Date.now() });
  }
  return sessions.get(userId);
}

function isAllowed(userId) {
  if (!ALLOWED_USERS) return true;
  return ALLOWED_USERS.includes(userId);
}

// 处理消息
bot.on('text', async (ctx) => {
  const userId = ctx.from.id;
  const messageText = ctx.message.text;

  if (!isAllowed(userId)) {
    console.log(`[DENIED] User ${userId} tried to access`);
    return;
  }

  console.log(`[MSG] User ${userId} (${ctx.from.username || 'unknown'}): ${messageText}`);

  const session = getSession(userId);
  session.messages.push({ role: 'user', content: messageText });

  if (session.messages.length > 20) {
    session.messages = session.messages.slice(-20);
  }

  try {
    await ctx.sendChatAction('typing');

    const response = await openai.chat.completions.create({
      model: MINIMAX_MODEL,
      messages: session.messages,
      max_tokens: 4096,
      temperature: 0.7,
    });

    let assistantMessage = response.choices[0]?.message?.content || '抱歉，我没有生成回复。';
    
    // 移除 thinking 标签内容
    assistantMessage = assistantMessage.replace(/<thought>[\s\S]*?<\/thought>/gi, '');
    assistantMessage = assistantMessage.replace(/<think>[\s\S]*?<\/think>/gi, '');
    assistantMessage = assistantMessage.trim();

    session.messages.push({ role: 'assistant', content: assistantMessage });

    if (assistantMessage.length > 4000) {
      const chunks = [];
      for (let i = 0; i < assistantMessage.length; i += 4000) {
        chunks.push(assistantMessage.slice(i, i + 4000));
      }
      for (const chunk of chunks) {
        await ctx.reply(chunk);
      }
    } else {
      await ctx.reply(assistantMessage);
    }

    console.log(`[REPLY] To ${userId}: ${assistantMessage.slice(0, 100)}...`);

  } catch (error) {
    console.error('[ERROR]', error.message);
    await ctx.reply(`抱歉，出错了: ${error.message}`);
  }
});

// 命令处理
bot.command('new', async (ctx) => {
  const userId = ctx.from.id;
  sessions.delete(userId);
  await ctx.reply('会话已清空，开始新对话。');
});

bot.command('model', async (ctx) => {
  await ctx.reply(`当前模型: ${MINIMAX_MODEL}\nAPI: ${MINIMAX_BASE_URL}`);
});

bot.command('help', async (ctx) => {
  await ctx.reply(`可用命令:\n/new - 清空会话\n/model - 显示模型信息\n/help - 帮助`);
});

bot.catch((err, ctx) => console.error('[BOT ERROR]', err));

console.log('='.repeat(50));
console.log('Telegram + MiniMax Bot');
console.log('='.repeat(50));
console.log(`Model: ${MINIMAX_MODEL}`);
console.log(`API: ${MINIMAX_BASE_URL}`);
console.log(`Allowed Users: ${ALLOWED_USERS ? ALLOWED_USERS.join(', ') : 'All'}`);
console.log('='.repeat(50));

bot.launch().then(() => console.log('[STARTED] Bot is running...'));

process.once('SIGINT', () => bot.stop('SIGINT'));
process.once('SIGTERM', () => bot.stop('SIGTERM'));
```

### 4. 创建 systemd 服务

创建 `/etc/systemd/system/telegram-minimax-bot.service`：

```ini
[Unit]
Description=Telegram MiniMax Bot
After=network.target

[Service]
Type=simple
User=root
WorkingDirectory=/root/telegram-minimax-bot
Environment="MINIMAX_API_KEY=你的MiniMax API Key"
Environment="MINIMAX_BASE_URL=https://api.minimaxi.com/v1"
Environment="MINIMAX_MODEL=MiniMax-M2.7"
Environment="TELEGRAM_BOT_TOKEN=你的Telegram Bot Token"
Environment="ALLOWED_USERS=允许的用户ID"
ExecStart=/root/.nvm/versions/node/v22.22.0/bin/node /root/telegram-minimax-bot/index.js
Restart=always
RestartSec=5
StandardOutput=journal
StandardError=journal

[Install]
WantedBy=multi-user.target
```

### 5. 启动服务

```bash
systemctl daemon-reload
systemctl enable telegram-minimax-bot
systemctl start telegram-minimax-bot
```

## 文件位置

| 文件 | 路径 |
|------|------|
| 项目目录 | `/root/telegram-minimax-bot/` |
| 主程序 | `/root/telegram-minimax-bot/index.js` |
| systemd 服务 | `/etc/systemd/system/telegram-minimax-bot.service` |

## 管理命令

```bash
# 查看状态
systemctl status telegram-minimax-bot

# 查看实时日志
journalctl -u telegram-minimax-bot -f

# 重启服务
systemctl restart telegram-minimax-bot

# 停止服务
systemctl stop telegram-minimax-bot

# 启动服务
systemctl start telegram-minimax-bot
```

## Telegram 命令

| 命令 | 说明 |
|------|------|
| `/new` | 清空会话，开始新对话 |
| `/model` | 显示当前模型信息 |
| `/help` | 显示帮助信息 |

## 配置说明

| 环境变量 | 说明 |
|----------|------|
| `TELEGRAM_BOT_TOKEN` | Telegram Bot Token |
| `MINIMAX_API_KEY` | MiniMax API Key |
| `MINIMAX_BASE_URL` | MiniMax API 地址（默认 https://api.minimaxi.com/v1） |
| `MINIMAX_MODEL` | 模型名称（默认 MiniMax-M2.7） |
| `ALLOWED_USERS` | 允许使用的用户 ID（逗号分隔，留空则允许所有） |

## 注意事项

1. **会话存储**：当前使用内存存储，重启服务后会话历史会丢失
2. **消息长度**：超过 4000 字符的回复会分段发送
3. **历史限制**：每个会话保留最近 20 条消息
4. **推理输出**：已过滤 `<think>` 和 `<thought>` 标签内容

## 与 cc-connect 的对比

| 特性 | cc-connect + droid-acp | telegram-minimax-bot |
|------|------------------------|---------------------|
| 依赖 Factory 订阅 | 是 | 否 |
| 支持 custom model | 否（ACP 模式 bug） | 是 |
| 配置复杂度 | 较高 | 简单 |
| 会话管理 | 有 | 基础 |

## 部署日期

2026-04-13

---

# Telegram + Droid CLI Bot 部署记录（v2 进化版）

> 创建时间: 2026-04-14
> 状态: ✅ 已完成并验证

## 一、背景与演进

### 1.1 三个方案的演进历程

| 阶段 | 方案 | 问题 |
|------|------|------|
| v1 | cc-connect + droid-acp → Factory Droid | droid-acp 不支持 custom model；需 Factory 订阅验证；配额用完即废 |
| v2 | telegram-minimax-bot（直接调 MiniMax API） | 绕过了 Factory，能用但只是纯聊天，没有 Droid 的工具调用能力 |
| **v3（当前）** | **telegram-droid-bot（调 droid exec CLI）** | **通过 droid exec -m custom:minimax-m2.7 使用自己的 API key，既有 Droid 框架能力，又不消耗 Factory 配额** |

### 1.2 核心突破

**关键发现：** `droid exec` CLI 支持通过 `-m` 参数指定 custom model，配合 `settings.local.json` 中配置的第三方模型 API key，可以：
- 使用 Droid 的全部框架能力（工具调用、代码执行、文件操作等）
- 推理费用走自己的第三方模型 API（MiniMax、GLM、讯飞等）
- **不消耗 Factory 配额**（Factory 只做登录验证，不收推理费）

### 1.3 架构对比

```
方案 v1 (cc-connect + droid-acp):
  Telegram → cc-connect → droid-acp (ACP协议) → Factory Droid → Factory模型(消耗配额) ❌

方案 v2 (telegram-minimax-bot):
  Telegram → Node.js → MiniMax API (纯聊天，无工具能力) → 回复 ⚠️

方案 v3 (telegram-droid-bot，当前):
  Telegram → Node.js → spawn("droid exec -m custom:minimax-m2.7") → MiniMax API → 回复 ✅
  Droid 框架提供工具能力，MiniMax 提供推理能力，Factory 只做登录验证。
```

### 1.4 数据流详解

```
用户 (Telegram App)
    ↕ 发消息/收消息
Telegram 服务器
    ↕ 长轮询 (telegraf 库)
云服务器上的 Node.js 程序 (/root/telegram-droid-bot/index.js)
    ↕ child_process.spawn
Factory Droid CLI (/root/.local/bin/droid)
    ↕ 读取 settings.local.json 中的 API key
    ↕ HTTP API 调用 (OpenAI 兼容接口)
MiniMax / GLM / 讯飞 等第三方模型 API
    ↕ 返回 AI 回复
Droid CLI 拿到回复（可附带工具调用结果）
    ↕
Node.js 程序拿到输出
    ↕
发回 Telegram
```

**关键角色类比：**
- **Droid CLI** = 秘书（接收问题、整理信息、调用工具、管理对话）
- **MiniMax 等模型** = 顾问（真正生成回答的"大脑"）
- **Factory** = 人事部门（只验证身份/登录，不管具体工作）

---

## 二、核心配置文件

### 2.1 Droid 自定义模型配置

**文件路径：** `/root/.factory/settings.local.json`

```json
{
  "locale": "zh-CN",
  "customModels": [
    {
      "model": "glm-4.7",
      "id": "custom:glm-4.7",
      "baseUrl": "https://api.z.ai/api/coding/paas/v4",
      "apiKey": "${ZAI_API_KEY}",
      "displayName": "GLM-4.7",
      "maxOutputTokens": 131072,
      "noImageSupport": true,
      "provider": "generic-chat-completion-api"
    },
    {
      "model": "glm-5.1",
      "id": "custom:glm-5.1",
      "baseUrl": "https://api.z.ai/api/coding/paas/v4",
      "apiKey": "${ZAI_API_KEY}",
      "displayName": "GLM-5.1",
      "maxOutputTokens": 131072,
      "noImageSupport": true,
      "provider": "generic-chat-completion-api"
    },
    {
      "model": "astron-code-latest",
      "id": "custom:astron-code-latest",
      "baseUrl": "https://maas-coding-api.cn-huabei-1.xf-yun.com/v2",
      "apiKey": "${XFYUN_API_KEY}",
      "displayName": "讯飞 Coding Plan",
      "maxOutputTokens": 32768,
      "noImageSupport": true,
      "provider": "generic-chat-completion-api"
    },
    {
      "model": "MiniMax-M2.7",
      "id": "custom:minimax-m2.7",
      "baseUrl": "https://api.minimaxi.com/v1",
      "apiKey": "${MINIMAX_API_KEY}",
      "displayName": "MiniMax M2.7",
      "maxOutputTokens": 131072,
      "noImageSupport": true,
      "provider": "generic-chat-completion-api"
    }
  ]
}
```

**说明：**
- `apiKey` 使用 `${环境变量名}` 格式，Droid 运行时从环境变量读取实际 key
- 所有 custom model 的 `provider` 都是 `generic-chat-completion-api`（OpenAI 兼容接口）
- `noImageSupport: true` 表示这些模型不支持图片输入

### 2.2 API Key 环境变量

API Key 配置在 `~/.bashrc` 中：

```bash
export ZAI_API_KEY="你的ZAI API Key"
export XFYUN_API_KEY="你的讯飞API Key"
export MINIMAX_API_KEY="你的MiniMax API Key"
```

**同时需要配置在 systemd 服务文件中**，因为 systemd 服务不会 source .bashrc。

### 2.3 Droid 登录认证

Droid CLI 需要登录认证，认证文件存储在：
- `/root/.factory/auth.v2.file` — 认证令牌
- `/root/.factory/auth.v2.key` — 认证密钥

登录后长期有效，不需要每次重新登录。

---

## 三、部署步骤

### 步骤 1：确认 Droid CLI 已安装并登录

```bash
# 检查安装
which droid          # /root/.local/bin/droid
droid --version      # 0.99.0

# 如果未安装
# curl -fsSL https://app.factory.ai/cli | sh

# 登录（按提示操作）
droid login
```

### 步骤 2：确认 custom model 可用

```bash
# 查看可用模型列表（应包含 Custom Models 部分）
droid exec --help

# 测试 custom model 是否工作
droid exec -m custom:minimax-m2.7 "说一句话测试"
```

**注意：** 测试前确保环境变量已设置：
```bash
source ~/.bashrc
```

### 步骤 3：创建项目目录

```bash
mkdir -p /root/telegram-droid-bot
cd /root/telegram-droid-bot
```

### 步骤 4：创建 package.json

```json
{
  "name": "telegram-droid-bot",
  "version": "1.0.0",
  "description": "Telegram bot that calls Factory Droid CLI with custom models",
  "main": "index.js",
  "scripts": {
    "start": "node index.js"
  },
  "dependencies": {
    "telegraf": "^4.16.0"
  }
}
```

注意：**只需要 telegraf 一个依赖**，不需要 openai SDK（因为直接调 droid CLI）。

### 步骤 5：安装依赖

```bash
npm install
```

### 步骤 6：创建主程序

创建 `/root/telegram-droid-bot/index.js`。

**核心原理：**
1. 使用 telegraf 接收 Telegram 消息
2. 使用 `child_process.spawn` 调用 `droid exec` 命令
3. 捕获 stdout 输出并返回给 Telegram

**关键代码逻辑：**

```javascript
// 调用 droid exec
function callDroid(prompt, session) {
  return new Promise((resolve, reject) => {
    const args = ['exec', '-m', session.model, '--auto', session.autoLevel];

    // 如果有已有会话，使用 -s 参数延续上下文
    if (session.sessionId) {
      args.push('-s', session.sessionId);
    }

    args.push(prompt);

    // 关键：必须设置完整 PATH，否则 droid 找不到 node 等工具
    const env = {
      ...process.env,
      PATH: '/root/.local/bin:/usr/local/go/bin:/root/.nvm/versions/node/v22.22.0/bin:/usr/local/sbin:/usr/local/bin:/usr/sbin:/usr/bin:/sbin:/bin',
      HOME: '/root',
    };

    const proc = spawn(DROID_PATH, args, {
      cwd: DROID_CWD,
      env,
      timeout: DROID_TIMEOUT,
      maxBuffer: 1024 * 1024 * 10,
    });
    // ... 捕获 stdout/stderr ...
  });
}
```

### 步骤 7：创建 systemd 服务

创建 `/etc/systemd/system/telegram-droid-bot.service`：

```ini
[Unit]
Description=Telegram Droid CLI Bot
After=network.target

[Service]
Type=simple
User=root
WorkingDirectory=/root/telegram-droid-bot
Environment="TELEGRAM_BOT_TOKEN=你的Telegram Bot Token"
Environment="ALLOWED_USERS=允许的用户ID"
Environment="DROID_MODEL=custom:minimax-m2.7"
Environment="DROID_PATH=/root/.local/bin/droid"
Environment="DROID_CWD=/root"
Environment="DROID_TIMEOUT=120000"
# 以下 API Key 必须配置，否则 droid exec 找不到 custom model 的 key
Environment="ZAI_API_KEY=你的ZAI API Key"
Environment="XFYUN_API_KEY=你的讯飞API Key"
Environment="MINIMAX_API_KEY=你的MiniMax API Key"
ExecStart=/root/.nvm/versions/node/v22.22.0/bin/node /root/telegram-droid-bot/index.js
Restart=always
RestartSec=5
StandardOutput=journal
StandardError=journal

[Install]
WantedBy=multi-user.target
```

**⚠️ 关键注意：** systemd 服务不会 source `.bashrc`，所以所有 API Key 必须在 `Environment=` 中单独配置！

### 步骤 8：启动服务

```bash
systemctl daemon-reload
systemctl enable telegram-droid-bot
systemctl start telegram-droid-bot
```

---

## 四、文件位置汇总

| 文件/目录 | 路径 |
|----------|------|
| 项目目录 | `/root/telegram-droid-bot/` |
| 主程序 | `/root/telegram-droid-bot/index.js` |
| systemd 服务 | `/etc/systemd/system/telegram-droid-bot.service` |
| Droid 配置 | `/root/.factory/settings.local.json` |
| Droid 认证 | `/root/.factory/auth.v2.file` |
| API Key 环境变量 | `/root/.bashrc` |
| Droid CLI | `/root/.local/bin/droid` |

---

## 五、管理命令

```bash
# 查看服务状态
systemctl status telegram-droid-bot

# 查看实时日志
journalctl -u telegram-droid-bot -f

# 查看最近日志
journalctl -u telegram-droid-bot --no-pager -n 30

# 重启服务（修改代码后）
systemctl restart telegram-droid-bot

# 停止服务
systemctl stop telegram-droid-bot

# 启动服务
systemctl start telegram-droid-bot
```

### 手动测试 droid exec

```bash
# 确保 API key 已加载
source ~/.bashrc

# 测试 MiniMax 模型
droid exec -m custom:minimax-m2.7 "你好"

# 测试 GLM 模型
droid exec -m custom:glm-5.1 "你好"

# 查看可用模型
droid exec --help

# 列出可用工具
droid exec -m custom:minimax-m2.7 --list-tools
```

---

## 六、Telegram 命令

| 命令 | 说明 |
|------|------|
| `/start` | 欢迎信息 |
| `/help` | 显示所有命令帮助 |
| `/new` | 清空会话，开始新对话 |
| `/model` | 查看所有可用模型 |
| `/model <名称>` | 切换模型（如 `/model glm5`） |
| `/auto` | 查看当前权限等级 |
| `/auto <等级>` | 切换权限：low / medium / high |
| `/session` | 查看当前会话信息 |
| `/status` | 查看完整状态 |
| `/timeout <秒>` | 设置超时（10-600秒） |
| `/tools` | 查看当前模型可用工具 |

### 可用模型

**自定义模型（使用你自己的 API key，不消耗 Factory 配额）：**

| 简称 | 模型 ID | 说明 |
|------|---------|------|
| `minimax` | `custom:minimax-m2.7` | MiniMax M2.7（默认） |
| `glm4` | `custom:glm-4.7` | GLM-4.7 |
| `glm5` | `custom:glm-5.1` | GLM-5.1 |
| `xfyun` | `custom:astron-code-latest` | 讯飞 Coding Plan |

**内置模型（使用 Factory 配额）：**

| 简称 | 模型 ID | 说明 |
|------|---------|------|
| `claude-opus` | `claude-opus-4-6` | Claude Opus 4.6 |
| `claude-opus-fast` | `claude-opus-4-6-fast` | Claude Opus 4.6 快速 |
| `claude-sonnet` | `claude-sonnet-4-6` | Claude Sonnet 4.6 |
| `claude-haiku` | `claude-haiku-4-5-20251001` | Claude Haiku 4.5 |
| `gpt54` | `gpt-5.4` | GPT-5.4 |
| `gpt54-fast` | `gpt-5.4-fast` | GPT-5.4 快速 |
| `gpt54-mini` | `gpt-5.4-mini` | GPT-5.4 Mini |
| `gpt52` | `gpt-5.2` | GPT-5.2 |
| `gpt52-codex` | `gpt-5.2-codex` | GPT-5.2 Codex |
| `gemini-pro` | `gemini-3.1-pro-preview` | Gemini 3.1 Pro |
| `gemini-flash` | `gemini-3-flash-preview` | Gemini 3 Flash |
| `kimi` | `kimi-k2.5` | Kimi K2.5 |

### 权限等级说明

| 等级 | 说明 | 允许的操作 |
|------|------|-----------|
| `low` | 只读 + 基础文件操作 | 读文件、touch、mkdir、mv、cp |
| `medium` | 开发操作 | 安装包、git commit、构建代码 |
| `high`（默认） | 生产操作 | 部署、git push、运行脚本 |

---

## 七、经验总结与踩坑记录

### 7.1 关键踩坑

#### 坑 1：Telegraf 命令注册顺序

**现象：** `/new`、`/model` 等命令发到 Telegram 后无反应。

**原因：** `bot.on('text')` 注册在 `bot.command()` 之前。Telegraf 按注册顺序匹配中间件，`bot.on('text')` 会匹配所有文本消息（包括 `/` 开头的命令），导致命令处理器永远收不到消息。

**解决：** 必须将所有 `bot.command()` 注册在 `bot.on('text')` 之前。

```javascript
// ❌ 错误：先注册 text handler
bot.on('text', async (ctx) => { ... });
bot.command('new', async (ctx) => { ... });  // 永远不会被调用

// ✅ 正确：先注册 command handler
bot.command('new', async (ctx) => { ... });
bot.command('model', async (ctx) => { ... });
// ... 所有 command ...
bot.on('text', async (ctx) => { ... });  // 最后注册
```

#### 坑 2：systemd 服务找不到 API Key

**现象：** 手动运行 `node index.js` 正常，但 systemd 启动后 droid exec 报错找不到 custom model。

**原因：** systemd 服务不会 source `.bashrc`，所以 `ZAI_API_KEY`、`MINIMAX_API_KEY` 等环境变量不存在。

**解决：** 在 systemd service 文件中用 `Environment=` 显式配置所有 API Key。

#### 坑 3：spawn 子进程找不到 droid/node

**现象：** `spawn('droid', ...)` 报错 `ENOENT`。

**原因：** spawn 的子进程不会继承完整 PATH。

**解决：** 在 spawn 的 env 中显式设置完整 PATH：
```javascript
const env = {
  ...process.env,
  PATH: '/root/.local/bin:/usr/local/go/bin:/root/.nvm/versions/node/v22.22.0/bin:/usr/local/sbin:/usr/local/bin:/usr/sbin:/usr/bin:/sbin:/bin',
  HOME: '/root',
};
```

#### 坑 4：同一个 Bot Token 不能两个 bot 同时使用

**现象：** 新 bot 启动后不接收消息，或旧 bot 和新 bot 交替收到消息。

**原因：** 同一个 Telegram Bot Token 只能有一个程序在轮询。

**解决：** 启动新 bot 前必须停掉旧 bot：
```bash
systemctl stop telegram-minimax-bot
systemctl start telegram-droid-bot
```

#### 坑 5：droid exec --auto 等级选择

**现象：** 默认（不加 `--auto`）droid exec 是只读模式，无法执行写操作。

**解决：** 根据需求选择合适的等级。Telegram bot 默认用 `high`，可通过 `/auto` 命令动态切换。

### 7.2 三个方案的最终对比

| 特性 | cc-connect + droid-acp | telegram-minimax-bot (v2) | telegram-droid-bot (v3) |
|------|------------------------|---------------------------|-------------------------|
| 依赖 Factory 订阅 | 是 | 否 | 仅登录验证 |
| 消耗 Factory 配额 | 是 | 否 | **否（用自定义模型 API key）** |
| 支持 custom model | 否（ACP bug） | 是（直接调） | 是（droid exec -m） |
| Droid 工具能力 | 有 | **无** | **有** |
| 代码执行能力 | 有 | **无** | **有** |
| 多模型切换 | 否 | 否 | **是（Telegram 命令切换）** |
| 权限控制 | 有 | 无 | **有（/auto 命令）** |
| 配置复杂度 | 高（Go编译+ACP） | 低 | **低** |
| 会话管理 | 有 | 基础（内存） | 有（droid session ID + 文件持久化） |

#### 坑 6：上下文丢失 — 每次对话都是全新会话

**现象：** 在 Telegram 上连续发多条消息，AI 没有上下文记忆，每条消息都像第一次对话。

**原因：** `droid exec` 默认用纯文本输出模式 (`-o text`)，输出内容里**不包含 session ID**。代码用正则 `extractSessionId()` 尝试从纯文本中提取 session ID，但根本匹配不到，导致 `session.sessionId` 始终为 `null`。每次调用 `droid exec` 都不带 `-s` 参数，所以每次都是全新会话。

**日志特征（可从 journalctl 确认）：**
```
[DROID] Calling: droid exec -m custom:minimax-m2.7 --auto high 你好        ← 没有 -s
[DROID] Calling: droid exec -m custom:minimax-m2.7 --auto high 我叫Peter   ← 没有 -s
[DROID] Calling: droid exec -m custom:minimax-m2.7 --auto high 我叫什么？   ← 没有 -s
```

**解决步骤 1：改用 JSON 输出格式获取 session ID**

`droid exec -o json` 会返回结构化 JSON，包含 `"session_id"` 字段：

```bash
# 测试 JSON 输出
$ droid exec -m custom:minimax-m2.7 -o json "说你好"
{"type":"result","subtype":"success","is_error":false,"duration_ms":3569,
 "result":"你好！有什么可以帮你的吗？",
 "session_id":"e367d489-9a5a-422a-a875-d74c285b24d7",
 "usage":{"input_tokens":0,"output_tokens":0,...}}
```

修改 `callDroid()` 函数，加入 `-o json` 参数：

```javascript
// 修改前
const args = ['exec', '-m', session.model, '--auto', session.autoLevel];

// 修改后
const args = ['exec', '-m', session.model, '--auto', session.autoLevel, '-o', 'json'];
```

用 `parseDroidOutput()` 解析 JSON：

```javascript
function parseDroidOutput(rawOutput) {
  try {
    const json = JSON.parse(rawOutput);
    const result = (json.result || '').trim();
    const cleaned = result
      .replace(/<thought>[\s\S]*?<\/thought>/gi, '')
      .replace(/<think[\s\S]*?<\/think>/gi, '')
      .trim();
    return {
      text: cleaned || '（Droid 没有返回内容）',
      sessionId: json.session_id || null,
      isError: json.is_error || false,
    };
  } catch (e) {
    // JSON 解析失败，降级为纯文本处理
    ...
  }
}
```

验证上下文延续：

```bash
# 第1条：建立会话
$ SID=$(droid exec -m custom:minimax-m2.7 -o json "我叫Peter" | python3 -c "import sys,json; print(json.load(sys.stdin)['session_id'])")
# Session ID: 1268a98b-3582-47da-87da-b58d19ae1579

# 第2条：用同一 session ID 延续上下文
$ droid exec -m custom:minimax-m2.7 -o json -s "$SID" "我叫什么名字？"
# 返回: "你叫 Peter。" ✅ 上下文延续成功！
```

修复后的日志特征：
```
[DROID] Calling: droid exec -m custom:minimax-m2.7 --auto high -o json 你好
[SESSION] Updated session for user 5989118323: e367d489-...
[DROID] Calling: droid exec -m custom:minimax-m2.7 --auto high -o json -s e367d489-... 我叫Peter  ← 带 -s 了！
```

#### 坑 7：重启服务后上下文丢失（会话持久化）

**现象：** `systemctl restart telegram-droid-bot` 或服务器重启后，Telegram 对话又变成全新会话，之前聊的内容全忘了。

**原因：** session ID 存在 Node.js 进程的内存中（`Map`），进程重启后内存清空。

**解决：** 将 session 数据持久化到文件 (`sessions.json`)。

**核心代码：**

```javascript
const SESSION_FILE = path.join(__dirname, 'sessions.json');

// 启动时从文件加载
function loadSessions() {
  try {
    if (fs.existsSync(SESSION_FILE)) {
      const data = JSON.parse(fs.readFileSync(SESSION_FILE, 'utf8'));
      for (const [userId, sess] of Object.entries(data)) {
        userSessions.set(parseInt(userId), { ...sess, processing: false });
      }
      console.log(`[SESSION] Loaded ${userSessions.size} session(s) from file`);
    }
  } catch (e) {
    console.error('[SESSION] Failed to load sessions:', e.message);
  }
}

// 每次更新 session 后保存到文件
function saveSessions() {
  try {
    const data = {};
    for (const [userId, sess] of userSessions) {
      data[userId] = {
        sessionId: sess.sessionId,
        model: sess.model,
        autoLevel: sess.autoLevel,
      };
    }
    fs.writeFileSync(SESSION_FILE, JSON.stringify(data, null, 2));
  } catch (e) {
    console.error('[SESSION] Failed to save sessions:', e.message);
  }
}

// 启动时加载
loadSessions();
```

在以下时机调用 `saveSessions()`：
- 每次收到新的 session ID 时
- 执行 `/new` 清空会话时
- 执行 `/model` 切换模型时

**sessions.json 文件示例：**
```json
{
  "5989118323": {
    "sessionId": "1268a98b-3582-47da-87da-b58d19ae1579",
    "model": "custom:minimax-m2.7",
    "autoLevel": "high"
  }
}
```

**文件位置：** `/root/telegram-droid-bot/sessions.json`

**效果：**
- 重启 bot 服务 → 从 `sessions.json` 加载上次的 session ID → 自动延续对话上下文
- 重启云服务器 → 同上，只要没执行 `/new`，上下文一直保留

#### 坑 8：Telegram 持续显示 "typing" 状态

**现象：** 在 Telegram 中发消息后，聊天界面一直显示"正在输入..."（typing），即使 bot 已经回复了错误信息，typing 状态也不会消失。

**原因：** 消息处理代码中，`typing` 状态通过 `setInterval` 每 5 秒发送一次。但 `clearInterval` 放在了 `try` 块的正常流程中，而非 `finally` 块中。当 `callDroid()` 抛出异常（如 `droid exec` 返回 exit code 1）时，执行直接跳到 `catch` 块，`clearInterval` 被跳过，导致 typing 无限循环发送。

```javascript
// ❌ 错误写法：clearInterval 在 try 正常流程中
try {
  const ti = setInterval(()=>ctx.sendChatAction('typing').catch(()=>{}), 5000);
  const {stdout} = await callDroid(txt, s, cwd);  // 如果这里抛异常...
  clearInterval(ti);  // ...这行不会执行！
} catch(e) {
  await ctx.reply(`出错了: ${e.message}`);
} finally { s.processing=false; }

// ✅ 正确写法：clearInterval 在 finally 中确保必执行
let typingInterval = null;
try {
  await ctx.sendChatAction('typing');
  typingInterval = setInterval(()=>ctx.sendChatAction('typing').catch(()=>{}), 5000);
  const {stdout} = await callDroid(txt, s, cwd);
  // ... 处理回复 ...
} catch(e) {
  await ctx.reply(`出错了: ${e.message.slice(0,500)}`);
} finally {
  if (typingInterval) clearInterval(typingInterval);  // 无论成功失败都清理
  s.processing = false;
}
```

**触发场景：** `droid exec` 返回非零退出码（如 API 403、429、session 损坏等），`callDroid()` 抛出 Error，typing 定时器未被清理。

**修复日期：** 2026-04-15

#### 坑 9：Spec 模式与 session-id 冲突（2026-04-16 修复）

**现象：** 用户开启 `/spec on` 后发送消息，报错 `"Invalid flags: --session-id cannot be used with --use-spec or --spec-model. Spec mode is only supported for new sessions."`。连续发 5 条消息全部报同样的错，bot 完全不可用。

**根因：** `execDroid()` 函数中，当 `session.useSpec === true` 时添加 `--use-spec`，同时如果 `session.sessionId` 有值，又会添加 `-s <sessionId>`。droid CLI 明确禁止这两个标志同时使用——Spec 模式只支持新会话。

```javascript
// ❌ 修复前的代码（两个标志同时传入）
if (session.useSpec) args.push('--use-spec');
// ...
if (session.sessionId) args.push('-s', session.sessionId);  // spec + session-id 冲突！
```

**日志证据（2026-04-15 23:03:47）：**
```
[DROID] droid exec -m custom:minimax-m2.7 -o json --auto high --use-spec -s c10fed1d-... 什么问题？
[ERROR] Invalid flags: --session-id cannot be used with --use-spec or --spec-model.
```

**修复方案（两处改动）：**

1. **`/spec on` 命令**：开启 spec 时自动清空 `sessionId`（与 `/mission on` 行为一致）：

```javascript
// ✅ 修复：开启 spec 时清空 session
if (v==='on') {
  s.useSpec=true; s.sessionId=null; saveSessions();
  await ctx.reply('✅ Spec 已开启（会话已清空，spec 仅支持新会话）');
}
```

2. **`execDroid()` 防护**：即使 `sessionId` 不为 null，当 `useSpec` 为 true 时也不传 `-s`：

```javascript
// ✅ 防护：spec 模式下不传 session-id
if (useFork && session.sessionId) args.push('--fork', session.sessionId);
else if (session.sessionId && !session.useSpec) args.push('-s', session.sessionId);
```

**关键教训：** 任何涉及"仅支持新会话"的 droid exec 参数（如 `--use-spec`、`--spec-model`），必须在代码中同时处理 session-id 的排他逻辑。`/mission on` 的做法是正确的（自动清空 sessionId），Spec 模式修复后也采用了相同策略。

#### 坑 10：MCP 安装权限不足的连锁失败（2026-04-16 排查）

**现象：** 用户通过 Telegram 对话让 AI 安装爻财 MCP，连续出现三种不同错误：

| # | 报错 | 时间 |
|---|------|------|
| 1 | `insufficient permission to proceed. Re-run with --auto low|medium|high` | 23:14:39 |
| 2 | `TimeoutError: Promise timed out after 90000 milliseconds` | 23:17:56 |
| 3 | `Process exited with code 1` / `code null` | 21:07:04（更早） |

**根因分析：** 不是 `--auto high` 权限不够（high 已是最高），而是三个独立问题叠加：

**问题 1：使用了已损坏的 session**
- 用户之前开启了 Spec 模式，连续 5 次报错后 session 状态异常
- 后续请求携带了该损坏的 `-s ce233423...` session
- droid 在损坏的 session 上下文中执行时直接以"权限不足"拒绝

```
# 日志证据：带了损坏的 session ID
[DROID] droid exec -m custom:minimax-m2.7 -o json --auto high -s ce233423-... 不用这样，我有一个MCP...
[ERROR] Exec ended early: insufficient permission to proceed.
```

**问题 2：MiniMax 模型处理复杂多步骤任务超时**
- 第二次尝试（新会话、不带 `-s`），droid exec 执行了 90 秒还未完成
- MiniMax 模型在处理"读取配置文件 → 理解 MCP 格式 → 写入文件 → 验证"这种多轮工具调用时容易超时

**问题 3：错误信息误导**
- 报错说"insufficient permission"，但实际上是 session 损坏而非权限不足
- 这让用户和 AI 都误以为是 `--auto` 等级的问题

**解决方案：新增 `/mcp` 命令直接管理 MCP**

不再通过 AI 对话安装 MCP，而是直接调用 `droid mcp add` CLI 命令：

```javascript
// /mcp add yaocai https://app.yaocai.cool/mcp --header "Authorization: Bearer xxx"
const {code, stdout, stderr} = await runDroidCli(['mcp','add',name,url,'--type','http',...headerArgs], 15000);
```

**关键教训：**
- MCP 安装等敏感配置操作不应通过 AI 对话（让模型去操作文件），应直接调用 CLI
- 当看到"insufficient permission"时，要考虑 session 损坏的可能，而非仅怀疑 `--auto` 等级
- 复杂操作建议先执行 `/new` 清空会话，避免污染的 session 导致连锁失败

### 7.3 注意事项

1. **同一个 Bot Token 冲突** — 不能同时运行 telegram-minimax-bot 和 telegram-droid-bot，必须停掉一个再启动另一个
2. **会话持久化** — session ID 持久化到 `/root/telegram-droid-bot/sessions.json`，重启服务/服务器后自动恢复上下文（执行 `/new` 才会清空）
3. **消息长度** — 超过 4000 字符的回复会自动分段发送
4. **超时设置** — 默认 120 秒，复杂任务可能需要更长时间（通过 `/timeout` 调整）
5. **推理输出过滤** — 已自动过滤 `<thought>` 和 `<think/>` 标签内容
6. **处理中的请求** — 同一用户同时只能处理一个请求，多个请求会排队提示

---

## 八、如何恢复旧方案

如果需要切换回纯 MiniMax 方案（v2）：

```bash
systemctl stop telegram-droid-bot
systemctl start telegram-minimax-bot
```

如果需要切换回 cc-connect 方案（v1）：

```bash
systemctl stop telegram-droid-bot
export FACTORY_API_KEY=你的Factory API Key
nohup /usr/local/bin/cc-connect > /root/cc-connect.log 2>&1 &
```

---

#### 坑 11：Session 损坏导致空输出 crash（2026-04-20 修复）

**现象：** 用户在 Telegram 发送任何消息，连续收到 `出错了: Process exited with code 1`。日志显示 `droid exec -s 44fbf7e5-... 你好` 返回 code 1，但 stdout 和 stderr 均为空。之前连续出现 "insufficient permission" 错误后 session 被彻底污染。

**根因：** session `44fbf7e5-...` 在之前遇到多次 "insufficient permission" 错误后进入了不可恢复的状态。droid exec 用这个 session 调用时直接 crash（exit code 1），**stdout 和 stderr 完全为空**，没有 JSON 输出也没有错误文本。

**为什么之前的检测失效：** `isSessionCorrupted()` 只检查 JSON 输出中的关键字（403/forbidden/upstream error/insufficient permission），但这次 droid crash 后**完全没有输出**，所以检测函数收到空字符串，无法匹配任何关键字，返回 `false`，导致三级重试逻辑完全跳过。

**日志证据（2026-04-20 08:22:30）：**
```
[DROID] droid exec -m custom:minimax-m2.7 -o json --auto high -s 44fbf7e5-... 你好
[ERROR] Process exited with code 1
# 注意：没有 "Session corrupted" 日志，因为 isSessionCorrupted 返回 false
```

**手动验证：**
```bash
# 带 session → crash（空输出，exit 1）
$ droid exec -m custom:minimax-m2.7 -o json --auto high -s 44fbf7e5-... "你好"
# (exit code 1, stdout="", stderr="")

# 不带 session → 正常
$ droid exec -m custom:minimax-m2.7 -o json --auto high "测试"
{"type":"result","subtype":"success",...}  # ✅ 正常返回
```

**修复方案（两处改动）：**

1. **扩展 `isSessionCorrupted()` 检测范围**：新增对 "insufficient permission" 和 "Exec ended early" 的文本检测（不仅检查 JSON，也检查纯文本）：

```javascript
// ✅ 新增：文本级别的错误检测
const lower = (stdout||'').toLowerCase();
if (lower.includes('insufficient permission') || lower.includes('exec ended early')) return true;
```

2. **新增"空输出 crash"检测**：当 exit code !== 0 且 stdout/stderr 都为空时，也视为 session 损坏：

```javascript
// ✅ 新增：空输出 + code 1 = session crash
const isEmptyCrash = result.code !== 0 && !result.stdout.trim() && !result.stderr.trim();
if (result.code!==0 && session.sessionId && (isSessionCorrupted(combinedOutput) || isEmptyCrash)) {
  // 自动 fork / 清空重建
}
```

**关键教训：** session 损坏的表现形式不止一种：
- 有 JSON 输出 + 错误关键字 → `isSessionCorrupted` 能检测 ✅
- 有 stderr 文本 + 错误关键字 → 需要检查 stderr ✅（本次新增）
- 完全空输出 + crash → 需要检测"空输出" ✅（本次新增）
- 未来可能还有新形式 → 建议：任何 exit code !== 0 且有 sessionId 的情况，都尝试 fork 一次

**同日其他修复（2026-04-20）：**

| 修复项 | 说明 |
|--------|------|
| 新增 `/skill` 命令 | 查看已安装 Skills、查看详情、安装/卸载（补文件系统删除 + `droid skill` CLI 双通道） |
| 新增图片识别 | `bot.on('photo')` 处理器，自动下载图片传给 droid；custom model 不支持图片时提示切换模型 |
| `isSessionCorrupted` 扩展 | 新增 "insufficient permission"、"Exec ended early" 文本检测 + 空输出 crash 检测 |
| Telegram 菜单更新 | 注册 19 个命令（新增 `/skill`） |

---

## 更新日志

| 日期 | 更新内容 |
|------|---------|
| 2026-04-13 | 初始创建 v1（cc-connect）和 v2（telegram-minimax-bot） |
| 2026-04-14 | 创建 v3（telegram-droid-bot），通过 droid exec + custom model 实现 Telegram 对话，不消耗 Factory 配额 |
| 2026-04-14 | 修复上下文丢失问题：改用 `-o json` 获取 session ID；新增 `sessions.json` 文件持久化，重启服务/服务器后自动恢复对话上下文 |
| 2026-04-15 | 修复 typing 状态卡住不消失的 bug：将 clearInterval 移入 finally 块；新增项目架构概述文档 |
| 2026-04-15 | 记录定时功能已知问题与 OpenClaw Cron 对比分析，待后续修复 |
| 2026-04-16 | 修复 Spec 模式与 session-id 冲突（坑 9）：`/spec on` 自动清空 sessionId；`execDroid()` 增加 useSpec 防护 |
| 2026-04-16 | 排查 MCP 安装权限不足问题（坑 10）：确认是 session 损坏导致，非权限不足 |
| 2026-04-16 | 新增 `/mcp` 命令（add/remove/list），直接调用 `droid mcp` CLI 管理 MCP 服务器 |
| 2026-04-16 | 新增 `/plugin` 命令（list/install/remove/update/marketplace），直接调用 `droid plugin` CLI 管理插件 |
| 2026-04-16 | 注册 18 个命令到 Telegram 聊天框侧栏菜单；新增复刻指南和 Skills 打包经验 |
| 2026-04-16 | 修复定时功能 5 个问题（参考 OpenClaw Cron）：时间窗口容差(3分钟)、lastFiredAt 防重复触发、过期 once 自动清理(5分钟)、exec 任务失败重试(3次指数退避)、时区统一为本地时间、全局锁防并发 |
| 2026-04-20 | 修复 session 损坏空输出 crash（坑 11）：droid exec crash 无输出时 isSessionCorrupted 检测不到，新增空输出 crash 检测 |
| 2026-04-20 | 新增 `/skill` 命令（list/info/install/remove/marketplace），支持文件系统直接删除和 `droid skill` CLI 双通道 |
| 2026-04-20 | 新增图片识别支持：`bot.on('photo')` 自动下载图片传给 droid，custom model 不支持图片时提示切换模型 |
| 2026-04-20 | 扩展 `isSessionCorrupted` 检测：新增 "insufficient permission"、"Exec ended early"、空输出 crash 三种情况 |
| 2026-04-20 | 注册 19 个命令到 Telegram 菜单（新增 `/skill`） |
| 2026-05-06 | 修复 3 个提醒 Bug：空输出重试 + 周提醒重复 + 遗漏补救 |
| 2026-05-07 | 提醒系统架构重构：删除正则拦截 + 新增 remind-cli + 修复 weekly/monthly day 检查 bug |
| 2026-05-07 | AGENTS.md 添加 remind-cli 和 mmx vision 使用说明 |
| 2026-05-11 | 修复 Bug #1：黄弟兄提醒每天发 — run_daily_news.sh 删除 source send_telegram_huang.sh |
| 2026-05-11 | 修复 Bug #2：提醒发到错误 chatId — text/photo handler 注入 chatId 到 Droid 上下文 |
| 2026-05-11 | 修复提醒系统 Bug A/B/C/D：remind-cli 加时间格式验证+规范化+类型校验+day范围检查 |
| 2026-05-11 | remind-cli 新增 --json 结构化输出模式，Droid 可感知错误并自动重试 |
| 2026-05-11 | 修复 Bug #3：Droid 语义理解错误，单次提醒被设为 daily — ctxNote 注入类型默认规则（坑 16） |
| 2026-05-11 | **图片处理逻辑重构**：移除模型支持检查，图片始终传给 Droid 处理，让 Droid 根据 AGENTS.md 规则决定用 mmx vision 分析或 curl 上传到电商（坑 17） |
| 2026-05-13 | **修复 processing 锁死 bug**：Telegraf handlerTimeout(90s) < spawn DROID_TIMEOUT(120s) 导致 finally 不执行，processing 永久锁死。handlerTimeout 改为 0，spawn 添加 SIGKILL 兜底，/stop 命令增强杀子进程（坑 18） |
| 2026-05-13 | **checkProcessingStuck 改进**：基于进程存活状态判断卡死而非硬编码5分钟，正常长任务（进程存活）不打断，进程已死/僵尸才自动重置（坑 19） |

---

#### 坑 17：图片处理逻辑重构 — 移除模型支持检查（2026-05-11）

**现象：** 用户在 Telegram 发送图片 + 文字"上传这张产品图到 Meme Plush 01 产品中"，bot 回复"⚠️ 当前模型不支持图片识别"，图片无法处理。

**根因：** `handlePhoto()` 函数中有模型支持检查：
```javascript
// 旧逻辑
const noImageModels = Object.values(CUSTOM_MODELS);
const modelSupportsImage = !noImageModels.includes(s.model);
if (!modelSupportsImage) {
  await ctx.reply('⚠️ 当前模型不支持图片识别...');
  return;  // ← 直接退出，图片丢失
}
```

当使用默认模型 `custom:minimax-m2.7`（不支持图片分析）时，图片直接被丢弃，无法传给 Droid 处理。

**问题本质：** 图片处理需求分为两种：
1. **图片分析** — 需要模型支持图片（如 claude-sonnet、gpt54、gemini-pro）
2. **图片上传/操作** — 不需要模型支持图片，只需要 Droid 有工具能力（如上传到电商网站）

用户的"上传产品图"需求属于第二种，但旧逻辑把两种需求混在一起处理了。

**修复方案：** 移除模型支持检查，将图片路径和处理规则传给 Droid，让 Droid 自己决定：

```javascript
// 新逻辑
const caption = ctx.message.caption || '';
let prompt = `[图片已保存到: ${tmpPath}]\n`;
if (caption) {
  prompt = caption + '\n' + prompt;
}
// 添加图片处理指引
prompt += `\n[图片处理规则]：
- 如果需要分析图片内容，请使用: mmx vision --file ${tmpPath}
- 如果需要上传到电商网站，请按照 AGENTS.md 中的「电商产品图片上传」规则执行
- 图片临时路径在对话结束后会自动删除，如需保留请及时处理`;
```

**修复效果：**
- 用户发图 + "上传到产品" → Droid 调用 curl 上传图片到电商存储
- 用户发图 + "这是什么？" → Droid 调用 mmx vision 分析图片内容
- 两种需求都能正常处理，不再因模型不支持图片而中断

**关键教训：**
- 不要在 bot 层面过早拦截，让 Droid 有机会根据 AGENTS.md 规则智能处理
- 图片处理需求要区分"分析"和"操作"两种类型
- 文档驱动：通过 AGENTS.md 定义规则，让 Droid 理解如何处理图片

**改动文件：** `/root/telegram-droid-bot/index.js` — `handlePhoto()` 函数（约 15 行）

---

#### 坑 18：Telegraf handlerTimeout 与 spawn DROID_TIMEOUT 不一致导致 processing 锁死（2026-05-13）

**现象：** 用户在 Telegram 发送任何消息，都回复"⏳ 上一个请求还在处理中..."，bot 完全不可用。

**根因：** Telegraf v4.16.3 默认 `handlerTimeout=90s`，而 spawn 的 `DROID_TIMEOUT=120s`。当 droid exec 超过90秒时：

1. Telegraf 的 `pTimeout` 在90秒时 reject 外层 Promise → 日志显示 `[BOT ERROR] TimeoutError`
2. 但内层 handler 的 async 函数**仍在运行**（`callDroid()` 还在等 spawn 返回）
3. spawn 的120秒超时虽然发了 SIGTERM 给 droid 进程，但 droid 进程**没有退出**（忽略 SIGTERM 或卡住）
4. spawn promise 永远不 resolve，handler 的 `finally` 块**永远不执行**
5. `s.processing` 永远停留在 `true`
6. 所有后续消息都被拦截：`⏳ 上一个请求还在处理中...`

**日志证据（2026-05-13 10:20:10）：**
```
[DROID] droid exec -m custom:minimax-m2.7 -o json --auto high -s 8fcd4a04-... -f /tmp/droid_prompt_xxx.txt (cwd: /root/Peter工作空间)
[BOT ERROR] TimeoutError: Promise timed out after 90000 milliseconds
# 之后所有消息都返回 "⏳ 上一个请求还在处理中..."
```

**进程证据：**
```
PID 3768948 运行1小时51分钟，状态 Sl（睡眠/卡住）
命令: /root/.local/bin/droid exec -m custom:minimax-m2.7 -o json --auto high -s 8fcd4a04-... -f /tmp/droid_prompt_xxx.txt
```

**修复方案（4处改动）：**

1. **增加 Telegraf handlerTimeout**：设为 0（无限），由 spawn 的 `DROID_TIMEOUT` 统一控制超时：
```javascript
// 之前
const bot = new Telegraf(TELEGRAM_BOT_TOKEN);
// 之后
const bot = new Telegraf(TELEGRAM_BOT_TOKEN, { handlerTimeout: 0 });
```

2. **execDroid() 添加进程追踪 + SIGKILL 强杀**：spawn timeout 只发 SIGTERM，5秒后还没退出则 SIGKILL：
```javascript
session.currentProc = proc;  // 将进程引用存到 session 上
// spawn timeout 只发 SIGTERM，5秒后还没退出则 SIGKILL 强杀
const killTimer = setTimeout(() => {
  if (!resolved && proc.pid) {
    console.log(`[DROID] Process ${proc.pid} still alive after SIGTERM, sending SIGKILL...`);
    proc.kill('SIGKILL');
  }
}, DROID_TIMEOUT + 5000);
```

3. **/stop 命令增强**：同时杀掉 droid 子进程：
```javascript
bot.command('stop', async ctx => {
  ...
  if (s.currentProc && s.currentProc.pid) {
    s.currentProc.kill('SIGKILL');
    s.currentProc = null;
  }
  s.processing=false; s.processingSince=null; s.currentProc=null; s.sessionId=null;
  ...
});
```

4. **新增 processingSince 时间戳 + 过期自动检测**：在 `s.processing=true` 时记录时间戳，handler 入口检查是否超时卡死（详见坑 19）。

**关键教训：**
- 框架默认超时和自定义超时必须协调，外层超时 < 内层超时会导致 finally 不执行
- spawn timeout 只发 SIGTERM，不保证进程退出，需要 SIGKILL 兜底
- 进程引用必须追踪，否则无法在 `/stop` 时杀掉卡住的子进程

**修复日期：** 2026-05-13

---

#### 坑 19：checkProcessingStuck 改进 — 区分正常长任务 vs 真正卡死（2026-05-13）

**背景：** 坑 18 修复后新增了 `checkProcessingStuck()` 函数，初始实现用硬编码5分钟判断是否"卡死"。

**问题：** 用户可能用 `/timeout 600` 设置10分钟超时来运行复杂任务（如多步代码生成），5分钟的硬编码超时会误杀正常长任务。

**无法区分的场景：**

| 场景 | processing 时长 | droid 进程状态 | 应该怎么做 |
|------|----------------|---------------|-----------|
| 正常长任务 | >5分钟 | **存活**，还在产出 | 不应该杀 |
| 进程卡死 | >5分钟 | **已死**或僵尸 | 应该重置 |
| 进程已退出但 finally 没执行 | >5分钟 | **不存在** | 应该重置 |

**修复方案：** 基于进程存活状态判断，而非纯时间：

```javascript
function checkProcessingStuck(s) {
  if (!s.processing) return false;

  // 检查 droid 子进程是否还活着（signal 0 不发信号，只检查进程是否存在）
  let procAlive = false;
  if (s.currentProc && s.currentProc.pid) {
    try { process.kill(s.currentProc.pid, 0); procAlive = true; } catch(e) {}
  }

  if (procAlive) {
    // 进程还活着 → 可能是正常长任务
    // 兜底：超过 3x DROID_TIMEOUT 视为僵尸（spawn timeout + SIGKILL 都失效的极端情况）
    const zombieLimit = DROID_TIMEOUT * 3;
    if (s.processingSince && Date.now() - s.processingSince > zombieLimit) {
      s.currentProc.kill('SIGKILL');
      s.currentProc = null;
      s.processing = false; s.processingSince = null;
      return true;
    }
    return false; // 进程活着且未超 3x timeout → 正常长任务，不打断
  }

  // 进程不存在 → processing 应该已被 finally 清掉
  // 如果还在 processing，说明 finally 没执行，需要手动重置
  const stuckLimit = DROID_TIMEOUT + 10000; // DROID_TIMEOUT + 10s 缓冲
  if (s.processingSince && Date.now() - s.processingSince > stuckLimit) {
    s.currentProc = null;
    s.processing = false; s.processingSince = null;
    return true;
  }

  return false;
}
```

**检测逻辑总结：**

| 情况 | 进程状态 | 时间判断 | 动作 |
|------|---------|---------|------|
| 正常长任务 | 存活 | < 3x DROID_TIMEOUT | **不打断** |
| 僵尸进程 | 存活但不产出 | > 3x DROID_TIMEOUT | SIGKILL + 重置 |
| 进程已死但 processing 没清 | 不存在 | > DROID_TIMEOUT + 10s | 重置 processing |
| 刚开始处理 | 任意 | < DROID_TIMEOUT | 不干涉 |

**关键教训：**
- 不要用硬编码时间判断卡死，应该检查进程实际存活状态
- `process.kill(pid, 0)` 可以非侵入式检查进程是否存在（不发信号）
- 兜底超时应与用户设定的 `DROID_TIMEOUT` 挂钩，而非固定值

**修复日期：** 2026-05-13

**Bug1 — 空输出无内容**
- 现象：droid 回复"Droid 没有返回内容"
- 根因：sessions.json 损坏时 droid crash 且 stdout/stderr 全空，isSessionCorrupted 检测不到
- 修复：callDroid() 在 code=0 但 stdout/stderr 全空时自动 retry 一次；parseDroidOutput() 保留 raw 输出兜底

**Bug2 — 周提醒每天重复**
- 现象：每周三的提醒，周四周五也触发
- 根因：checkDueReminders() 没有检查 r.day（星期几），parseReminderTargetTime() 只用 HH:MM 构造当天时间
- 修复：`if (r.type==='weekly' && now.getDay() !== r.day) continue;`

**Bug3 — 一次性提醒遗漏**
- 现象：5月17日提醒完全没触发
- 根因：once 类型的 catchup 窗口只有 3 分钟（与周期类型混用同一 WINDOW_MS）
- 修复：once 类型使用 EXPIRE_MS（5分钟）作为 catchup 窗口

---

#### 坑 13：提醒系统架构重构 — 自然语言→Droid语义→remind-cli（2026-05-07）

**背景：** 用户说"提醒我明天7点浇花" → bot 转发给 droid → droid 回复"已设置！"但实际没有调用任何保存函数

**最初错误修复：** 用 tryHandleNaturalReminder 正则拦截"提醒我..."文本，但正则有 6 个 bug（m1/m2 反转、兜底太贪、now 污染、中文时间不支持、分钟后不支持、空格不容错），导致：
- 周期类型每次都走兜底（匹配混乱）
- weekly/monthly 每天触发（因为正则只拦截 text，没有更新 lastFiredAt）

**架构重构方案：**
1. 删除 tryHandleNaturalReminder（约120行正则拦截代码）
2. 新建 `/root/telegram-droid-bot/remind-cli.js` — 独立 CLI，droid 通过 Execute 工具调用
3. AGENTS.md 添加 remind-cli 使用说明，让 droid 理解"设置提醒 → 调用 remind-cli"
4. setInterval 开头重载 reminders.json（感知外部 direct write）

**关键教训：**
- 不要用正则解析自然语言，让 LLM 做语义理解
- 提醒系统的 day 字段必须在触发检查中验证
- droid 说"已设置"不等于真的设置了，必须有工具调用链路

---

#### 坑 14：提醒发错 chatId + 黄弟兄提醒每天发（2026-05-11）

**Bug #1 — 黄弟兄提醒每天触发**
- 现象：每天早上 7:30 收到"⏰ 提醒：给黄弟兄发信息，提醒他来参加聚会"
- 根因：`run_daily_news.sh` 有 `source send_telegram_huang.sh` 一行，意图是获取 BOT_TOKEN，但该脚本执行了 curl 发送消息，每天触发一次副作用
- 修复：删除 `run_daily_news.sh` 中的 `source` 那两行（`daily_ai_news.py` 直接读 `/tmp/token.txt`，不需要 shell 的 BOT_TOKEN）

**Bug #2 — Droid 调用 remind-cli 时使用错误的 chatId**
- 现象：在家庭群（chatId=-1003872540185）设的提醒发到 Peter 私聊（chatId=5989118323）
- 根因：Droid 接收的是纯文本消息，不知道当前会话的 chatId，只能依靠 AGENTS.md 示例中的 chatId（私聊 ID）
- 修复：bot text handler 和 photo handler 在调用 `callDroid` 前注入 `[系统: 当前会话 chatId=XXX (标签)]`，Droid 必须使用该值

**教训：** 任何跟上下文（chatId、工作目录、用户身份）相关的信息都必须由 bot 主动注入，不能依赖 Droid 猜测或记忆。

---

#### 坑 15：remind-cli 4 个静默失效 Bug + 永久修复（2026-05-11）

**Bug A — daily/weekly/monthly 传全日期格式 → Invalid Date → 提醒永远不触发（Critical）**
- 根因：Droid 有时对所有类型都用 "YYYY-MM-DD HH:MM" 格式；`parseReminderTargetTime` 对 daily 类型按 `:` 分割，得到 "2026-05-12 09" 作为小时 → NaN
- 修复：remind-cli 自动提取 HH:MM 部分（正则 `/^\d{4}-\d{2}-\d{2} (\d{1,2}:\d{2})$/` 匹配则提取）

**Bug B — once 类型只传 HH:MM → parseReminderTargetTime 返回 null → 永远不触发（Critical）**
- 修复：自动推断日期（时间已过则用明天），规范化为 "YYYY-MM-DD HH:MM"

**Bug C — /remind HH:MM 假设今天，若时间已过创建过期提醒（Moderate）**
- 现象：用户晚上9点发 `/remind 07:00 内容`，提醒被创建为今天07:00（已过），下次 tick 被清理，用户收到"提醒已过期"通知
- 修复：index.js `/remind` 处理器中，若 HH:MM 构造的时间已过，自动推到明天

**Bug D — remind-cli 不验证 type/day 合法性，静默存储无效提醒（Moderate）**
- 修复：新增 type 验证（必须为 once/daily/weekly/monthly）、day 范围验证（weekly: 0-6，monthly: 1-31）

**永久性修复 — remind-cli --json 结构化输出模式**
- 问题根源：remind-cli 输出自由文本，Droid 无法感知是否成功，错误静默丢失
- 方案：新增 `--json` 参数，所有操作输出结构化 JSON：
  ```json
  // 成功
  {"status":"ok","reminder":{"id":"...","chatId":"...","time":"09:00","type":"daily",...}}
  // 失败（含修正提示）
  {"status":"error","code":"INVALID_TIME_FORMAT","message":"...","hint":"正确示例: --time \"09:00\" --type daily"}
  ```
- Droid 遇到 `"status":"error"` 必须根据 `hint` 修正后重试，形成验证闭环
- AGENTS.md 强制要求所有 remind-cli 调用加 `--json` 参数

---

#### 坑 16：Droid 语义歧义 — 单次提醒被设为 daily（2026-05-11）

**现象：** 用户说"11:20分提醒发信息"（没有说每天），Droid 创建了 `type: daily`（每天11:20），而不是 `type: once`（一次性）

**根因 1 — Droid 无默认规则：** AGENTS.md 有时间格式规则，但未明确"没有周期词时默认 once"，Droid 歧义时选了 daily

**根因 2 — AGENTS.md 规则对老 session 无效：** 更新 AGENTS.md 后，Droid 仍在使用旧 session（`-s sessionId`），旧 session 不会重新读 AGENTS.md，新规则对它不可见

**修复：** 将类型默认规则从 AGENTS.md 移到 `ctxNote`（每条消息注入），无论 session 新旧都能看到：
```javascript
// index.js text handler & photo handler
const ctxNote = `[系统: chatId=${chatId}；调用 remind-cli 时请加 --json；提醒类型默认规则：除非用户明确说了"每天/每周/每月"等周期词，否则一律用 --type once（一次性），不要猜测]`;
```

**同步操作：** 清空了家庭群的旧 Droid session（sessions.json 中 `5989118323_-1003872540185` 的 sessionId 置 null），重启 bot

**关键教训：**
- AGENTS.md 只对新 session 生效。需要对所有 session 实时生效的规则，必须放入 ctxNote（每条消息注入）
- Droid 在语义歧义时会选自以为合理的选项，对于有默认值含义的参数必须在 ctxNote 里明确约束

---

## 多通道复刻指南

> 创建时间: 2026-04-16
> 目的: 如果需要将同一套架构复刻到其他聊天平台（如 WhatsApp），此文档提供完整的复刻蓝图。也作为打包成 Skills 给其他人使用的参考。

## 一、架构模式总结

整个系统的核心是一个**消息中转层**，连接"聊天平台"和"Droid CLI"：

```
┌──────────────┐     ┌─────────────────────────┐     ┌──────────────┐
│  聊天平台     │ ←→  │  Node.js 中转层          │ ←→  │  Droid CLI   │
│  (Telegram)  │     │  (telegraf + spawn)      │     │  (droid exec) │
│              │     │                          │     │      ↓        │
│  以后可以是:  │     │  核心职责:                │     │  大模型 API   │
│  - WhatsApp  │     │  1. 接收/发送消息          │     │  (MiniMax等)  │
│  - Line      │     │  2. 会话管理 (sessionId)   │     │              │
│  - Slack     │     │  3. 命令路由               │     │              │
│  - Discord   │     │  4. 权限控制               │     │              │
│  - 微信       │     │  5. 上下文路由 (cwd)       │     │              │
│  - 飞书       │     │  6. typing 状态管理        │     │              │
│  - 钉钉       │     │  7. 定时任务调度           │     │              │
└──────────────┘     └─────────────────────────┘     └──────────────┘
```

**关键洞察：中转层是平台无关的。** 只需要替换"聊天平台适配器"（即消息收发部分），其余逻辑（会话管理、droid 调用、命令路由）可以完全复用。

## 二、需要替换的部分（平台适配层）

| 组件 | Telegram (当前) | WhatsApp (示例) | Slack (示例) |
|------|----------------|-----------------|-------------|
| 框架 | telegraf | whatsapp-web.js / Baileys | @slack/bolt |
| 消息接收 | `bot.on('text', ...)` | `client.on('message', ...)` | `app.message(...)` |
| 消息发送 | `ctx.reply(text)` | `client.sendMessage(chatId, text)` | `say(text)` |
| Typing 状态 | `ctx.sendChatAction('typing')` | `chat.sendState('composing')` | 无直接支持 |
| 命令识别 | `/command` 格式 | 需要自己解析 `!command` 或 `/command` | `/command` 格式（Slash Commands） |
| 菜单注册 | Bot API `setMyCommands` | 无（自己实现帮助文本） | Slack App 配置 |
| 长连接方式 | 长轮询 (telegraf) | WebSocket (Baileys) | Socket Mode / HTTP |
| 文件/图片 | `ctx.message.photo` | `message.hasMedia` | `message.files` |
| 群组/私聊 | `ctx.chat.type` | `message.from.me` / group JID | `channel` / `im` |

## 三、可以完全复用的部分（平台无关逻辑）

以下代码可以直接复制到新通道项目中，无需修改：

1. **`execDroid()` 函数** — spawn droid exec 的逻辑
2. **`callDroid()` 函数** — 三级重试机制
3. **`parseDroidOutput()` 函数** — JSON 解析 + thinking 标签过滤
4. **`isSessionCorrupted()` 函数** — session 损坏检测
5. **会话管理** — `loadSessions()` / `saveSessions()` / `getUserSession()`
6. **定时任务** — reminders 的完整逻辑
7. **`runDroidCli()` 函数** — 直接调用 droid CLI（用于 /mcp /plugin 命令）
8. **模型列表** — `CUSTOM_MODELS` / `BUILTIN_MODELS` / `MODEL_REASONING`
9. **环境变量配置** — `DROID_ENV` / `DROID_PATH` / `DROID_TIMEOUT`
10. **上下文路由** — `GROUP_CONFIGS` / `getCwdForChat()` / `getLabelForChat()`

## 四、复刻步骤（以 WhatsApp 为例）

### 步骤 1：创建项目

```bash
mkdir -p /root/whatsapp-droid-bot
cd /root/whatsapp-droid-bot
npm init -y
npm install @whiskeysockets/baileys pino
```

### 步骤 2：从 telegram-droid-bot 复制平台无关代码

```bash
# 复制核心逻辑（不需要 telegraf 依赖的部分）
# 从 index.js 中提取以下函数：
# - execDroid, callDroid, parseDroidOutput, isSessionCorrupted
# - runDroidCli
# - 会话管理: loadSessions, saveSessions, getUserSession, getSessionKey
# - 提醒功能: 全部
# - 配置常量: CUSTOM_MODELS, BUILTIN_MODELS, DROID_ENV 等
```

### 步骤 3：编写平台适配层

```javascript
const { default: makeWASocket, useMultiFileAuthState } = require('@whiskeysockets/baileys');

// WhatsApp 连接
const { state, saveCreds } = await useMultiFileAuthState('./auth');
const sock = makeWASocket({ auth: state, printQRInTerminal: true });
sock.ev.on('creds.update', saveCreds);

// 消息接收 → 替代 bot.on('text')
sock.ev.on('messages.upsert', async ({ messages }) => {
  const msg = messages[0];
  if (!msg.message || msg.key.fromMe) return;
  const text = msg.message.conversation || msg.message.extendedTextMessage?.text || '';
  const chatId = msg.key.remoteJid;  // 如 "8613800138000@s.whatsapp.net"

  // 命令识别（WhatsApp 没有内置命令系统）
  if (text.startsWith('/')) { /* 路由到命令处理器 */ }
  else { /* 路由到 callDroid() */ }
});

// 消息发送 → 替代 ctx.reply()
await sock.sendMessage(chatId, { text: responseText });

// Typing 状态 → 替代 ctx.sendChatAction('typing')
await sock.sendPresenceUpdate('composing', chatId);
```

### 步骤 4：创建 systemd 服务

```ini
[Unit]
Description=WhatsApp Droid Bot
After=network.target

[Service]
Type=simple
User=root
WorkingDirectory=/root/whatsapp-droid-bot
Environment="DROID_MODEL=custom:minimax-m2.7"
Environment="DROID_PATH=/root/.local/bin/droid"
# ... 其他环境变量同 telegram-droid-bot ...
ExecStart=/root/.nvm/versions/node/v22.22.0/bin/node /root/whatsapp-droid-bot/index.js
Restart=always
RestartSec=5

[Install]
WantedBy=multi-user.target
```

## 五、关键设计原则（给复刻者）

### 5.1 命令注册顺序

**必须先注册命令处理器，再注册通用消息处理器。** 这对 Telegraf 等按注册顺序匹配的框架至关重要：

```javascript
// ✅ 正确顺序
bot.command('new', ...);
bot.command('model', ...);
bot.on('text', ...);   // 最后注册，兜底

// ❌ 错误顺序
bot.on('text', ...);   // 会拦截所有消息
bot.command('new', ...); // 永远收不到
```

### 5.2 spawn 的 PATH 问题

systemd 启动的服务**不会继承用户的 PATH**，必须在 spawn 的 env 中显式设置：

```javascript
const DROID_ENV = {
  ...process.env,
  PATH: '/root/.local/bin:/root/.nvm/versions/node/v22.22.0/bin:/usr/local/bin:/usr/bin:/bin',
  HOME: '/root',
};
```

### 5.3 systemd 与 .bashrc 的隔离

systemd 服务**不会 source `.bashrc`**，所有环境变量必须在 service 文件中用 `Environment=` 显式配置。否则 droid 找不到 API key。

### 5.4 会话键值设计

使用 `userId_chatId` 组合键，避免同一用户在不同聊天上下文中串会话。

### 5.5 涉及"仅新会话"的 droid 参数

`--use-spec` 和 `--spec-model` 不兼容 `-s`（session-id）。在代码中必须在两个层面防护：
1. 开启时自动清空 sessionId
2. `execDroid()` 中当参数激活时跳过 `-s`

### 5.6 配置操作不要让 AI 做

MCP 安装、插件管理这类配置操作，直接调用 CLI（`droid mcp add`、`droid plugin install`）比让 AI 通过对话去做更可靠。原因：
- AI 对话走 `droid exec`，受 session 状态、超时、模型能力影响
- CLI 直接调用是原子操作，15 秒内完成

## 六、打包成 Skills 的经验

### 6.1 什么是 Skills

Factory Droid 的 Skills 是一种可分享的自动化配置，其他用户可以通过 `droid plugin install` 安装使用。我们的 Telegram Bot 架构也可以打包成 Skill。

### 6.2 打包思路

将平台无关的核心逻辑抽取为独立模块，加上平台适配模板：

```
droid-chat-channel/
├── core/                    # 平台无关逻辑（直接复用）
│   ├── droid-exec.js        # execDroid, callDroid, parseDroidOutput, isSessionCorrupted
│   ├── session.js           # 会话管理 (load, save, get)
│   ├── reminders.js         # 定时任务逻辑
│   ├── models.js            # 模型列表、权限映射
│   └── cli.js               # runDroidCli (MCP/插件管理)
├── adapters/                # 平台适配层（每个通道一个）
│   ├── telegram.js          # telegraf 适配
│   ├── whatsapp.js          # Baileys 适配（模板）
│   ├── slack.js             # @slack/bolt 适配（模板）
│   └── line.js              # LINE Messaging API 适配（模板）
├── config/                  # 配置模板
│   ├── systemd.service.tpl  # systemd 服务模板
│   └── .env.example         # 环境变量示例
├── index.js                 # 入口：根据平台选择适配器
├── package.json
└── README.md
```

### 6.3 配置模板变量

打包时需要将硬编码的值抽取为模板变量：

| 当前硬编码 | 模板变量 | 说明 |
|-----------|---------|------|
| `5989118323` | `${ALLOWED_USERS}` | 允许的用户 ID |
| `/root/Peter工作空间` | `${PRIVATE_CWD}` | 私聊工作目录 |
| `/root/家庭工作空间` | `${GROUP_CWD}` | 群聊工作目录 |
| `-3872540185` | `${GROUP_CHAT_IDS}` | 群聊 ID 列表 |
| `8629226331:AA...` | `${BOT_TOKEN}` | 平台 Bot Token |
| `/root/.local/bin/droid` | `${DROID_PATH}` | droid CLI 路径 |

### 6.4 安装后一键配置

用户安装 Skill 后，执行一个配置脚本：

```bash
# 用户只需要填写这些
export BOT_TOKEN="你的Token"
export ALLOWED_USERS="你的用户ID"
export PRIVATE_CWD="/home/user/my-workspace"

# 然后一键部署
npx droid-chat-channel setup --platform telegram
# → 自动生成 index.js、systemd service、sessions.json
# → 自动注册 Telegram 命令菜单
# → systemctl start droid-chat-bot
```

### 6.5 多通道并行

Skill 支持同时运行多个通道：

```bash
# 同时运行 Telegram + WhatsApp
npx droid-chat-channel setup --platform telegram --name tg-bot
npx droid-chat-channel setup --platform whatsapp --name wa-bot

# 两个 systemd 服务独立运行
systemctl start droid-chat-tg-bot
systemctl start droid-chat-wa-bot
```

关键点：每个通道使用不同的 Bot Token 和 auth 文件，但共享同一个 droid CLI 和自定义模型配置。

## 七、通用架构模式速查

此架构不仅限于聊天机器人，可以推广到任何"消息输入 → AI 处理 → 消息输出"的场景：

```
输入源 (任何)               处理层 (通用)              输出源 (任何)
─────────────            ─────────────            ─────────────
Telegram 消息   ──┐                                ┌── Telegram 回复
WhatsApp 消息   ──┤     ┌──────────────────┐       ├── WhatsApp 回复
Slack 消息      ──┼────→│  callDroid()      │──────→│── Slack 回复
邮件            ──┤     │  会话管理          │       ├── 邮件回复
Webhook        ──┤     │  上下文路由        │       ├── HTTP Response
定时触发        ──┘     │  命令路由          │       └── 定时通知
                       └──────────────────┘
                              ↕
                       droid exec CLI
                              ↕
                       大模型 API (MiniMax/GLM/Claude/GPT)
```

**核心循环（所有通道通用）：**

```javascript
// 1. 收到消息
const {userId, chatId, text} = parseMessage(rawInput);

// 2. 路由命令或对话
if (isCommand(text)) { handleCommand(text, userId, chatId); return; }

// 3. 获取会话
const session = getUserSession(userId, chatId);

// 4. 调用 droid
const {stdout} = await callDroid(text, session, getCwdForChat(chatId));

// 5. 解析结果
const {text: reply, sessionId} = parseDroidOutput(stdout);

// 6. 更新会话
if (sessionId) { session.sessionId = sessionId; saveSessions(); }

// 7. 发送回复
await sendMessage(chatId, reply);
```

---

# 项目架构概述（AI 速查参考）

> 创建时间: 2026-04-15
> 目的: 供 AI 助手快速理解整个 Telegram Bot 项目的架构、核心机制和关键规则，避免修改时引入回归 bug。

## 一、项目概述

**技术栈：** Node.js + telegraf（Telegram Bot 框架）+ Factory Droid CLI

**核心运行逻辑：**
1. Telegram 用户发消息 → telegraf 通过长轮询接收
2. Node.js 通过 `child_process.spawn()` 调用 `droid exec -m <model> -o json --auto <level> [-s <sessionId>] <prompt>`
3. droid CLI 调用大模型 API，返回 JSON 格式的 stdout（包含 `result`、`session_id` 等字段）
4. Node.js 解析 JSON，提取回复文本和 session ID，通过 telegraf 发回 Telegram

**输入/输出：**
- 输入：Telegram 文本消息
- 输出：Telegram 文本回复（超过 4000 字符自动分段）

**运行环境：** Linux/Ubuntu 服务器，systemd 守护进程管理

## 二、核心机制与关键规则

### 2.1 会话防灾机制（三级渐进式重试）

**绝对禁止修改此逻辑。**

当大模型 API 出现 403 (Forbidden) 或 429 (限流) 时，错误会被写入 droid 的会话历史，导致该 Session 永久报错（Process exited with code 1）。

**三级重试机制：**

```
第一级：正常调用 droid exec -s <sessionId>
  ↓ 失败且 session 损坏（isSessionCorrupted 检测到 403/429/forbidden/upstream error）
第二级：携带 --fork <id> 创建分支会话（保留上下文）
  ↓ Fork 仍失败且 session 损坏
第三级：彻底清空 sessionId=null，开启全新对话
```

**相关代码函数：** `execDroid()` → `callDroid()` → `isSessionCorrupted()`

### 2.2 执行权限

- `droid exec` 是非交互式命令，不存在 UI 弹窗
- **必须始终携带 `--auto` 参数**，通过权限等级（low/medium/high）放行操作
- 不可尝试在 Node.js 中实现交互式拦截
- 默认使用 `high` 级别，用户可通过 `/auto` 命令切换

### 2.3 Typing 状态管理

- 使用 `setInterval` 每 5 秒发送 `ctx.sendChatAction('typing')`
- **`clearInterval` 必须放在 `finally` 块中**，确保无论成功还是异常都能清理
- 参见"坑 8"的详细说明

## 三、功能模块拓扑

### 3.1 基础命令与 droid 参数映射

| Telegram 命令 | droid exec 参数 | 说明 |
|--------------|----------------|------|
| `/spec on/off` | `--use-spec` | 规格模式（先规划再执行） |
| `/mission on/off` | `--mission` + 强制 `--auto high` | 多 Agent 任务模式 |
| `/reason <等级>` | `-r <level>` | 思考深度（off/low/medium/high/max） |
| `/auto <等级>` | `--auto <level>` | 执行权限等级 |
| `/new` | 清空 sessionId | 新会话 |
| `/model <名称>` | `-m <model>` | 切换模型 |

### 3.2 MCP 管理命令（直接调用 droid CLI，不经过 droid exec）

> 新增日期: 2026-04-16
> 原因: 通过 AI 对话安装 MCP 容易因 session 损坏/超时/模型能力不足而失败，改为直接调用 CLI 更可靠

| Telegram 命令 | droid CLI 调用 | 说明 |
|--------------|---------------|------|
| `/mcp list` | 读取 `.mcp.json` 文件 | 查看 MCP 服务器（项目级 + 全局） |
| `/mcp add <名> <地址> [--header]` | `droid mcp add <名> <地址> --type http` | 添加 HTTP MCP |
| `/mcp remove <名>` | `droid mcp remove <名>` | 删除 MCP |

**设计要点：**
- `/mcp` 命令**不走 `droid exec`**，而是直接 `spawn('droid', ['mcp', 'add', ...])` 调用 CLI
- 使用独立的 `runDroidCli()` 辅助函数，超时 15 秒（MCP 操作很快）
- `/mcp list` 直接读取文件系统（`.mcp.json` + `settings.local.json`），不调用 CLI

### 3.3 插件管理命令（直接调用 droid CLI）

> 新增日期: 2026-04-16

| Telegram 命令 | droid CLI 调用 | 说明 |
|--------------|---------------|------|
| `/plugin list` | `droid plugin list` | 查看已安装插件 |
| `/plugin install <插件@市场>` | `droid plugin install <插件@市场>` | 安装插件 |
| `/plugin remove <插件>` | `droid plugin uninstall <插件>` | 卸载插件 |
| `/plugin update [插件]` | `droid plugin update [插件]` | 更新插件 |
| `/plugin marketplace list` | `droid plugin marketplace list` | 查看插件市场 |
| `/plugin marketplace add <URL>` | `droid plugin marketplace add <URL>` | 添加市场 |
| `/plugin marketplace update` | `droid plugin marketplace update` | 更新市场 |

**设计要点：**
- 与 `/mcp` 相同，直接调用 CLI 而非通过 `droid exec`
- `install` 和 `update` 操作超时设为 60 秒（可能需要下载）
- `list` 和 `marketplace` 操作超时设为 15 秒

### 3.4 Telegram 命令菜单注册

Telegram App 输入框的 "/" 菜单需要通过 Bot API 注册，否则用户看不到命令列表：

```bash
# 注册命令到 Telegram 菜单（在服务器上执行一次即可）
BOT_TOKEN="你的Bot Token"
curl -s "https://api.telegram.org/bot${BOT_TOKEN}/setMyCommands" \
  -H "Content-Type: application/json" \
  -d '{
  "commands": [
    {"command": "new", "description": "清空会话，开始新对话"},
    {"command": "session", "description": "查看当前会话信息"},
    {"command": "stop", "description": "停止当前任务"},
    {"command": "model", "description": "切换AI模型"},
    {"command": "tools", "description": "查看可用工具"},
    {"command": "version", "description": "查看Droid CLI版本"},
    {"command": "auto", "description": "切换权限等级 (low/medium/high)"},
    {"command": "timeout", "description": "设置超时时间 (10-600秒)"},
    {"command": "status", "description": "查看完整状态"},
    {"command": "spec", "description": "规格模式 on|off (先规划再执行)"},
    {"command": "mission", "description": "多Agent任务模式 on|off"},
    {"command": "reason", "description": "思考深度 (off/low/medium/high/max)"},
    {"command": "mcp", "description": "MCP管理 (list/add/remove)"},
    {"command": "plugin", "description": "插件管理 (list/install/remove/update)"},
    {"command": "remind", "description": "添加定时提醒"},
    {"command": "list", "description": "查看提醒列表"},
    {"command": "delete", "description": "删除提醒"},
    {"command": "help", "description": "查看所有命令帮助"}
  ]
}'
```

**注意：** 新增命令后需要重新执行此 API 调用。Telegram App 可能会缓存菜单，完全退出 App 再重新打开即可看到更新。

### 3.5 自建定时与执行调度（Reminders & Tasks）

**实现原理：** 独立于 droid 的 `setInterval` 循环（每 60 秒触发），数据持久化在 `reminders.json`。

**核心逻辑：**
- 包含 `exec:` 前缀的提醒文本 → 到期后隐式调用 `execDroid()` 在后台执行任务 → 完成后将结果返回给 Telegram
- 返回结果需做 `slice(0, 4000)` 截断处理，防止超长文本报错
- 周期支持：`daily`（每日）、`weekly`（按周几）、`monthly`（按几号）、`once`（一次性）

### 3.6 消息处理流程

```
用户消息 → bot.on('text')
  → isAllowed() 权限检查
  → processing 锁检查（防止并发）
  → 设置 processing=true
  → 发送 typing 状态
  → callDroid(prompt, session, cwd)
    → execDroid() → spawn('droid', args, {cwd, env})
    → 如果失败且 session 损坏 → 三级重试
  → parseDroidOutput() 解析 JSON
  → 更新 sessionId 并持久化
  → 分段发送回复
  → finally: 清理 typing + 设置 processing=false
```

## 四、上下文路由与角色隔离

### 4.1 会话键值设计

**必须使用组合键 `userId_chatId`**，绝不能仅用 `userId`。

原因：同一用户可能在私聊和群聊中同时使用 bot，如果只用 `userId`，私聊和群聊会共享同一个 session，导致上下文混乱。

```javascript
function getSessionKey(userId, chatId) {
  return `${userId}_${chatId}`;
}
```

### 4.2 动态工作区注入

通过判断 `chatId` 来动态设置 `spawn()` 的 `cwd`（工作目录）选项：

```javascript
function getCwdForChat(chatId) {
  const cfg = GROUP_CONFIGS[String(chatId)];
  return cfg ? cfg.cwd : PRIVATE_CWD;
}

// 在 spawn 调用中使用
const proc = spawn(DROID_PATH, args, { cwd, env: DROID_ENV, ... });
//                                    ^^^ 这里动态切换
```

**注意：** 不是给 droid 传 `--cwd` 参数，而是通过 Node.js spawn 的 `cwd` 选项设置子进程工作目录。droid 会在该目录下读取 `.factory/RULES.md`、`.factory/MEMORY.md` 和 `AGENTS.md` 来加载对应的 Persona（人格）。

### 4.3 当前路由配置

| chatId | 工作目录 | 角色人格 | 说明 |
|--------|---------|---------|------|
| 私聊（非群组） | `/root/Peter工作空间` | 工作助手 | 默认工作上下文 |
| `-3872540185` | `/root/家庭工作空间` | 家庭生活助手 | 温暖基督徒家庭 AI |
| `-1003872540185` | `/root/家庭工作空间` | 家庭生活助手 | 同上（supergroup ID） |

### 4.4 工作目录的 Persona 文件

**工作空间** (`/root/Peter工作空间/`)：
- `AGENTS.md` — 工作助手角色定义
- `.factory/RULES.md` — 执行规则
- `.factory/MEMORY.md` — 长期记忆

**家庭空间** (`/root/家庭工作空间/`)：
- `AGENTS.md` — 家庭生活助手角色定义（温暖的基督徒家庭 AI）
- `MEMORY.md` — 家庭记忆（Peter、Faith、新加坡、基督徒家庭）
- `.factory/` — 目前为空，Persona 主要通过 `AGENTS.md` 和 `MEMORY.md` 定义

## 五、常见错误代码速查表

| 错误特征 | 可能原因 | 处理动作 |
|---------|---------|---------|
| `Process exited with code 1` + 403/Forbidden | API Key 失效或 session 损坏 | 自动触发三级重试（fork → 新会话） |
| `Process exited with code 1` + 429/rate limit | Token 耗尽或触发流控 | 通知用户等待，切换模型或稍后重试 |
| `Context window exceeds limit` (2013) | 上下文超长 | 提示用户 `/new` 清理会话 |
| `Usage limit reached` (429) | Factory 配额用完 | 切换到 custom model（不消耗配额） |
| `ENOENT: spawn droid` | droid CLI 未安装或 PATH 不正确 | 检查 `/root/.local/bin/droid` 是否存在 |
| typing 卡住不消失 | `clearInterval` 未在 finally 中执行 | 确认代码已包含"坑 8"的修复 |
| `Session corrupted` | 上游 API 错误被写入 session 历史 | 自动 fork 或新建 session |
| `Invalid flags: --session-id cannot be used with --use-spec` | Spec 模式与 session-id 冲突 | `/spec off` 然后 `/new`（已修复：坑 9） |
| `insufficient permission` + 之前有其他报错 | session 损坏导致权限误报 | 执行 `/new` 清空会话（参见坑 10） |
| `TimeoutError: Promise timed out` | droid exec 执行超时 | `/timeout` 增加超时时间，或换更快的模型 |
| `Process exited with code 1`（空输出，stdout/stderr 均为空） | session 严重损坏，droid crash 无输出 | 自动触发空输出检测 → fork/清空重建（参见坑 11） |
| 图片无法识别 | 当前模型不支持图片（custom model 不支持） | 切换模型：`/model claude-sonnet` 或 `/model gemini-pro` |
| 提醒设了但不触发 | droid 只文字回复"已设置"没有调用 remind-cli | 检查 AGENTS.md 是否有 remind-cli 说明 |
| 提醒发错 chatId（群提醒到私聊） | Droid 不知道当前 chatId | 确认 text handler 有注入 `[系统: chatId=...]`（坑 14） |
| remind-cli 报 INVALID_TIME_FORMAT | Droid 传了错误时间格式 | remind-cli 加 `--json` 查看 hint，根据提示修正格式（坑 15） |
| 单次提醒被设成每天（daily） | Droid 歧义时默认选了 daily | ctxNote 已注入默认规则，若仍出现可检查 ctxNote 代码（坑 16） |
| ⏳ 上一个请求还在处理中（永久卡住） | Telegraf handlerTimeout(90s) < spawn timeout(120s)，droid 进程卡死不退出，finally 不执行 | 已修复：handlerTimeout=0 + SIGKILL 兜底 + checkProcessingStuck 自动检测（坑 18、19） |

## 六、关键文件速查

| 文件 | 路径 | 用途 |
|------|------|------|
| 主程序 | `/root/telegram-droid-bot/index.js` | Bot 全部逻辑 |
| 会话持久化 | `/root/telegram-droid-bot/sessions.json` | session ID + 模型 + 权限 持久化 |
| 提醒持久化 | `/root/telegram-droid-bot/reminders.json` | 定时提醒/任务数据 |
| 提醒 CLI 工具 | `/root/telegram-droid-bot/remind-cli.js` | Droid 调用设置提醒 |
| systemd 服务 | `/etc/systemd/system/telegram-droid-bot.service` | 守护进程配置（含所有环境变量） |
| Droid 配置 | `/root/.factory/settings.local.json` | 自定义模型定义 + API Key 引用 |
| Droid 认证 | `/root/.factory/auth.v2.file` + `auth.v2.key` | Factory 登录令牌 |
| API Keys | `/root/.bashrc` 中的 export | 手动运行时使用；systemd 需单独配置 |
| 工作空间 | `/root/Peter工作空间/` | 私聊默认 cwd |
| 家庭空间 | `/root/家庭工作空间/` | 家庭群聊 cwd |
| 项目级 MCP 配置 | `/root/Peter工作空间/.mcp.json` | 爻财等 MCP 服务器配置 |
| 部署文档 | `/root/Peter工作空间/重要的配置记录/DEPLOYMENT.md` | 本文档 |

---

# 定时功能已知问题与改进计划

> 创建时间: 2026-04-15
> 修复日期: 2026-04-16
> 状态: ✅ 已修复
> 参考: OpenClaw Cron 设计（https://docs.openclaw.ai/cron）

## 已修复的五个问题

### 问题 1：时间窗口脆弱 → 已修复（P0）

**修复方案：** 将精确分钟匹配改为 3 分钟窗口匹配 + `lastFiredAt` 防重复触发。

- 新增 `parseReminderTargetTime(r, now)` 函数：将 reminder 的目标触发时间解析为 `Date` 对象
- 新增 `alreadyFiredThisCycle(r, now)` 函数：检查本周期是否已触发（daily/weekly/monthly 按天判断，once 触发一次即标记）
- `checkDueReminders()` 改为：`now >= target && now - target < 3分钟 && !alreadyFiredThisCycle`
- reminder 对象新增 `lastFiredAt` 字段，触发后写入时间戳

### 问题 2：过期提醒不自动清理 → 已修复（P0）

**修复方案：** 在 `setInterval` 回调中，遍历 once 类型提醒，如果当前时间已超过目标时间 5 分钟且未触发过，自动删除并通知用户"提醒已过期"。

### 问题 3：无失败重试机制 → 已修复（P1）

**修复方案：** 新增异步重试队列 `retryQueue` + `processRetryQueue()`。

- 新增 `isRetryableError(msg)` 函数：识别临时错误（rate_limit / overloaded / network / timeout / 429 / econnreset / socket hang up）
- 临时错误：自动重试 3 次，间隔 30s → 60s → 120s（指数退避）
- 永久错误（403 / forbidden 等）：不重试，直接通知失败
- 重试队列异步执行（`setTimeout`），不阻塞主 `setInterval` 循环
- 内存占用：每条重试 < 1KB，最多 3 条 = ~3KB

### 问题 4：时区混用 → 已修复（P2）

**修复方案：** 统一所有时间处理为本地时间。

- 新增辅助函数 `localDateTimeStr(d)` / `localDateStr(d)` / `localTimeStr(d)`
- `once` 类型的日期时间：之前用 `toISOString().slice(0,10)`（UTC），现改为 `localDateStr()`（本地）
- `30m` 相对时间：之前用 `toISOString().slice(0,16).replace('T',' ')`（UTC），现改为 `localDateTimeStr()`（本地）
- 移除了所有 `toISOString` 调用

### 问题 5：并发触发 → 已修复（P3）

**修复方案：** 新增全局锁 `reminderProcessing`。

- `setInterval` 回调开始时检查 `reminderProcessing`，如果为 true 则跳过本轮
- 回调在 `finally` 中重置锁，确保不会死锁

## 修复后的架构

```
setInterval (60s)
  │
  ├─ 检查 reminderProcessing 锁 → 如果忙碌则跳过
  │
  ├─ 阶段1：过期清理
  │   └─ 遍历 once 类型 → 超过目标时间 5 分钟 → 删除 + 通知过期
  │
  ├─ 阶段2：触发到期提醒
  │   ├─ checkDueReminders() → 窗口匹配(3分钟) + lastFiredAt 防重复
  │   ├─ 普通提醒 → sendMessage → 标记 lastFiredAt
  │   └─ exec 任务 → callDroid()
  │       ├─ 成功 → 发送结果 → 标记 lastFiredAt
  │       ├─ 临时错误 → 发送"将自动重试" → scheduleRetry()
  │       │   └─ retryQueue → processRetryQueue() [异步,不阻塞]
  │       │       ├─ 重试成功 → 发送结果
  │       │       ├─ 临时错误 → 继续重试(最多3次)
  │       │       └─ 永久错误 → 通知失败
  │       └─ 永久错误 → 发送失败通知
  │
  └─ finally: reminderProcessing = false
```

## 与 OpenClaw Cron 的更新对比

| 特性 | OpenClaw Cron | 修复前 | 修复后 |
|------|--------------|--------|--------|
| 时间匹配 | 精确调度 | 精确分钟 ❌ | 3分钟窗口 ✅ |
| 防重复触发 | 内置 | 无 ❌ | lastFiredAt ✅ |
| 过期清理 | one-shot 自动删除 | 不清理 ❌ | 5分钟过期清理 ✅ |
| 失败重试 | 3次指数退避 | 无重试 ❌ | 3次指数退避 ✅ |
| 临时/永久错误区分 | 有 | 无 ❌ | isRetryableError ✅ |
| 时区 | `--tz` 参数 | UTC/本地混用 ❌ | 统一本地时间 ✅ |
| 并发保护 | 内置 | 无 ❌ | 全局锁 ✅ |
| 调度类型 | cron/interval/at | once/daily/weekly/monthly | 同左（够用） |
| 重试不阻塞 | 内置 | N/A | 异步队列 ✅ |

## 测试验证记录（2026-04-16）

通过直接写入 `reminders.json` 并观察 `journalctl` 日志和 Telegram 消息投递，验证了三个核心场景：

### 测试 1：普通提醒（窗口匹配）

- 设定时间：`08:19`，服务启动时间：`08:18:43`（首次检查在 `08:19:43`）
- 结果：✅ 提醒成功触发，`reminders.json` 被清空（once 类型触发后自动删除）
- 窗口匹配验证：目标时间 08:19:00，检查时间 08:19:43，差值 43 秒 < 3 分钟窗口 → 匹配成功

### 测试 2：exec 定时任务

- 设定时间：`08:21`，任务内容：`用一句话告诉我当前服务器时间和内存使用情况`
- 结果：✅ 日志显示 `[REMINDER] 1 reminder(s) due`，droid exec 成功执行，结果通过 Telegram 发送
- 日志特征：
  ```
  [REMINDER] 1 reminder(s) due
  [DROID] droid exec -m custom:minimax-m2.7 -o json --auto high 用一句话告诉我当前服务器时间和内存使用情况 (cwd: /root/Peter工作空间)
  ```

### 测试 3：过期 once 自动清理

- 设定时间：10 分钟前的 `08:15`（当前 `08:25`）
- 结果：✅ `reminders.json` 在下一个 60 秒检查周期后被清空，过期提醒被自动删除并通知用户
- Telegram 收到：`⏰ 提醒已过期: 这条提醒已过期，应被自动清理 (设定时间: 2026-04-16 08:15)`

### 测试结论

| 场景 | 结果 | 关键验证点 |
|------|------|-----------|
| 窗口匹配 | ✅ | 43 秒偏差在 3 分钟窗口内正常触发 |
| lastFiredAt 防重复 | ✅ | 60 秒轮询周期中仅触发一次 |
| once 触发后删除 | ✅ | reminders.json 被清空 |
| exec 任务执行 | ✅ | droid exec 正常调用，结果发送到 Telegram |
| 过期自动清理 | ✅ | 超过 5 分钟的过期提醒被自动删除+通知 |
| 并发锁 | ✅ | 日志无异常，`reminderProcessing` 锁正常工作 |

## 未实现的功能（低优先级）

- cron 表达式支持（当前 daily/weekly/monthly 已覆盖常见场景）
- `--at` 相对时间（如 `20m`）→ 已通过 `/remind 30m 内容` 实现
- `--every` 间隔执行（如每 2 小时）→ 如需要可后续添加
