import {
  generateText,
  generateObject,
  tool,
  type Tool,
  type JSONValue,
} from "ai";
import { z } from "zod";
import {
  deepThinkInitialPrompt,
  selfImprovementPrompt,
  verificationSystemPrompt,
  correctionPrompt,
  buildVerificationPrompt,
  buildInitialThinkingPrompt,
  extractDetailedSolutionMarker,
  ultraThinkPlanPrompt,
  generateAgentPromptsPrompt,
  synthesizeResultsPrompt,
  buildFinalSummaryPrompt,
  buildAskQuestionsPrompt,
  buildThinkingPlanPrompt,
  structureAlignSystemPrompt,
  buildStructureAlignPrompt,
} from "./prompts";
import { throwIfAborted } from "./registry";


type ProviderOptions = Record<string, Record<string, JSONValue>>;
type Tools = Record<string, Tool>;

export interface ModelStageConfig {
  /** 初始思考阶段的模型 */
  initial?: string;
  /** 自我改进阶段的模型 */
  improvement?: string;
  /** 验证阶段的模型 */
  verification?: string;
  /** 修正阶段的模型 */
  correction?: string;
  /** 最终总结阶段的模型 */
  summary?: string;
  /** UltraThink: 生成计划阶段的模型 */
  planning?: string;
  /** UltraThink: 生成agent配置阶段的模型 */
  agentConfig?: string;
  /** UltraThink: agent思考阶段的模型 */
  agentThinking?: string;
  /** UltraThink: 合成结果阶段的模型 */
  synthesis?: string;
  /** Pre-Search: 搜索阶段生成搜索计划和评估结果的模型 */
  search?: string;
  /** 结构对齐（diff 防空审查）阶段的模型 */
  structureAlign?: string;
}

export interface DeepThinkOptions {
  problemStatement: string;
  otherPrompts?: string[];
  knowledgeContext?: string;
  maxIterations?: number;
  requiredSuccessfulVerifications?: number;
  maxErrorsBeforeGiveUp?: number;
  enableWebSearch?: boolean;
  searchProvider?: {
    provider: string;
    maxResult?: number;
  };
  /** 外部搜索回调：引擎通过此函数执行搜索（grok/tavily 等），思考模型按需调用 web_search 工具 */
  searchFn?: (query: string) => Promise<{ sources: Source[]; images: ImageSource[] }>;
  /** 是否启用询问阶段 - 在开始前提出澄清问题 */
  enableAskQuestions?: boolean;
  /** 用户对询问的回答（如果有的话） */
  userAnswers?: string;
  /** 是否启用计划阶段 - 在开始前制定思考计划 */
  enablePlanning?: boolean;
  /**
   * 启用 diff 防空审查：截取 Deep Dive 失败时，先用模型通读全文补标准标题/归段，
   * 再截段给验证模型（不默认全文硬审）。
   */
  enableDiffAntiEmptyVerify?: boolean;
  /** 是否启用交互模式 - 在问问题阶段等待用户回答 */
  enableInteractiveMode?: boolean;
  onProgress?: (event: DeepThinkProgressEvent) => void;
  createModelProvider: (model: string, options?: any) => Promise<any>;
  thinkingModel: string;
  taskModel?: string;
  /** 分阶段模型配置，未指定的阶段使用 thinkingModel */
  modelStages?: ModelStageConfig;
  /** 中断信号：透传给所有 LLM 调用，并在主循环各检查点判断 */
  abortSignal?: AbortSignal;
  /** 断点续跑：从上次中断的快照恢复，跳过已完成的阶段 */
  resumeFrom?: ThinkTaskSnapshot;
}

export type DeepThinkProgressEvent =
  | { type: "init"; data: { problem: string } }
  | { type: "asking"; data: { questions: string } }
  | { type: "waiting_for_answers"; data: { questions: string } }
  | { type: "planning"; data: { plan: string } }
  | { type: "thinking"; data: { iteration: number; phase: string } }
  | { type: "solution"; data: { solution: string; iteration: number } }
  | { type: "verification"; data: { passed: boolean; iteration: number } }
  | { type: "correction"; data: { iteration: number } }
  | { type: "summarizing"; data: { message: string } }
  | { type: "success"; data: { solution: string; iterations: number } }
  | { type: "failure"; data: { reason: string } }
  | { type: "progress"; data: { message: string } }
  /** 阶段性快照：外层据此保存进度，失败后可从此处续跑 */
  | { type: "snapshot"; data: Partial<ThinkTaskSnapshot> };

export class DeepThinkEngine {
  private options: DeepThinkOptions;
  private sources: Source[] = []; // 追踪所有搜索来源

  constructor(options: DeepThinkOptions) {
    this.options = {
      maxIterations: 30,
      requiredSuccessfulVerifications: 3,
      maxErrorsBeforeGiveUp: 10,
      enableWebSearch: false,
      ...options,
    };
  }

  private emit(event: DeepThinkProgressEvent) {
    if (this.options.onProgress) {
      this.options.onProgress(event);
    }
  }

  /** 中断检查点：在长循环的各阶段之间调用，避免取消后还跑完整轮 */
  private checkAborted() {
    throwIfAborted(this.options.abortSignal);
  }

