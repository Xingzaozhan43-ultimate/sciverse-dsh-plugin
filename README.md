# dsh-Sciverse

本插件是为 [SciVerse 科学数据平台](https://sciverse.space) 创建的 DSH 插件。SciVerse 是面向科研 Agent 和 RAG 场景的科学数据 API 平台，提供可信文献检索、evidence chunk、全文读取、附件下载与结构化论文图谱能力。这个插件把 SciVerse 的 7 个公开接口封装成 DSH Agent 可直接调用的工具，方便你基于自己的 SciVerse API Key 做科研检索、综述和实验。

DSH 插件：接入 SciVerse 的 7 个公开 API，供 Agent 做科研检索、原文读取、附件下载与结构化论文图谱实验。

## 如何申请 API Key

1. 打开 SciVerse 控制台：<https://sciverse.space/tokens>
2. 登录账号后，在「密钥 / Tokens」页面点击创建。
3. Token 创建后只会完整显示一次，请立即保存到安全的地方。
4. 在 DSH 中使用时，把 Token 配置为环境变量 `SCIVERSE_API_TOKEN`，或写入本地凭据文件。

> 同一套 API Key 可用于 Sciverse、点石 DianShi、SeqStudio 与 Skills 能力。

## 覆盖接口

| 工具名 | 对应 API | 说明 |
| --- | --- | --- |
| `sciverse_agentic_search` | `POST /agentic-search` | 自然语言智能检索，返回 evidence chunk |
| `sciverse_content` | `GET /content` | 按 `doc_id` 分段读取全文 |
| `sciverse_resource` | `GET /resource` | 下载图片 / PDF 等二进制附件 |
| `sciverse_meta_catalog` | `GET /meta-catalog` | 元数据字段、筛选/排序能力目录 |
| `sciverse_meta_paper_relations` | `POST /meta-paper-relations` | 引用 / 被引 / 相关工作分页 |
| `sciverse_meta_search` | `POST /meta-search` | 结构化元数据检索 |
| `sciverse_paper_schema` | `/paper-schema/*` | Paper Schema 18 个子操作通用入口 |

## 使用方式

插件注入到 DSH 后，直接在对话里让 Agent 调用即可，不需要手写 HTTP 请求。

```text
用 sciverse_agentic_search 查一下 "graphene battery cycle stability"
```

拿到 `doc_id` 后继续读原文：

```text
对第一个结果的 doc_id 调用 sciverse_content，读前 1000 个字符
```

组合检索与引用关系：

```text
先用 sciverse_meta_search 按 2022 年以后的论文筛选 graphene battery，
再对第一篇论文用 sciverse_meta_paper_relations 查它的参考文献
```

也可以显式指定参数：

```text
调用 sciverse_agentic_search：
query = "large language model agent"
top_k = 5
filters = {"lang": "en", "publication_published_year": {"gte": 2022}}
```

## 配置

API Token 通过以下任一方式提供（优先级：Config > 环境变量 > 本地凭据文件）：

```bash
export SCIVERSE_API_TOKEN='sv-...'
```

也可以把 Token 写到本地凭据文件（不提交到 Git）：

```bash
# ~/.sciverse/credentials.json 或 ~/.dsh/sciverse.json
echo '{"token":"sv-..."}' > ~/.dsh/sciverse.json
```

插件 Config 字段：

```ts
{
  apiBase: 'https://api.sciverse.space',
  token: '',          // 可选；不填则读 SCIVERSE_API_TOKEN
  timeoutMs: 60000,
  resourceDir: '',    // resource 下载默认目录；不填用系统临时目录
}
```

## 安全

- **不要把 Token 写进代码、日志或提交到 Git。**
- `sciverse_resource` 会校验 `file_name`，拒绝 `..`、反斜杠和绝对路径。
- `sciverse_paper_schema` 会校验 `path` 必须以 `paper-schema` 开头，避免路径逃逸。
- 所有工具返回 JSON 文本，方便 Agent 继续解析。

## 构建与注入

```bash
DSH_CHECKOUT=<checkout> bash scripts/build.sh
# 注入器环境内：dev_inject_plugin <本目录>
```

## 快速实验

```bash
export SCIVERSE_API_TOKEN='sv-...'
# 示例：智能检索
curl -X POST https://api.sciverse.space/agentic-search \
  -H "Authorization: Bearer $SCIVERSE_API_TOKEN" \
  -H "Content-Type: application/json" \
  -d '{"query":"graphene battery cycle stability","top_k":5}'
```
