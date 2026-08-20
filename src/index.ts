/**
 * @dsh-external/sciverse — SciVerse 7 API 接入 DSH 插件。
 *
 * 覆盖接口：
 *   agentic-search / content / resource / meta-catalog / meta-paper-relations / meta-search / paper-schema
 *
 * 安全说明：
 *   - API Token 从环境变量 SCIVERSE_API_TOKEN 或插件 Config.token 读取；
 *   - 不要将 Token 写入代码、日志或提交到仓库；
 *   - resource 接口只接受相对 file_name，并校验路径安全。
 */
import type { Context } from 'cordis'
import { defineTool } from '@deepseek-ai/dsh-tools'
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs'
import { homedir, tmpdir } from 'node:os'
import { dirname, join, isAbsolute } from 'node:path'
import z from 'schemastery'

export const name = "@dsh-external/sciverse"
export const inject = ['tools']

export interface Config {
  apiBase?: string
  token?: string
  timeoutMs?: number
  resourceDir?: string
}

export const Config = z.object({
  apiBase: z.string().default('https://api.sciverse.space'),
  token: z.string().default(''),
  timeoutMs: z.number().default(60000),
  resourceDir: z.string().default(''),
})

interface RequestOptions {
  apiBase?: string
  method?: 'GET' | 'POST'
  path: string
  query?: Record<string, unknown>
  body?: unknown
  token: string
  timeoutMs: number
  responseType?: 'json' | 'arrayBuffer'
}

function buildUrl(apiBase: string, path: string, query?: Record<string, unknown>): URL {
  const base = apiBase.replace(/\/+$/, '')
  const normalized = path.startsWith('/') ? path : `/${path}`
  const url = new URL(`${base}${normalized}`)
  if (query) {
    const usp = new URLSearchParams()
    for (const [key, value] of Object.entries(query)) {
      if (value === undefined || value === null || value === '') continue
      if (Array.isArray(value)) {
        for (const item of value) usp.append(key, String(item))
      } else {
        usp.set(key, String(value))
      }
    }
    url.search = usp.toString()
  }
  return url
}

async function sciverseRequest(options: RequestOptions): Promise<unknown> {
  const { method = 'POST', path, query, body, token, timeoutMs, responseType = 'json' } = options
  if (!token) {
    throw new Error('SciVerse API Token 未配置：请设置环境变量 SCIVERSE_API_TOKEN 或在插件 Config 中传入 token')
  }
  const url = buildUrl(options.apiBase ?? 'https://api.sciverse.space', path, query)
  const controller = new AbortController()
  const timer = setTimeout(() => controller.abort(), timeoutMs)
  try {
    const headers: Record<string, string> = {
      Authorization: `Bearer ${token}`,
      Accept: 'application/json',
    }
    if (body !== undefined) headers['Content-Type'] = 'application/json'
    const res = await fetch(url, {
      method,
      headers,
      body: body !== undefined ? JSON.stringify(body) : undefined,
      signal: controller.signal,
    })
    if (!res.ok) {
      let detail = ''
      try {
        detail = await res.text()
      } catch {
        // ignore body read failure
      }
      throw new Error(`SciVerse ${method} ${path} -> HTTP ${res.status}: ${detail.slice(0, 500)}`)
    }
    if (responseType === 'arrayBuffer') {
      return Buffer.from(await res.arrayBuffer())
    }
    return await res.json()
  } finally {
    clearTimeout(timer)
  }
}

function jsonString(value: unknown): string {
  return typeof value === 'string' ? value : JSON.stringify(value, null, 2)
}

function safeResourceName(fileName: string): string {
  if (!fileName || fileName.includes('\\') || fileName.includes('..') || fileName.startsWith('/')) {
    throw new Error('file_name 不合法：必须是 Sciverse 返回的相对路径，不能包含 \\、.. 或以 / 开头')
  }
  const name = fileName.split('/').filter(Boolean).pop() || 'resource.bin'
  return name
}

function loadToken(configToken: string): string {
  if (configToken) return configToken
  if (process.env.SCIVERSE_API_TOKEN) return process.env.SCIVERSE_API_TOKEN
  const candidates = [
    join(homedir(), '.sciverse', 'credentials.json'),
    join(homedir(), '.dsh', 'sciverse.json'),
  ]
  for (const file of candidates) {
    try {
      if (!existsSync(file)) continue
      const data = JSON.parse(readFileSync(file, 'utf8')) as { token?: string; api_key?: string }
      if (data.token) return data.token
      if (data.api_key) return data.api_key
    } catch {
      // ignore malformed credentials file
    }
  }
  return ''
}