  /**
   * 获取指定阶段应该使用的模型
   * 如果该阶段没有配置特定模型，则使用默认的 thinkingModel
   */
  private getModelForStage(stage: keyof ModelStageConfig): string {
    return this.options.modelStages?.[stage] || this.options.thinkingModel;
  }

  /**
   * 从 generateText 结果中提取搜索来源
   */
  private extractSourcesFromResult(result: any): void {
    if (!result.experimental_providerMetadata) return;
    
    const metadata = result.experimental_providerMetadata;
    
    // OpenAI 搜索结果提取
    if (metadata.openai?.webSearch?.results) {
      const searchResults = metadata.openai.webSearch.results;
      searchResults.forEach((item: any) => {
        if (item.url && item.title) {
          this.sources.push({
            url: item.url,
            title: item.title,
            content: item.snippet || item.content || "",
          });
        }
      });
    }
    
    // OpenRouter 搜索结果提取 (如果有的话)
    if (metadata.openrouter?.webSearch?.results) {
      const searchResults = metadata.openrouter.webSearch.results;
      searchResults.forEach((item: any) => {
        if (item.url && item.title) {
          this.sources.push({
            url: item.url,
            title: item.title,
            content: item.snippet || item.content || "",
          });
        }
      });
    }
  }

  private async getSearchTools(): Promise<Tools | undefined> {
    if (!this.options.enableWebSearch) return undefined;

    const { thinkingModel } = this.options;
    const { provider = "model", maxResult = 5 } = this.options.searchProvider || {};

    // 外部搜索 provider（grok/tavily 等）：创建 web_search 工具，模型推理时按需调用
    if (provider !== "model" && this.options.searchFn) {
      const searchFn = this.options.searchFn;
      return {
        web_search: tool({
          description:
            "搜索互联网获取实时、真实的信息。当问题需要最新数据、外部事实或需要验证不确定的信息时主动调用。",
          parameters: z.object({
            query: z.string().describe("搜索查询词"),
          }),
          execute: async ({ query }) => {
            const { sources } = await searchFn(query);
            sources.forEach((s) => this.sources.push(s));
            if (sources.length === 0) return "未找到相关结果。";
            return sources
              .map(
                (s, i) =>
                  `[${i + 1}] ${s.title || s.url}\n${s.content || ""}`
              )
              .join("\n\n---\n\n");
          },
        }),
      };
    }

    // Enable OpenAI's built-in search tool
    if (
      provider === "model" &&
      thinkingModel.startsWith("gpt-4o")
    ) {
      const { openai } = await import("@ai-sdk/openai");
      return {
        web_search_preview: openai.tools.webSearchPreview({
          searchContextSize: maxResult > 5 ? "high" : "medium",
        }),
      };
    }

    return undefined;
  }

  private getProviderOptions(): ProviderOptions | undefined {
    if (!this.options.enableWebSearch) return undefined;

    const { thinkingModel } = this.options;
    const { provider = "model", maxResult = 5 } = this.options.searchProvider || {};

    // Enable OpenRouter's built-in search tool
    if (provider === "model" && thinkingModel.includes("openrouter")) {
      return {
        openrouter: {
          plugins: [
            {
              id: "web",
              max_results: maxResult ?? 5,
            },
          ],
        },
      };
    }

    return undefined;
  }

  /**
   * 从完整回复里按「标题行」截取段落。
   *
   * - 只认标题行形态（行首 / # 标题 / **加粗** / 可选编号），禁止正文子串误匹配
   * - after=true 且找不到标记：返回 ""（由 verifySolution 决定是否走 diff 对齐）
   * - after=false 且找不到标记：返回全文（用于抽 Summary 等）
   */
  private extractDetailedSolution(
    solution: string,
    marker: string = extractDetailedSolutionMarker,
    after: boolean = true
  ): string {
    if (!solution) return "";

    const escaped = marker.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
    // 标题行：## Deep Dive / **2. Deep Dive** / Deep Dive:
    const headingRe = new RegExp(
      `(^|\\n)[ \\t]*(?:#{1,6}[ \\t]+)?(?:\\*{0,2})(?:\\d+\\.?\\s*)?${escaped}(?:\\*{0,2})[ \\t]*[:：]?[ \\t]*(?=\\n|$)`,
      "i"
    );
    const m = headingRe.exec(solution);

    if (!m) {
      return after ? "" : solution.trim();
    }

    const matchStart = m.index + (m[1] ? m[1].length : 0);
    const matchEnd = m.index + m[0].length;

    if (after) {
      return solution.substring(matchEnd).trim();
    }
    return solution.substring(0, matchStart).trim();
  }

  /**
   * 是否已有可审的 Deep Dive 段（标题行存在且正文够长）。
   */
  private hasReviewableDeepDive(solution: string): boolean {
    const sliced = this.extractDetailedSolution(solution);
    if (!sliced) return false;
    const fullLen = solution.trim().length;
    const minKeep = Math.min(80, Math.max(20, Math.floor(fullLen * 0.15)));
    return sliced.length >= minKeep;
  }

