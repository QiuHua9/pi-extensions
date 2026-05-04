# action-guard

为 pi 代理提供人工确认和歧义消解工具，在敏感操作前插入人工关卡。

## 工具

### confirm_action — 敏感操作确认

在执行删除文件、修改配置、数据库写入等敏感操作前，展示具体修改内容并请求用户确认。

**参数：**

| 参数 | 类型 | 必填 | 说明 |
|---|---|---|---|
| `action` | string | ✅ | 简述即将执行的操作 |
| `details` | string | ✅ | 具体修改内容（涉及文件、改了什么、影响范围） |
| `reason` | string | ❌ | 为什么要做这个修改 |

**返回：** `{ confirmed: boolean }`

### clarify_intent — 歧义消解

当用户输入存在多种合理解读时，列出最可能的选项供用户选择。

**参数：**

| 参数 | 类型 | 必填 | 说明 |
|---|---|---|---|
| `ambiguous_input` | string | ✅ | 用户原始的有歧义的输入 |
| `reason` | string | ✅ | 为什么存在歧义 |
| `options` | array | ✅ | 2~6 个候选选项，每个含 `value`、`label`、`description` |

**返回：** `{ selected: string, label: string }`

## 安装

```bash
pi install git:github.com/QiuHua9/action-guard
```

## 用法

在 pi 的 AGENTS.md 或系统提示中添加指引，让模型在合适时机调用这两个工具即可。例如：

```
执行删除文件、修改关键配置、数据库写入等敏感操作前，必须先调用 confirm_action 获取用户确认。
当用户输入存在多种合理解读时，调用 clarify_intent 让用户确认真实意图。
```