export function apply(ctx: Context, config: Config): void {
  const apiBase = config.apiBase || 'https://api.sciverse.space'
  const timeoutMs = config.timeoutMs || 60000
  const token = loadToken(config.token || '')

  // ── 1. agentic-search：智能检索 + evidence chunk ─────────────────────────
  ctx.effect(() => ctx.tools.register(defineTool({
    name: 'sciverse_agentic_search',
    description: 'SciVerse 智能检索：自然语言提问，返回最相关的可引用文献段落（evidence chunk）与来源信息。',
    parameters: {
      query: { type: 'string', required: true, description: '检索问题，最长 4096 字符' },
      top_k: { type: 'integer', description: '返回片段数量，默认 10，范围 1-100' },
      sub_queries: { type: 'integer', description: '查询改写数量，0 表示不改写，范围 0-4' },
      filters: { type: 'json', description: '语义检索过滤对象，如 {"lang":"en","publication_published_year":{"gte":2020}}' },
    },
    output: {
      schema: { type: 'string' },
      render: (_args, value) => [{ type: 'text', text: String(value) }],
    },
    async execute(args: { query: string; top_k?: number; sub_queries?: number; filters?: unknown }) {
      const body: Record<string, unknown> = { query: args.query }
      if (args.top_k !== undefined) body.top_k = args.top_k
      if (args.sub_queries !== undefined) body.sub_queries = args.sub_queries
      if (args.filters !== undefined) body.filters = args.filters
      const result = await sciverseRequest({ apiBase, method: 'POST', path: '/agentic-search', body, token, timeoutMs })
      return jsonString(result)
    },
  })), '@dsh-external/sciverse: sciverse_agentic_search')

  // ── 2. content：按 doc_id 读原文 ─────────────────────────────────────────
  ctx.effect(() => ctx.tools.register(defineTool({
    name: 'sciverse_content',
    description: 'SciVerse 原文读取：按 doc_id 分段读取文献全文文本，支持 offset/limit 续读。',
    parameters: {
      doc_id: { type: 'string', required: true, description: '文献 ID，来自 agentic-search 或 meta-search' },
      offset: { type: 'integer', description: '字符偏移（Unicode 码点），默认 0' },
      limit: { type: 'integer', description: '单次最大字符数，默认 700，仅在传入 offset 时生效' },
    },
    output: {
      schema: { type: 'string' },
      render: (_args, value) => [{ type: 'text', text: String(value) }],
    },
    async execute(args: { doc_id: string; offset?: number; limit?: number }) {
      const result = await sciverseRequest({
        apiBase,
        method: 'GET',
        path: '/content',
        query: { doc_id: args.doc_id, offset: args.offset, limit: args.limit },
        token,
        timeoutMs,
      })
      return jsonString(result)
    },
  })), '@dsh-external/sciverse: sciverse_content')

  // ── 3. resource：下载附件（图片 / PDF 等二进制）──────────────────────────
  ctx.effect(() => ctx.tools.register(defineTool({
    name: 'sciverse_resource',
    description: 'SciVerse 附件下载：按相对路径 file_name 下载论文图片等二进制资源，保存到本地并返回路径。',
    parameters: {
      file_name: { type: 'string', required: true, description: '资源相对路径，来自检索结果或正文中的图片路径' },
      output_path: { type: 'string', description: '保存到的绝对路径；不传则保存到系统临时目录' },
    },
    output: {
      schema: { type: 'string' },
      render: (_args, value) => [{ type: 'text', text: String(value) }],
    },
    async execute(args: { file_name: string; output_path?: string }) {
      const name = safeResourceName(args.file_name)
      const buffer = (await sciverseRequest({
        apiBase,
        method: 'GET',
        path: '/resource',
        query: { file_name: args.file_name },
        token,
        timeoutMs,
        responseType: 'arrayBuffer',
      })) as Buffer

      let target: string
      if (args.output_path) {
        if (!isAbsolute(args.output_path)) throw new Error('output_path 必须是绝对路径')
        target = args.output_path
      } else {
        const dir = config.resourceDir || tmpdir()
        mkdirSync(dir, { recursive: true })
        target = join(dir, name)
      }
      mkdirSync(dirname(target), { recursive: true })
      writeFileSync(target, buffer)
      return jsonString({ ok: true, path: target, bytes: buffer.length, file_name: args.file_name })
    },
  })), '@dsh-external/sciverse: sciverse_resource')

  // ── 4. meta-catalog：元数据字段目录 ──────────────────────────────────────
  ctx.effect(() => ctx.tools.register(defineTool({
    name: 'sciverse_meta_catalog',
    description: 'SciVerse 元数据目录：查看 meta-search 支持的字段、筛选/排序能力与默认返回列。',
    parameters: {
      collection: { type: 'string', enum: ['papers', 'authors', 'sources'], description: '字段目录所属集合，默认 papers' },
      include_sample_values: { type: 'boolean', description: '是否返回枚举字段样本值，默认 false' },
    },
    output: {
      schema: { type: 'string' },
      render: (_args, value) => [{ type: 'text', text: String(value) }],
    },
    async execute(args: { collection?: string; include_sample_values?: boolean }) {
      const result = await sciverseRequest({
        apiBase,
        method: 'GET',
        path: '/meta-catalog',
        query: { collection: args.collection, include_sample_values: args.include_sample_values },
        token,
        timeoutMs,
      })
      return jsonString(result)
    },
  })), '@dsh-external/sciverse: sciverse_meta_catalog')

  // ── 5. meta-paper-relations：论文引用/被引/相关工作分页 ─────────────────
  ctx.effect(() => ctx.tools.register(defineTool({
    name: 'sciverse_meta_paper_relations',
    description: 'SciVerse 论文关系：按 unique_id 分页查询 CITATIONS / REFERENCES / RELATED_WORKS。',
    parameters: {
      unique_id: { type: 'string', required: true, description: '目标论文 unique_id，如 paper:10.1038/xxx；勿传 doc_id' },
      relation: { type: 'string', required: true, enum: ['CITATIONS', 'REFERENCES', 'RELATED_WORKS'], description: '关系类型' },
      page: { type: 'integer', description: '页码，默认 1' },
      page_size: { type: 'integer', description: '每页条数，默认 25，范围 1-200' },
    },
    output: {
      schema: { type: 'string' },
      render: (_args, value) => [{ type: 'text', text: String(value) }],
    },
    async execute(args: { unique_id: string; relation: string; page?: number; page_size?: number }) {
      const body: Record<string, unknown> = { unique_id: args.unique_id, relation: args.relation }
      if (args.page !== undefined) body.page = args.page
      if (args.page_size !== undefined) body.page_size = args.page_size
      const result = await sciverseRequest({ apiBase, method: 'POST', path: '/meta-paper-relations', body, token, timeoutMs })
      return jsonString(result)
    },
  })), '@dsh-external/sciverse: sciverse_meta_paper_relations')

  // ── 6. meta-search：结构化元数据检索 ─────────────────────────────────────
  ctx.effect(() => ctx.tools.register(defineTool({
    name: 'sciverse_meta_search',
    description: 'SciVerse 元数据检索：按字段过滤、排序、分页检索论文书目信息，不返回证据片段。',
    parameters: {
      collection: { type: 'string', enum: ['papers', 'authors', 'sources'], description: '实体集合，默认 papers' },
      query: { type: 'string', description: '全文模糊检索词' },
      filters: { type: 'json', description: '字段过滤条件数组，如 [{"field":"publication_published_year","operator":"FILTER_OP_GTE","value":2022}]' },
      sort: { type: 'json', description: '排序字段数组，如 [{"field":"citation_count","order":"SORT_ORDER_DESC"}]' },
      fields: { type: 'array', items: { type: 'string' }, description: '字段投影列表' },
      page: { type: 'integer', description: '页码，默认 1' },
      page_size: { type: 'integer', description: '每页条数，默认 25，范围 1-200' },
      cursor: { type: 'string', description: '深翻页游标，与 page>1 互斥' },
      freshness_boost: { type: 'string', enum: ['NONE', 'MILD', 'STRONG'], description: '新鲜度加权' },
      impact_boost: { type: 'string', enum: ['NONE', 'MILD', 'STRONG'], description: '影响力加权' },
      language_affinity: { type: 'string', enum: ['NONE', 'MILD', 'STRONG'], description: '语言亲和加权' },
    },
    output: {
      schema: { type: 'string' },
      render: (_args, value) => [{ type: 'text', text: String(value) }],
    },
    async execute(args: {
      collection?: string; query?: string; filters?: unknown; sort?: unknown; fields?: string[];
      page?: number; page_size?: number; cursor?: string; freshness_boost?: string; impact_boost?: string; language_affinity?: string;
    }) {
      const body: Record<string, unknown> = {}
      if (args.collection !== undefined) body.collection = args.collection
      if (args.query !== undefined) body.query = args.query
      if (args.filters !== undefined) body.filters = args.filters
      if (args.sort !== undefined) body.sort = args.sort
      if (args.fields !== undefined) body.fields = args.fields
      if (args.page !== undefined) body.page = args.page
      if (args.page_size !== undefined) body.page_size = args.page_size
      if (args.cursor !== undefined) body.cursor = args.cursor
      if (args.freshness_boost !== undefined) body.freshness_boost = args.freshness_boost
      if (args.impact_boost !== undefined) body.impact_boost = args.impact_boost
      if (args.language_affinity !== undefined) body.language_affinity = args.language_affinity
      const result = await sciverseRequest({ apiBase, method: 'POST', path: '/meta-search', body, token, timeoutMs })
      return jsonString(result)
    },
  })), '@dsh-external/sciverse: sciverse_meta_search')

  // ── 7. paper-schema：结构化论文/实体/证据/引用图谱（18 个子操作通用入口）──
  ctx.effect(() => ctx.tools.register(defineTool({
    name: 'sciverse_paper_schema',
    description: 'SciVerse Paper Schema 通用入口：调用 /paper-schema 下的任意子操作（search、entities、relations、citations、evidence、materials 等）。',
    parameters: {
      path: { type: 'string', required: true, description: '子操作路径，如 paper-schema/search 或 paper-schema/schemas/{schema_id}/entities' },
      method: { type: 'string', enum: ['GET', 'POST'], description: 'HTTP 方法，默认 POST（GET 用于路径参数类接口）' },
      body: { type: 'json', description: 'POST 请求体（JSON 对象）' },
      query: { type: 'json', description: 'URL query 参数（JSON 对象）' },
    },
    output: {
      schema: { type: 'string' },
      render: (_args, value) => [{ type: 'text', text: String(value) }],
    },
    async execute(args: { path: string; method?: 'GET' | 'POST'; body?: unknown; query?: unknown }) {
      const rawPath = args.path.startsWith('/') ? args.path : `/${args.path}`
      if (rawPath !== '/paper-schema' && !rawPath.startsWith('/paper-schema/')) {
        throw new Error('path 必须以 paper-schema 开头')
      }
      if (rawPath.includes('..')) throw new Error('path 不允许包含 ..')
      const method = args.method || 'POST'
      const result = await sciverseRequest({
        apiBase,
        method,
        path: rawPath,
        body: method === 'POST' ? args.body : undefined,
        query: args.query as Record<string, unknown> | undefined,
        token,
        timeoutMs,
      })
      return jsonString(result)
    },
  })), '@dsh-external/sciverse: sciverse_paper_schema')

  // ── 首轮锚定（可选）：工具面 ≥5 个时，先只暴露最核心的 agentic-search ──
  // 启用步骤：
  //   1. 上方 inject 数组加 'systemPrompt'；
  //   2. 取消下面代码注释；
  //   3. 把 MINE 集合替换为本插件全部工具名。
  // ctx.on('system-prompt/assemble', async (_assembly: unknown, context: any, next: () => Promise<any>) => {
  //   const assembled = await next()
  //   const agent = context.agent
  //   if (!agent || agent.session.events.some((e: any) => e.type === 'tool/call')) return assembled
  //   const MINE = new Set([
  //     'sciverse_agentic_search', 'sciverse_content', 'sciverse_resource',
  //     'sciverse_meta_catalog', 'sciverse_meta_paper_relations', 'sciverse_meta_search',
  //     'sciverse_paper_schema',
  //   ])
  //   const CORE = 'sciverse_agentic_search'
  //   return { ...assembled, tools: assembled.tools.filter((t: any) => !MINE.has(t.name) || t.name === CORE) }
  // })
}