  /**
   * diff 防空审查：通读全文，只补标准标题/归段，不重写实质内容。
   * 成功条件：输出里能再截出非空 Deep Dive。
   */
  private async alignSolutionStructure(
    problemStatement: string,
    solution: string
  ): Promise<string | null> {
    this.emit({
      type: "progress",
      data: { message: "结构对齐中（diff 防空审查）..." },
    });
    this.checkAborted();

    try {
      const alignModel = this.getModelForStage("structureAlign");
      const model = await this.options.createModelProvider(alignModel);
      const result = await generateText({
        model,
        system: structureAlignSystemPrompt,
        prompt: buildStructureAlignPrompt(problemStatement, solution),
        abortSignal: this.options.abortSignal,
      });

      let text = result.text?.trim() ?? "";
      // 去掉模型偶尔加的 markdown 围栏
      const fenced = text.match(/^```(?:markdown|md)?\s*([\s\S]*?)```$/i);
      if (fenced) text = fenced[1].trim();

      if (!text || !this.hasReviewableDeepDive(text)) {
        this.emit({
          type: "progress",
          data: { message: "结构对齐未产出可用 Deep Dive，跳过对齐结果" },
        });
        return null;
      }

      this.emit({
        type: "progress",
        data: { message: "结构对齐完成，准备截段审查" },
      });
      return text;
    } catch (err) {
      if (err instanceof DOMException && err.name === "AbortError") throw err;
      if (err instanceof Error && (err.name === "AbortError" || /abort/i.test(err.message))) {
        throw err;
      }
      console.warn("structure align failed:", err);
      this.emit({
        type: "progress",
        data: { message: "结构对齐失败，将按现有正文尽量审查" },
      });
      return null;
    }
  }

  /**
   * 询问阶段 - 生成澄清问题
   */
  async askQuestions(problemStatement: string, waitForUserAnswers = false): Promise<string> {
    this.emit({
      type: "progress",
      data: { message: "Generating clarification questions..." },
    });

    const model = await this.options.createModelProvider(this.options.thinkingModel);
    const prompt = buildAskQuestionsPrompt(problemStatement);

    const result = await generateText({
      model,
      prompt,
      abortSignal: this.options.abortSignal,
    });

    const questions = result.text;
    this.emit({
      type: "asking",
      data: { questions },
    });

    // If we need to wait for user answers, emit the waiting event
    if (waitForUserAnswers) {
      this.emit({
        type: "waiting_for_answers",
        data: { questions },
      });
    }

    return questions;
  }

  /**
   * 计划阶段 - 生成思考计划
   */
  private async generateThinkingPlan(
    problemStatement: string,
    userAnswers?: string
  ): Promise<string> {
    this.emit({
      type: "progress",
      data: { message: "Generating thinking plan..." },
    });

    const model = await this.options.createModelProvider(this.options.thinkingModel);
    const prompt = buildThinkingPlanPrompt(problemStatement, userAnswers);

    const result = await generateText({
      model,
      prompt,
      abortSignal: this.options.abortSignal,
    });

    const plan = result.text;
    this.emit({
      type: "planning",
      data: { plan },
    });

    return plan;
  }

  private async verifySolution(
    problemStatement: string,
    solution: string
  ): Promise<{ bugReport: string; goodVerify: string }> {
    let working = solution;
    let detailedSolution = this.extractDetailedSolution(working);

    // 截不到可用 Deep Dive：可选走 diff 结构对齐（通读全文补标签），再截段
    // —— 不把全文硬塞给弱验证模型；对齐失败才有限回退全文，避免再审空
    if (!this.hasReviewableDeepDive(working)) {
      if (this.options.enableDiffAntiEmptyVerify) {
        const aligned = await this.alignSolutionStructure(
          problemStatement,
          working
        );
        if (aligned) {
          working = aligned;
          detailedSolution = this.extractDetailedSolution(working);
        }
      }
      // 仍空：最后手段才全文（总比 Analysis to Review 空白空转好）
      if (!detailedSolution?.trim()) {
        detailedSolution = working.trim();
        this.emit({
          type: "progress",
          data: {
            message: this.options.enableDiffAntiEmptyVerify
              ? "对齐后仍无 Deep Dive，临时全文送审"
              : "未启用 diff 防空审查且无 Deep Dive，临时全文送审",
          },
        });
      }
    }

    const verificationPrompt = buildVerificationPrompt(
      problemStatement,
      detailedSolution
    );

    this.emit({ type: "progress", data: { message: "Verifying solution..." } });

    // 使用验证阶段的模型
    const verificationModel = this.getModelForStage("verification");
    const model = await this.options.createModelProvider(verificationModel);

    // Get verification
    const verificationResult = await generateText({
      model,
      system: verificationSystemPrompt,
      prompt: verificationPrompt,
      abortSignal: this.options.abortSignal,
    });

    const verificationOutput = verificationResult.text;

    // yes/no：优先行首；避免正文偶然出现 yes 误通过
    const checkPrompt = `Reply with exactly one word: yes or no.
Is the following review saying the work is acceptable overall (no critical flaw and no major justification gap)?
- yes = sound enough (minor issues OK)
- no = critical flaw, major gap, incomplete, OR review says content is missing/empty

Review:
${verificationOutput}`;

    const checkResult = await generateText({
      model,
      prompt: checkPrompt,
      abortSignal: this.options.abortSignal,
    });

    const raw = checkResult.text.trim();
    const head = raw.split(/\s+/)[0]?.replace(/[^a-zA-Z一-鿿]/g, "") ?? "";
    const passed =
      /^(yes|y|是|通过|正确)$/i.test(head) ||
      (/^yes\b/i.test(raw) && !/^no\b/i.test(raw));

    let bugReport = "";
    if (!passed) {
      // 优先 Summary（Detailed Review 标题之前）；否则整段审查给修正阶段
      const summaryOnly = this.extractDetailedSolution(
        verificationOutput,
        "Detailed Review",
        false
      );
      bugReport =
        summaryOnly &&
        summaryOnly.length >= 40 &&
        summaryOnly.length < verificationOutput.length
          ? summaryOnly
          : verificationOutput;
    }

    // 主循环用 includes("yes")；通过时规范成 "yes"
    return { bugReport, goodVerify: passed ? "yes" : raw || "no" };
  }

