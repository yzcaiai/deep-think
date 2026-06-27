import {
  TAVILY_BASE_URL,
  FIRECRAWL_BASE_URL,
  EXA_BASE_URL,
  BOCHA_BASE_URL,
  SEARXNG_BASE_URL,
  GROK_BASE_URL,
} from "@/constants/urls";
import { rewritingPrompt } from "@/constants/prompts";
import { completePath } from "@/utils/url";
import { pick, sort } from "radash";

type TavilySearchResult = {
  title: string;
  url: string;
  content: string;
  rawContent?: string;
  score: number;
  publishedDate: string;
};

interface FirecrawlDocument<T = unknown> {
  url?: string;
  markdown?: string;
  html?: string;
  rawHtml?: string;
  links?: string[];
  extract?: T;
  json?: T;
  screenshot?: string;
  compare?: {
    previousScrapeAt: string | null;
    changeStatus: "new" | "same" | "changed" | "removed";
    visibility: "visible" | "hidden";
  };
  // v1 search only
  title?: string;
  description?: string;
}

type ExaSearchResult = {
  title: string;
  url: string;
  publishedDate: string;
  author: string;
  score: number;
  id: string;
  image?: string;
  favicon: string;
  text?: string;
  highlights?: string[];
  highlightScores?: number[];
  summary?: string;
  subpages?: ExaSearchResult[];
  extras?: {
    links?: string[];
    imageLinks?: string[];
  };
};

type BochaSearchResult = {
  id: string | null;
  name: string;
  url: string;
  displayUrl: string;
  snippet: string;
  summary?: string;
  siteName: string;
  siteIcon: string;
  dateLastCrawled: string;
  cachedPageUrl: string | null;
  language: string | null;
  isFamilyFriendly: boolean | null;
  isNavigational: boolean | null;
};

type BochaImage = {
  webSearchUrl: string;
  name: string;
  thumbnailUrl: string;
  datePublished: string;
  contentUrl: string;
  hostPageUrl: string;
  contentSize: number;
  encodingFormat: string;
  hostPageDisplayUrl: string;
  width: number;
  height: number;
  thumbnail: {
    width: number;
    height: number;
  };
};

type SearxngSearchResult = {
  url: string;
  title: string;
  content?: string;
  engine: string;
  parsed_url: string[];
  template: "default.html" | "videos.html" | "images.html";
  engines: string[];
  positions: number[];
  publishedDate?: Date | null;
  thumbnail?: null | string;
  is_onion?: boolean;
  score: number;
  category: string;
  length?: null | string;
  duration?: null | string;
  iframe_src?: string;
  source?: string;
  metadata?: string;
  resolution?: null | string;
  img_src?: string;
  thumbnail_src?: string;
  img_format?: "jpeg" | "Culture Snaxx" | "png";
};

export interface SearchProviderOptions {
  provider: string;
  baseURL?: string;
  apiKey?: string;
  query: string;
  maxResult?: number;
  scope?: string;
  model?: string;
}

