# 词研所 · TOEFL Vocab Studio

面向 2026 TOEFL 的词汇整理、云端存档和间隔复习网站。界面为中文，针对电脑使用设计。

## 本地启动

需要 Node.js 18 或更高版本。

```bash
npm install
npm start
```

访问 `http://127.0.0.1:4173`。本地运行默认使用 `data/` 中的 JSON 文件，不需要 Supabase。

## 部署到 Vercel

### 1. 创建 Supabase 数据库

1. 在 Supabase 创建一个项目。
2. 打开 SQL Editor。
3. 执行 [`supabase/schema.sql`](./supabase/schema.sql) 的全部内容。
4. 在 Project Settings → API 中取得 Project URL 和 `service_role` key。

`service_role` key 只能放在 Vercel 环境变量中，绝不能放入 `app.js`、HTML 或公开仓库。

### 2. 配置 Vercel 环境变量

在 Vercel 项目的 Settings → Environment Variables 中添加：

| 名称 | 必填 | 内容 |
| --- | --- | --- |
| `SUPABASE_URL` | 是 | Supabase Project URL |
| `SUPABASE_SERVICE_ROLE_KEY` | 是 | Supabase `service_role` key |
| `APP_SECRET` | 是 | 至少 32 字符的随机密钥 |
| `DEEPSEEK_API_KEY` | 否 | 站点所有者提供的共享 DeepSeek Key |

可用以下命令生成 `APP_SECRET`：

```bash
openssl rand -hex 32
```

设置 `DEEPSEEK_API_KEY` 后，登录用户无需填写自己的 Key。共享调用限制为每个账号每天 50 次，防止公开网址被无限消耗余额。

部署完成后访问 `/api/health`：

- `status: "ok"`：云端存储配置正常；
- `status: "misconfigured"`：Vercel 环境变量缺失，登录与同步不可用；
- 即使 Supabase 尚未配置，OCR、本地词库、词形还原和用户自带 Key 的 DeepSeek 调用仍可使用。

### 3. 部署

将项目推送到 GitHub，然后在 Vercel 中导入仓库。Vercel 会读取 `vercel.json`，执行 `npm run build`，并生成：

- 静态前端与 4,108 个本地发音文件；
- Vercel Node Function；
- Supabase 账号、会话和学习状态存储；
- 服务端 OCR、DeepSeek 代理和 DOCX 导出。

不要上传以下本地文件：

- `data/.secret`
- `data/users.json`
- `data/sessions.json`
- `data/states/`
- `.env`

这些路径已加入 `.gitignore` 和 `.vercelignore`。

## 使用顺序

1. 注册或登录；若站点未提供共享 Key，在设置中填写自己的 DeepSeek API Key。
2. 粘贴文本，或选择 TXT、Markdown、PDF、DOCX、图片。
3. 候选词会转换为原型，并过滤常见基础词。
4. 给需要的词选择“拼写”或“识记”；未选择的自动忽略。
5. 生成词条并自动存档，然后进入练习。

## 词条内容

- 单词原型与词性
- 英文释义和中文释义
- 仅特殊或不规则变形
- 词族与词性转换
- TOEFL 写作固定搭配、英文例句及中文翻译
- 面向 TOEFL 阅读词汇题的近义词辨析
- 仅使用本地词库或可信词典提供的真人发音

不生成音标，不保存原材料或原句。

## 数据与隐私

- 未登录时，词库和间隔重复数据保存在当前浏览器。
- 登录后，学习状态同步到 Supabase，DeepSeek Key 加密后保存。
- 原始阅读、听力或写作材料不会存档。
- 图片仅发送到本站 OCR Function，不会发送给 DeepSeek，也不会持久保存。
- PDF 和 DOCX 在浏览器内解析。
- 可在设置中导出 JSON 备份或 DOCX 词表。

## 本地检查

```bash
npm run check
npm run build
npm audit --omit=dev
```