  private   async initialExploration(
    problemStatement: string,
    otherPrompts: string[] = []
  ): Promise<{
    solution: string;
    verification: { bugReport: string; goodVerify: string };
  } | null> {
    this.emit({
      type: "thinking",
      data: { iteration: 0, phase: "initial-exploration" },
    });

    // 使用初始思考阶段的模型
    const initialModel = this.getModelForStage("initial");
    const model = await this.options.createModelProvider(initialModel);

    const fullPrompt = buildInitialThinkingPrompt(
      problemStatement,
      otherPrompts,
      this.options.knowledgeContext
    );

    // First solution
    const firstResult = await generateText({
      model,
      prompt: fullPrompt,
      tools: await this.getSearchTools(),
      providerOptions: this.getProviderOptions(),
      maxSteps: 5,
      abortSignal: this.options.abortSignal,
    });

    // 提取搜索来源
    this.extractSourcesFromResult(firstResult);

    const firstSolution = firstResult.text;
    this.emit({
      type: "solution",
      data: { solution: firstSolution, iteration: 0 },
    });

    // Self-improvement
    this.emit({
      type: "thinking",
      data: { iteration: 0, phase: "self-improvement" },
    });

    // 使用自我改进阶段的模型
    const improvementModel = this.getModelForStage("improvement");
    const improvementModelProvider = await this.options.createModelProvider(improvementModel);

    const systemPromptWithKnowledge = this.options.knowledgeContext
      ? deepThinkInitialPrompt +
        "\n\n### Available Knowledge Base ###\n\n" +
        this.options.knowledgeContext +
        "\n\n### End of Knowledge Base ###\n"
      : deepThinkInitialPrompt;

    const improvementResult = await generateText({
      model: improvementModelProvider,
      system: systemPromptWithKnowledge,
      messages: [
        { role: "user", content: problemStatement },
        { role: "assistant", content: firstSolution },
        { role: "user", content: selfImprovementPrompt },
      ],
      tools: await this.getSearchTools(),
      providerOptions: this.getProviderOptions(),
      maxSteps: 5,
      abortSignal: this.options.abortSignal,
    });

    // 提取搜索来源
    this.extractSourcesFromResult(improvementResult);

    const improvedSolution = improvementResult.text;
    this.emit({
      type: "solution",
      data: { solution: improvedSolution, iteration: 0 },
    });

    // Verify
    const verification = await this.verifySolution(
      problemStatement,
      improvedSolution
    );

    this.emit({
      type: "verification",
      data: {
        passed: verification.goodVerify.toLowerCase().includes("yes"),
        iteration: 0,
      },
    });

    return { solution: improvedSolution, verification };
  }

