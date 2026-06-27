import { generateText } from "ai";
import { z } from "zod";

// ===== Schemas =====

const searchPlanSchema = z.object({
  searchQueries: z.array(z.string()).min(1).max(5),
});

const searchEvaluationSchema = z.object({
  needMoreSearch: z.boolean(),
  followUpQueries: z.array(z.string()).max(3),
  gaps: z.string().optional(),
});

// ===== Types =====

export interface SearchRound {
  queries: string[];
  sources: Source[];
}

export interface PreSearchResult {
  rounds: SearchRound[];
  allSources: Source[];
  formattedContext: string;
}

// ===== Helpers =====

function tryExtractJson(text: string): any | null {
  try {
    // Try extracting from markdown code block first
    const blockMatch = text.match(/```(?:json)?\s*([\s\S]*?)```/);
    if (blockMatch) return JSON.parse(blockMatch[1].trim());
    // Then try raw JSON in text
    const braceMatch = text.match(/\{[\s\S]*\}/);
    if (braceMatch) return JSON.parse(braceMatch[0]);
    return null;
  } catch {
    return null;
  }
}

// ===== Formatting =====

function formatSourcesAsContext(allSources: Source[]): string {
  if (!allSources || allSources.length === 0) return "";
  const formatted = allSources
    .map(
      (s, i) =>
        `[${i + 1}] ${s.title || s.url}\nURL: ${s.url}\n${s.content || ""}`
    )
    .join("\n\n---\n\n");
  return `\n### Web Search Results (for factual grounding) ###\n\n${formatted}\n\n### End of Web Search Results ###\n`;
}

function formatSourcesForEvaluation(rounds: SearchRound[]): string {
  return rounds
    .map((round, i) => {
      const header = `### Round ${i + 1} (queries: ${round.queries.join("; ")}) ###\n`;
      const sources = round.sources
        .map(
          (s, j) =>
            `[${j + 1}] ${s.title || s.url}\nURL: ${s.url}\n${s.content || ""}`
        )
        .join("\n\n---\n\n");
      return header + sources;
    })
    .join("\n\n");
}

// ===== Core Functions =====

/**
 * Step 1: 模型分析问题，生成搜索查询列表
 * 使用 generateText + JSON 解析（兼容纯推理模型如 DeepSeek Reasoner）
 */
export async function generateSearchPlan(
  problemStatement: string,
  model: any,
  userAnswers?: string
): Promise<string[]> {
  let prompt = `你是一个研究助手。在深入分析以下问题之前，你需要先搜索互联网获取真实、最新的资料。

<问题>
${problemStatement}
</问题>`;

  if (userAnswers) {
    prompt += `\n\n<用户提供的额外背景>\n${userAnswers}\n</用户提供的额外背景>`;
  }

  prompt += `\n\n请列出你需要搜索的关键信息方向。生成 3-5 个具体的搜索查询（用与问题相同的语言），每个查询针对问题的不同方面。查询要具体、可执行，能搜到真实有用的资料。

以 JSON 格式输出（不要 markdown 代码块标记）：
{"searchQueries": ["query1", "query2", "query3"]}`;

  try {
    const result = await generateText({ model, prompt });
    const parsed = tryExtractJson(result.text);
    if (parsed?.searchQueries && Array.isArray(parsed.searchQueries)) {
      return parsed.searchQueries.slice(0, 5).filter(Boolean);
    }
  } catch {
    // fallthrough
  }
  // Fallback: use problemStatement as the only query
  return [problemStatement];
}

/**
 * Step 2: 执行一轮搜索
 */
export async function executeSearchRound(
  queries: string[],
  searchFn: (query: string) => Promise<{
    sources: Source[];
    images: ImageSource[];
  }>,
  onProgress?: (msg: string) => void
): Promise<SearchRound> {
  const allSources: Source[] = [];
  const seenUrls = new Set<string>();

  for (const query of queries) {
    onProgress?.(`搜索: ${query}`);
    try {
      const { sources } = await searchFn(query);
      for (const s of sources) {
        if (!seenUrls.has(s.url)) {
          seenUrls.add(s.url);
          allSources.push(s);
        }
      }
    } catch (err) {
      console.warn(`Search failed for "${query}":`, err);
    }
  }

  return { queries, sources: allSources };
}

/**
 * Step 3: 模型评估搜索结果，判断是否需要继续搜索
 * 使用 generateText + JSON 解析
 */
