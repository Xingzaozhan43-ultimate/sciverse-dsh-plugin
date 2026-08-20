# @dsh-external/sciverse

DSH 插件：接入 SciVerse 的 7 个公开 API，供 Agent 做科研检索、原文读取、附件下载与结构化论文图谱实验。

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