  async run(): Promise<DeepThinkResult> {
    const { problemStatement, otherPrompts = [] } = this.options;
    const maxIterations = this.options.maxIterations!;
    const requiredSuccesses = this.options.requiredSuccessfulVerifications!;
    const maxErrors = this.options.maxErrorsBeforeGiveUp!;
    const resume = this.options.resumeFrom;

    this.checkAborted();
    this.emit({ type: "init", data: { problem: problemStatement } });

    // 恢复已有来源，避免续跑后引用丢失
    if (resume?.sources?.length) {
      this.sources.push(...resume.sources);
    }

    let questions: string | undefined = resume?.questions;
    let plan: string | undefined = resume?.plan;

    // Ask questions phase (optional) —— 已有则跳过
    if (this.options.enableAskQuestions && !questions) {
      questions = await this.askQuestions(problemStatement, this.options.enableInteractiveMode);
      // Note: In interactive mode, the process may pause here for user input
      // The actual continuation will be handled by the calling code
    }

    // Planning phase (optional) —— 已有则跳过
    if (this.options.enablePlanning && !plan) {
      plan = await this.generateThinkingPlan(
        problemStatement,
        this.options.userAnswers
      );
    }
    // 计划要注入上下文，无论是新生成的还是从快照恢复的
    if (plan) {
      otherPrompts.push(`\n### Thinking Plan ###\n${plan}\n`);
    }
    this.emit({ type: "snapshot", data: { questions, plan } });

    let initialThought: string;
    let solution: string;
    let verification: { bugReport: string; goodVerify: string };
    const iterations: DeepThinkIteration[] = resume?.iterations
      ? [...resume.iterations]
      : [];
    const verifications: Verification[] = resume?.verifications
      ? [...resume.verifications]
      : [];
    let correctCount: number;

    if (resume?.solution) {
      // 续跑：沿用上次的解，重新验证一次以拿到当前的 bugReport
      initialThought = resume.initialThought ?? resume.solution;
      solution = resume.solution;
      this.emit({
        type: "progress",
        data: { message: "从上次中断处恢复，重新验证当前方案..." },
      });
      verification = await this.verifySolution(problemStatement, solution);
      correctCount = resume.correctCount ?? 0;
    } else {
      // Initial exploration
      const initial = await this.initialExploration(problemStatement, otherPrompts);
      if (!initial) {
        throw new Error("Failed in initial exploration");
      }
      initialThought = initial.solution;
      solution = initial.solution;
      verification = initial.verification;
      correctCount = verification.goodVerify.toLowerCase().includes("yes") ? 1 : 0;
    }

    this.emit({
      type: "snapshot",
      data: {
        initialThought,
        solution,
        sources: this.sources.length > 0 ? [...this.sources] : undefined,
      },
    });

    let errorCount = 0;
    const startIteration = resume?.completedIterations ?? 0;

    // Main loop
    for (let i = startIteration; i < maxIterations; i++) {
      // 取消后立即退出，不再跑完当前这一轮（一轮可能好几分钟）
      this.checkAborted();

      const passed = verification.goodVerify.toLowerCase().includes("yes");

      verifications.push({
        timestamp: Date.now(),
        passed,
        bugReport: verification.bugReport,
        goodVerify: verification.goodVerify,
      });

      iterations.push({
        iteration: i,
        solution,
        verification: verifications[verifications.length - 1],
        status: passed ? "completed" : "correcting",
      });

      if (!passed) {
        correctCount = 0;
        errorCount++;

        if (errorCount >= maxErrors) {
          this.emit({
            type: "failure",
            data: { reason: "Too many errors" },
          });
          break;
        }

        // Correction
        this.emit({ type: "correction", data: { iteration: i } });

        // 使用修正阶段的模型
        const correctionModel = this.getModelForStage("correction");
        const model = await this.options.createModelProvider(correctionModel);

        const systemPromptWithKnowledge = this.options.knowledgeContext
          ? deepThinkInitialPrompt +
            "\n\n### Available Knowledge Base ###\n\n" +
            this.options.knowledgeContext +
            "\n\n### End of Knowledge Base ###\n"
          : deepThinkInitialPrompt;

        const correctionResult = await generateText({
          model,
          system: systemPromptWithKnowledge,
          messages: [
            { role: "user", content: problemStatement },
            { role: "assistant", content: solution },
            {
              role: "user",
              content: correctionPrompt + "\n\n" + verification.bugReport,
            },
          ],
          tools: await this.getSearchTools(),
          providerOptions: this.getProviderOptions(),
          maxSteps: 5,
          abortSignal: this.options.abortSignal,
        });

        // 提取搜索来源
        this.extractSourcesFromResult(correctionResult);

        solution = correctionResult.text;
        this.emit({
          type: "solution",
          data: { solution, iteration: i + 1 },
        });
      } else {
        correctCount++;
        errorCount = 0;
      }

      // 快照必须落在修正/计数更新之后 —— 此时 solution 是最新一版、correctCount 已更新，
      // 续跑时从 i+1 轮开始才不会重复或倒退
      this.emit({
        type: "snapshot",
        data: {
          initialThought,
          solution,
          iterations: [...iterations],
          verifications: [...verifications],
          completedIterations: i + 1,
          correctCount,
          sources: this.sources.length > 0 ? [...this.sources] : undefined,
        },
      });

      if (correctCount >= requiredSuccesses) {
        // Generate final summary for the user
        this.emit({
          type: "summarizing",
          data: { message: "Generating final summary..." },
        });

        const summaryModel = this.getModelForStage("summary");
        const summaryModelProvider = await this.options.createModelProvider(summaryModel);

        const summaryPrompt = buildFinalSummaryPrompt(
          problemStatement,
          solution
        );

        const summaryResult = await generateText({
          model: summaryModelProvider,
          prompt: summaryPrompt,
          abortSignal: this.options.abortSignal,
        });

        const finalSummary = summaryResult.text;

        this.emit({
          type: "success",
          data: { solution: finalSummary, iterations: i + 1 },
        });

        return {
          mode: "deep-think",
          questions,
          userAnswers: this.options.userAnswers,
          plan,
          initialThought,
          improvements: [],
          iterations,
          verifications,
          finalSolution: solution,
          summary: finalSummary,
          totalIterations: i + 1,
          successfulVerifications: correctCount,
          sources: this.sources.length > 0 ? this.sources : undefined,
          knowledgeEnhanced: this.sources.length > 0,
        };
      }

      // Verify again
      verification = await this.verifySolution(problemStatement, solution);
      this.emit({
        type: "verification",
        data: {
          passed: verification.goodVerify.toLowerCase().includes("yes"),
          iteration: i + 1,
        },
      });
    }

    // Failed to find solution - still generate a summary with what we have
    this.emit({
      type: "summarizing",
      data: { message: "Generating final summary..." },
    });

    const summaryModel = this.getModelForStage("summary");
    const summaryModelProvider = await this.options.createModelProvider(summaryModel);

    const summaryPrompt = buildFinalSummaryPrompt(
      problemStatement,
      solution
    );

    const summaryResult = await generateText({
      model: summaryModelProvider,
      prompt: summaryPrompt,
      abortSignal: this.options.abortSignal,
    });

    const finalSummary = summaryResult.text;

    this.emit({
      type: "failure",
      data: { reason: "Max iterations reached" },
    });

    return {
      mode: "deep-think",
      questions,
      userAnswers: this.options.userAnswers,
      plan,
      initialThought,
      improvements: [],
      iterations,
      verifications,
      finalSolution: solution,
      summary: finalSummary,
      totalIterations: maxIterations,
      successfulVerifications: correctCount,
      sources: this.sources.length > 0 ? this.sources : undefined,
      knowledgeEnhanced: this.sources.length > 0,
    };
  }
}