export async function evaluateSearchResults(
  problemStatement: string,
  rounds: SearchRound[],
  model: any
): Promise<{
  needMoreSearch: boolean;
  followUpQueries: string[];
  gaps?: string;
}> {
  const allResults = formatSourcesForEvaluation(rounds);

  const prompt = `你是一个研究助手。你已经对以下问题进行了多轮搜索。请评估搜索结果是否充分。

<问题>
${problemStatement}
</问题>

<已搜索的结果>
${allResults}
</已搜索的结果>

请评估：
1. 搜索结果是否已经覆盖了问题的关键方面？
2. 是否还有重要的信息缺口？
3. 是否需要更多搜索来填补缺口？（注意：如果信息已经足够，不要过度搜索——最多再搜一轮）

以 JSON 格式输出（不要 markdown 代码块标记）：
{"needMoreSearch": true/false, "followUpQueries": ["query1", "query2"], "gaps": "信息缺口描述"}`;

  try {
    const result = await generateText({ model, prompt });
    const parsed = tryExtractJson(result.text);
    if (parsed) {
      return {
        needMoreSearch: parsed.needMoreSearch === true,
        followUpQueries: Array.isArray(parsed.followUpQueries) ? parsed.followUpQueries.slice(0, 3).filter(Boolean) : [],
        gaps: typeof parsed.gaps === "string" ? parsed.gaps : undefined,
      };
    }
  } catch {
    // fallthrough
  }
  return { needMoreSearch: false, followUpQueries: [] };
}

/**
 * 完整的 Pre-Search 流程：多轮搜索 → 汇总结果
 *
 * 在 DT 引擎运行前调用，将搜索到的真实资料作为 knowledgeContext 注入 DT。
 * 不依赖 DT 引擎内部的 tool-calling 机制——纯推理模型也能拿到真实资料。
 */
export async function runPreSearchPhase(
  problemStatement: string,
  model: any,
  searchFn: (query: string) => Promise<{
    sources: Source[];
    images: ImageSource[];
  }>,
  options?: {
    userAnswers?: string;
    maxRounds?: number;
    onProgress?: (msg: string) => void;
  }
): Promise<PreSearchResult> {
  const maxRounds = options?.maxRounds ?? 3;
  const rounds: SearchRound[] = [];
  const allSources: Source[] = [];
  const seenUrls = new Set<string>();

  // Round 1: Model generates search plan
  options?.onProgress?.("Pre-search: 分析问题，生成搜索计划...");
  const initialQueries = await generateSearchPlan(
    problemStatement,
    model,
    options?.userAnswers
  );

  if (!initialQueries || initialQueries.length === 0) {
    options?.onProgress?.("Pre-search: 未生成搜索查询，跳过");
    return { rounds: [], allSources: [], formattedContext: "" };
  }

  options?.onProgress?.(`Pre-search: 搜索计划 - ${initialQueries.join(" | ")}`);

  // Execute first round
  const round1 = await executeSearchRound(
    initialQueries,
    searchFn,
    (msg) => options?.onProgress?.(`Pre-search: ${msg}`)
  );
  rounds.push(round1);
  for (const s of round1.sources) {
    if (!seenUrls.has(s.url)) {
      seenUrls.add(s.url);
      allSources.push(s);
    }
  }

  options?.onProgress?.(`Pre-search: 第 1 轮完成，${round1.sources.length} 条结果`);

  // If first round got 0 results, don't bother evaluating — skip to end
  if (allSources.length === 0) {
    options?.onProgress?.("Pre-search: 搜索未返回结果，跳过后续轮次");
    return { rounds, allSources: [], formattedContext: "" };
  }

  // Additional rounds: Model evaluates and decides if more search needed
  for (let r = 1; r < maxRounds; r++) {
    const evaluation = await evaluateSearchResults(
      problemStatement,
      rounds,
      model
    );

    if (!evaluation.needMoreSearch || evaluation.followUpQueries.length === 0) {
      options?.onProgress?.("Pre-search: 搜索资料已充分");
      break;
    }

    options?.onProgress?.(
      `Pre-search: 信息缺口 - ${evaluation.gaps || "需补充搜索"}。第 ${r + 1} 轮...`
    );

    const round = await executeSearchRound(
      evaluation.followUpQueries,
      searchFn,
      (msg) => options?.onProgress?.(`Pre-search: ${msg}`)
    );
    rounds.push(round);
    for (const s of round.sources) {
      if (!seenUrls.has(s.url)) {
        seenUrls.add(s.url);
        allSources.push(s);
      }
    }

    options?.onProgress?.(`Pre-search: 第 ${r + 1} 轮完成，+${round.sources.length} 条新结果`);
  }

  options?.onProgress?.(`Pre-search: 完成 — ${rounds.length} 轮，${allSources.length} 条去重结果`);

  return {
    rounds,
    allSources,
    formattedContext: formatSourcesAsContext(allSources),
  };
}
