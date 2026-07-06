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
- 浏览器本地 OCR（失败时才回退到服务器）、DeepSeek 代理和 DOCX 导出。

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
4. 可选择“词表模式”，或保留原文并点击带基础释义的词进行分类。
5. 给需要的词选择“拼写”或“识记”；未选择的自动忽略。
6. 生成词条并自动存档，然后进入练习。

## 练习模式

- 快速识记：回忆释义并按掌握程度自评。
- 文章近义词题：把识记词放进原创学术短文，选择文中近义表达；短文中的虚线词可直接归类。
- 看义拼写：根据中英文释义输入完整单词。
- 听音拼写：进入每个新词时自动播放可靠词典录音，也可手动重听。
- 词库段落补词：一篇文章同时考查最多 5 个拼写词。
- 真考补词模拟：原创学术段落，不受个人词库限制。
- 真考造句模拟：按 2026 TOEFL `Build a Sentence` 形式重排词块。
- 个人题库：上传 PDF、DOCX、图片或文本，将整份 `Complete the Words` / `Build a Sentence` 资料转换为电脑作答格式并存档。
- 每种模式最多 20 词一组，可按添加时间或熟练度（弱到强）分组。

上述练习、分组和判定都在浏览器内运行，不需要 DeepSeek API。文章采用原创模板，不复制 ETS 真题。

## 词条内容

- 单词原型与词性
- 英文释义和中文释义
- 仅特殊或不规则变形
- 词族与词性转换
- TOEFL 写作固定搭配、英文例句及中文翻译
- 面向 TOEFL 阅读词汇题的近义词辨析
- 仅使用本地词库或可信词典提供的真人发音
- 候选词基础释义来自 4,127 词本地词库，以及从用户提供的“托福阅读必备词汇”和“新托福高频词汇”整理出的 762 条短释义

不生成音标，不保存原材料或原句。

## 数据与隐私

- 未登录时，词库和间隔重复数据保存在当前浏览器。
- 登录后，学习状态同步到 Supabase，DeepSeek Key 加密后保存。
- 原始阅读、听力或写作材料不会存档。
- 个人题库只保存转换后的题目、答案、题库名称和来源文件名；上传的原始文件本身不会保存。
- 图片优先在访问者浏览器内识别；只有浏览器 OCR 失败时才发送到本站 OCR Function。图片不会发送给 DeepSeek，也不会持久保存。
- PDF 和 DOCX 在浏览器内解析。
- 可在设置中导出 JSON 备份或 DOCX 词表。

## 分享给其他人

- 无需 API：图片 OCR、文本/PDF/DOCX 导入、候选词提取、4,127 词本地词库、762 条基础释义、已有本地发音、七种训练模式、本机存档和 JSON 备份。
- 需要 DeepSeek：生成完整双语词条，以及自动把排版复杂的整份练习资料转换为结构化题目时调用。个人题库也提供无需 API 的本地识别和手动校正模式。
- 若 Vercel 配置了 `DEEPSEEK_API_KEY`，登录用户不需要自己的 Key；否则每位用户可以在设置中填写自己的 Key。
- 登录和跨设备云同步依赖 Supabase；不登录仍可使用本机存档和训练功能。

## 本地检查

```bash
npm run check
npm run build
npm audit --omit=dev
```