// Ultra Think - Parallel Multiple Agents
export interface UltraThinkOptions extends DeepThinkOptions {
  numAgents?: number; // Maximum number of agents (optional). If not set, use all agents suggested by LLM
  onAgentUpdate?: (agentId: string, update: Partial<AgentResult>) => void;
}

export class UltraThinkEngine {
  private options: UltraThinkOptions;
  private sources: Source[] = []; // 追踪所有搜索来源

  constructor(options: UltraThinkOptions) {
    this.options = {
      // Don't set default numAgents - let LLM decide
      // numAgents can be provided as a maximum limit if needed
      maxIterations: 30,
      requiredSuccessfulVerifications: 3,
      maxErrorsBeforeGiveUp: 10,
      enableWebSearch: false,
      ...options,
    };
  }

  private emit(event: DeepThinkProgressEvent) {
    if (this.options.onProgress) {
      this.options.onProgress(event);
    }
  }

  /** 中断检查点：在长循环的各阶段之间调用，避免取消后还跑完整轮 */
  private checkAborted() {
    throwIfAborted(this.options.abortSignal);
  }

  /**
   * 获取指定阶段应该使用的模型
   * 如果该阶段没有配置特定模型，则使用默认的 thinkingModel
   */
  private getModelForStage(stage: keyof ModelStageConfig): string {
    return this.options.modelStages?.[stage] || this.options.thinkingModel;
  }

  private async getSearchTools(): Promise<Tools | undefined> {
    if (!this.options.enableWebSearch) return undefined;

    const { thinkingModel } = this.options;
    const { provider = "model", maxResult = 5 } = this.options.searchProvider || {};

    // 外部搜索 provider（grok/tavily 等）：创建 web_search 工具，模型推理时按需调用
    if (provider !== "model" && this.options.searchFn) {
      const searchFn = this.options.searchFn;
      return {
        web_search: tool({
          description:
            "搜索互联网获取实时、真实的信息。当问题需要最新数据、外部事实或需要验证不确定的信息时主动调用。",
          parameters: z.object({
            query: z.string().describe("搜索查询词"),
          }),
          execute: async ({ query }) => {
            const { sources } = await searchFn(query);
            sources.forEach((s) => this.sources.push(s));
            if (sources.length === 0) return "未找到相关结果。";
            return sources
              .map(
                (s, i) =>
                  `[${i + 1}] ${s.title || s.url}\n${s.content || ""}`
              )
              .join("\n\n---\n\n");
          },
        }),
      };
    }

    // Enable OpenAI's built-in search tool
    if (
      provider === "model" &&
      thinkingModel.startsWith("gpt-4o")
    ) {
      const { openai } = await import("@ai-sdk/openai");
      return {
        web_search_preview: openai.tools.webSearchPreview({
          searchContextSize: maxResult > 5 ? "high" : "medium",
        }),
      };
    }

    return undefined;
  }

  private getProviderOptions(): ProviderOptions | undefined {
    if (!this.options.enableWebSearch) return undefined;

    const { thinkingModel } = this.options;
    const { provider = "model", maxResult = 5 } = this.options.searchProvider || {};

    // Enable OpenRouter's built-in search tool
    if (provider === "model" && thinkingModel.includes("openrouter")) {
      return {
        openrouter: {
          plugins: [
            {
              id: "web",
              max_results: maxResult ?? 5,
            },
          ],
        },
      };
    }

    return undefined;
  }

  private async generatePlan(problemStatement: string): Promise<string> {
    this.emit({
      type: "progress",
      data: { message: "Generating thinking plan..." },
    });

    // 使用计划阶段的模型
    const planningModel = this.getModelForStage("planning");
    const model = await this.options.createModelProvider(planningModel);

    const result = await generateText({
      model,
      prompt: ultraThinkPlanPrompt.replace("{query}", problemStatement),
      abortSignal: this.options.abortSignal,
    });

    return result.text;
  }