export async function createSearchProvider({
  provider,
  baseURL,
  apiKey = "",
  query,
  maxResult = 5,
  scope,
  model: modelParam,
}: SearchProviderOptions) {
  const headers: HeadersInit = {
    "Content-Type": "application/json",
  };
  if (apiKey) headers.Authorization = `Bearer ${apiKey}`;

  if (provider === "tavily") {
    const response = await fetch(
      `${completePath(baseURL || TAVILY_BASE_URL)}/search`,
      {
        method: "POST",
        headers,
        credentials: "omit",
        body: JSON.stringify({
          query: query.replaceAll("\\", "").replaceAll('"', ""),
          search_depth: "advanced",
          topic: scope || "general",
          max_results: Number(maxResult),
          include_images: true,
          include_image_descriptions: true,
          include_answer: false,
          include_raw_content: "markdown",
        }),
      }
    );
    const { results = [], images = [] } = await response.json();
    return {
      sources: (results as TavilySearchResult[])
        .filter((item) => item.content && item.url)
        .map((result) => {
          return {
            title: result.title,
            content: result.rawContent || result.content,
            url: result.url,
          };
        }) as Source[],
      images: images as ImageSource[],
    };
  } else if (provider === "firecrawl") {
    const response = await fetch(
      `${completePath(baseURL || FIRECRAWL_BASE_URL, "/v1")}/search`,
      {
        method: "POST",
        headers,
        credentials: "omit",
        body: JSON.stringify({
          query,
          limit: maxResult,
          tbs: "qdr:w",
          origin: "api",
          scrapeOptions: {
            formats: ["markdown"],
          },
          timeout: 60000,
        }),
      }
    );
    const { data = [] } = await response.json();
    return {
      sources: (data as FirecrawlDocument[])
        .filter((item) => item.description && item.url)
        .map((result) => ({
          content: result.markdown || result.description,
          url: result.url,
          title: result.title,
        })) as Source[],
      images: [],
    };
  } else if (provider === "exa") {
    const response = await fetch(
      `${completePath(baseURL || EXA_BASE_URL)}/search`,
      {
        method: "POST",
        headers,
        credentials: "omit",
        body: JSON.stringify({
          query,
          category: scope || "research paper",
          contents: {
            text: true,
            summary: {
              query: `Given the following query from the user:\n<query>${query}</query>\n\n${rewritingPrompt}`,
            },
            numResults: Number(maxResult) * 5,
            livecrawl: "auto",
            extras: {
              imageLinks: 3,
            },
          },
        }),
      }
    );
    const { results = [] } = await response.json();
    const images: ImageSource[] = [];
    return {
      sources: (results as ExaSearchResult[])
        .filter((item) => (item.summary || item.text) && item.url)
        .map((result) => {
          if (
            result.extras?.imageLinks &&
            result.extras?.imageLinks.length > 0
          ) {
            result.extras.imageLinks.forEach((url) => {
              images.push({ url, description: result.text });
            });
          }
          return {
            content: result.summary || result.text,
            url: result.url,
            title: result.title,
          };
        }) as Source[],
      images,
    };
  } else if (provider === "bocha") {
    const response = await fetch(
      `${completePath(baseURL || BOCHA_BASE_URL, "/v1")}/web-search`,
      {
        method: "POST",
        headers,
        credentials: "omit",
        body: JSON.stringify({
          query,
          freshness: "noLimit",
          summary: true,
          count: maxResult,
        }),
      }
    );
    const { data = {} } = await response.json();
    const results = data.webPages?.value || [];
    const imageResults = data.images?.value || [];
    return {
      sources: (results as BochaSearchResult[])
        .filter((item) => item.snippet && item.url)
        .map((result) => ({
          content: result.summary || result.snippet,
          url: result.url,
          title: result.name,
        })) as Source[],
      images: (imageResults as BochaImage[]).map((item) => {
        const matchingResult = (results as BochaSearchResult[]).find(
          (result) => result.url === item.hostPageUrl
        );
        return {
          url: item.contentUrl,
          description: item.name || matchingResult?.name,
        };
      }) as ImageSource[],
    };
  } else if (provider === "grok") {
    const model = modelParam || "grok-4.20-fast";
    const response = await fetch(
      `${completePath(baseURL || GROK_BASE_URL)}/chat/completions`,
      {
        method: "POST",
        headers: {
          ...headers,
          // Bypass CDN/edge cache
          "Cache-Control": "no-cache, no-store, must-revalidate",
          Pragma: "no-cache",
        },
        credentials: "omit",
        body: JSON.stringify({
          model,
          messages: [
            {
              role: "system",
              content: `你是网页搜索助手。对每条搜索结果严格按以下格式逐条输出，不要合并条目：

### {网页标题}
URL: {该结果的真实网址}
{该网页的详细摘要}

格式与内容要求：
- 每条结果必须以 "### " 开头，紧接网页标题；下一行必须是 "URL: " 开头并跟该结果的真实网址；再下一行起是该网页的摘要正文。
- 摘要必须忠于搜索到的原文，禁止捏造、脑补或臆测；没有真正搜到的内容一律不写。
- 摘要要保留关键事实、数据、名称、结论等关键信息，宁可详细也不要省略关键点；表述可以简短，但不准丢关键信息。
- 每条结果的 URL 必须真实存在且对应其内容；不要在摘要正文里引用与该条无关的其他网址。
- 逐条输出，条目之间用一个空行分隔；最后不要再额外添加 "Sources" 或参考文献列表。
- 用与查询相同的语言输出。`,
            },
            {
              role: "user",
              content: `搜索：${query}`,
            },
          ],
          // Add random seed + timestamp to avoid cached/stale responses
          seed: Math.floor(Math.random() * 2147483647),
          user: `cache-buster-${Date.now()}`,
          stream: false,
        }),
      }
    );
    const data = await response.json();
    const content = String(data.choices?.[0]?.message?.content ?? "");
    // 按块切分：每个 "### " 块为一条结果，取 URL: 锚点 + 该块正文作为独立 content
    const blocks = content
      .split(/^###\s+/m)
      .map((block) => block.trim())
      .filter(Boolean);
    const sources: Source[] = [];
    for (const block of blocks) {
      const urlMatch = block.match(/^URL:\s*(\S+)/im);
      if (!urlMatch) continue;
      const firstLine = block.split("\n")[0].trim();
      const title = firstLine.replace(/^\[.*?\]\s*/, "").trim();
      const body = block.replace(/^URL:\s*\S+/im, "").trim();
      sources.push({
        url: urlMatch[1],
        title: title || "",
        content: body,
      });
    }

    return { sources, images: [] };
  } else if (provider === "searxng") {
    const params = {
      q: query,
      categories:
        scope === "academic" ? ["science", "images"] : ["general", "images"],
      engines:
        scope === "academic"
          ? [
              "arxiv",
              "google scholar",
              "pubmed",
              "wikispecies",
              "google_images",
            ]
          : [
              "google",
              "bing",
              "duckduckgo",
              "brave",
              "wikipedia",
              "bing_images",
              "google_images",
            ],
      lang: "auto",
      format: "json",
      autocomplete: "google",
    };
    const searchQuery = new URLSearchParams();
    for (const [key, value] of Object.entries(params)) {
      searchQuery.append(key, value.toString());
    }
    const local = global.location || {};
    const response = await fetch(
      `${completePath(
        baseURL || SEARXNG_BASE_URL
      )}/search?${searchQuery.toString()}`,
      baseURL?.startsWith(local.origin)
        ? { method: "POST", credentials: "omit", headers }
        : { method: "GET", credentials: "omit" }
    );
    const { results = [] } = await response.json();
    const rearrangedResults = sort(
      results as SearxngSearchResult[],
      (item) => item.score,
      true
    );
    return {
      sources: rearrangedResults
        .filter((item) => item.content && item.url && item.score >= 0.5)
        .slice(0, maxResult * 5)
        .map((result) => pick(result, ["title", "content", "url"])) as Source[],
      images: rearrangedResults
        .filter((item) => item.category === "images" && item.score >= 0.5)
        .slice(0, maxResult)
        .map((result) => {
          return {
            url: result.img_src,
            description: result.title,
          };
        }) as ImageSource[],
    };
  } else {
    throw new Error("Unsupported Provider: " + provider);
  }
}