  private async generateAgentConfigs(
    plan: string
  ): Promise<Array<{ agentId: string; approach: string; specificPrompt: string }>> {
    this.emit({
      type: "progress",
      data: { message: "Generating agent configurations..." },
    });

    // 使用agent配置阶段的模型
    const agentConfigModel = this.getModelForStage("agentConfig");
    const model = await this.options.createModelProvider(agentConfigModel);

    // Use generateObject for structured output instead of manual JSON parsing
    const agentConfigSchema = z.object({
      configs: z.array(
        z.object({
          agentId: z.string(),
          approach: z.string(),
          specificPrompt: z.string(),
        })
      ),
    });

    try {
      const result = await generateObject({
        model,
        schema: agentConfigSchema,
        mode: "json", // Use JSON mode for broader model compatibility
        prompt: generateAgentPromptsPrompt.replace("{plan}", plan),
        abortSignal: this.options.abortSignal,
      });

      return result.object.configs;
    } catch (error) {
      // Fallback: if generateObject fails, use generateText with manual parsing
      console.warn("generateObject failed, falling back to manual JSON parsing:", error);
      
      const textResult = await generateText({
        model,
        prompt: generateAgentPromptsPrompt.replace("{plan}", plan),
        abortSignal: this.options.abortSignal,
      });

      // Try to parse the JSON, with better error handling
      let jsonText = textResult.text.trim();
      
      // Remove markdown code blocks
      if (jsonText.startsWith("```json")) {
        jsonText = jsonText.slice(7);
      } else if (jsonText.startsWith("```")) {
        jsonText = jsonText.slice(3);
      }
      if (jsonText.endsWith("```")) {
        jsonText = jsonText.slice(0, -3);
      }
      jsonText = jsonText.trim();

      try {
        const parsed = JSON.parse(jsonText);
        // Handle both array format and object with configs array
        return Array.isArray(parsed) ? parsed : parsed.configs || parsed;
      } catch (parseError) {
        throw new Error(
          `Failed to parse agent configurations. Original error: ${parseError instanceof Error ? parseError.message : String(parseError)}. ` +
          `Response text: ${jsonText.substring(0, 200)}...`
        );
      }
    }
  }

  private async runAgent(
    config: { agentId: string; approach: string; specificPrompt: string },
    problemStatement: string,
    onAgentProgress?: (agentId: string, update: Partial<AgentResult>) => void
  ): Promise<AgentResult> {
    const result: AgentResult = {
      agentId: config.agentId,
      approach: config.approach,
      specificPrompt: config.specificPrompt,
      status: "thinking",
      progress: 0,
    };

    // 通知 agent 开始
    if (onAgentProgress) {
      onAgentProgress(config.agentId, { status: "thinking", progress: 10 });
    }

    try {
      // Agent思考阶段可以使用专门的模型，或者继承各个阶段的配置
      const agentThinkingModel = this.getModelForStage("agentThinking");
      
      const engine = new DeepThinkEngine({
        ...this.options,
        // 如果设置了agentThinking模型，则覆盖thinkingModel
        thinkingModel: agentThinkingModel,
        problemStatement,
        otherPrompts: [config.specificPrompt],
        onProgress: (event) => {
          if (event.type === "thinking") {
            const progress = Math.min(20 + event.data.iteration * 2, 80);
            result.progress = progress;
            result.status = "thinking";
            if (onAgentProgress) {
              onAgentProgress(config.agentId, { progress, status: "thinking" });
            }
          } else if (event.type === "verification") {
            result.status = "verifying";
            if (onAgentProgress) {
              onAgentProgress(config.agentId, { status: "verifying" });
            }
          } else if (event.type === "success") {
            result.status = "completed";
            result.progress = 100;
            if (onAgentProgress) {
              onAgentProgress(config.agentId, { status: "completed", progress: 100 });
            }
          } else if (event.type === "failure") {
            result.status = "failed";
            result.error = event.data.reason;
            if (onAgentProgress) {
              onAgentProgress(config.agentId, {
                status: "failed",
                error: event.data.reason,
              });
            }
          }
        },
      });

      const deepThinkResult = await engine.run();
      result.solution = deepThinkResult.finalSolution;
      result.verifications = deepThinkResult.verifications;
      result.status = "completed";
      result.progress = 100;

      // 收集 agent 的搜索来源
      if (deepThinkResult.sources && deepThinkResult.sources.length > 0) {
        this.sources.push(...deepThinkResult.sources);
      }

      if (onAgentProgress) {
        onAgentProgress(config.agentId, {
          status: "completed",
          progress: 100,
          solution: deepThinkResult.finalSolution,
          verifications: deepThinkResult.verifications,
        });
      }
    } catch (err) {
      result.status = "failed";
      result.error = err instanceof Error ? err.message : "Unknown error";
      if (onAgentProgress) {
        onAgentProgress(config.agentId, {
          status: "failed",
          error: result.error,
        });
      }
    }

    return result;
  }

  async run(): Promise<UltraThinkResult> {
    const { problemStatement, onAgentUpdate } = this.options;
    const resume = this.options.resumeFrom;

    this.checkAborted();
    this.emit({ type: "init", data: { problem: problemStatement } });

    // 恢复已有来源，避免续跑后引用丢失
    if (resume?.sources?.length) {
      this.sources.push(...resume.sources);
    }

    let questions: string | undefined = resume?.questions;

    // Ask questions phase (optional) —— 已有则跳过
    if (this.options.enableAskQuestions && !questions) {
      this.emit({
        type: "progress",
        data: { message: "Generating clarification questions..." },
      });

      const model = await this.options.createModelProvider(this.options.thinkingModel);
      const prompt = buildAskQuestionsPrompt(problemStatement);

      const result = await generateText({
        model,
        prompt,
        abortSignal: this.options.abortSignal,
      });

      questions = result.text;
      this.emit({
        type: "asking",
        data: { questions },
      });
    }

    // Generate plan (with user answers if provided) —— 快照里有则复用
    const plan =
      resume?.plan ??
      (await this.generatePlan(
        this.options.userAnswers
          ? `${problemStatement}\n\n### User Provided Context ###\n${this.options.userAnswers}`
          : problemStatement
      ));

    // Generate agent configs —— 快照里有则复用，保证续跑时 agent 划分不变
    const configs =
      resume?.agentConfigs?.length
        ? resume.agentConfigs
        : await this.generateAgentConfigs(plan);

    // Use all agents suggested by LLM, unless numAgents is explicitly set as a limit
    const selectedConfigs = this.options.numAgents
      ? configs.slice(0, this.options.numAgents)
      : configs;

    const numAgents = selectedConfigs.length;

    this.emit({
      type: "snapshot",
      data: { questions, plan, agentConfigs: selectedConfigs },
    });

    // 已跑完的 agent 直接复用，不重跑
    const doneById = new Map<string, AgentResult>();
    for (const done of resume?.completedAgents ?? []) {
      if (done.status === "completed") doneById.set(done.agentId, done);
    }

    // Update agent configs in UI
    if (onAgentUpdate) {
      selectedConfigs.forEach((config) => {
        const done = doneById.get(config.agentId);
        onAgentUpdate(config.agentId, done ?? {
          approach: config.approach,
          specificPrompt: config.specificPrompt,
        });
      });
    }

    // Run agents in parallel
    this.checkAborted();
    const pending = selectedConfigs.filter((c) => !doneById.has(c.agentId));
    this.emit({
      type: "progress",
      data: {
        message: doneById.size > 0
          ? `复用 ${doneById.size} 个已完成 agent，重跑 ${pending.length} 个...`
          : `Running ${numAgents} agents in parallel...`,
      },
    });

    const agentResults = await Promise.all(
      selectedConfigs.map((config) => {
        const done = doneById.get(config.agentId);
        // 已完成的直接返回快照结果，不发起任何请求
        if (done) return Promise.resolve(done);
        return this.runAgent(config, problemStatement, onAgentUpdate);
      })
    );

    // 子 agent 内部会吞掉自身异常（记为 failed），所以取消后要在这里显式退出
    this.checkAborted();

    // 合成前上报快照 —— 若合成阶段失败，续跑时不必重跑所有 agent
    this.emit({
      type: "snapshot",
      data: {
        completedAgents: agentResults.filter((r) => r.status === "completed"),
        sources: this.sources.length > 0 ? [...this.sources] : undefined,
      },
    });

    // Synthesize results
    this.emit({
      type: "progress",
      data: { message: "Synthesizing results..." },
    });

    const agentResultsText = agentResults
      .map((result, idx) => {
        return `
### Agent ${idx + 1}: ${result.approach}

**Status:** ${result.status}
${result.error ? `**Error:** ${result.error}` : ""}

**Solution:**
${result.solution || "No solution generated"}
`;
      })
      .join("\n\n---\n\n");

    // 使用合成阶段的模型
    const synthesisModel = this.getModelForStage("synthesis");
    const model = await this.options.createModelProvider(synthesisModel);

    const synthesisResult = await generateText({
      model,
      prompt: synthesizeResultsPrompt
        .replace("{problem}", problemStatement)
        .replace("{agentResults}", agentResultsText),
      abortSignal: this.options.abortSignal,
    });

    const synthesis = synthesisResult.text;

    // Generate final summary for the user
    this.emit({
      type: "summarizing",
      data: { message: "Creating final summary for user..." },
    });

    const summaryModel = this.getModelForStage("summary");
    const summaryModelProvider = await this.options.createModelProvider(summaryModel);

    const summaryPrompt = buildFinalSummaryPrompt(
      problemStatement,
      synthesis
    );

    const summaryResultFinal = await generateText({
      model: summaryModelProvider,
      prompt: summaryPrompt,
      abortSignal: this.options.abortSignal,
    });

    const finalSummary = summaryResultFinal.text;

    this.emit({
      type: "success",
      data: { solution: finalSummary, iterations: 1 },
    });

    return {
      mode: "ultra-think",
      questions,
      userAnswers: this.options.userAnswers,
      plan,
      agentResults,
      synthesis,
      finalSolution: synthesis,
      summary: finalSummary,
      totalAgents: numAgents,
      completedAgents: agentResults.filter((r) => r.status === "completed")
        .length,
      sources: this.sources.length > 0 ? this.sources : undefined,
      knowledgeEnhanced: this.sources.length > 0,
    };
  }
}

export async function runDeepThink(
  options: DeepThinkOptions
): Promise<DeepThinkResult> {
  const engine = new DeepThinkEngine(options);
  return await engine.run();
}

export async function runUltraThink(
  options: UltraThinkOptions
): Promise<UltraThinkResult> {
  const engine = new UltraThinkEngine(options);
  return await engine.run();
}

