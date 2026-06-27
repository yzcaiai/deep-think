import {
  generateText,
  generateObject,
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
} from "./prompts";

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
  /** 是否启用询问阶段 - 在开始前提出澄清问题 */
  enableAskQuestions?: boolean;
  /** 用户对询问的回答（如果有的话） */
  userAnswers?: string;
  /** 是否启用计划阶段 - 在开始前制定思考计划 */
  enablePlanning?: boolean;
  /** 是否启用交互模式 - 在问问题阶段等待用户回答 */
  enableInteractiveMode?: boolean;
  onProgress?: (event: DeepThinkProgressEvent) => void;
  createModelProvider: (model: string, options?: any) => Promise<any>;
  thinkingModel: string;
  taskModel?: string;
  /** 分阶段模型配置，未指定的阶段使用 thinkingModel */
  modelStages?: ModelStageConfig;
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
  | { type: "progress"; data: { message: string } };

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

  private extractDetailedSolution(
    solution: string,
    marker: string = extractDetailedSolutionMarker,
    after: boolean = true
  ): string {
    const idx = solution.indexOf(marker);
    if (idx === -1) {
      return after ? "" : solution;
    }
    if (after) {
      return solution.substring(idx + marker.length).trim();
    } else {
      return solution.substring(0, idx).trim();
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
    const detailedSolution = this.extractDetailedSolution(solution);
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
    });

    const verificationOutput = verificationResult.text;

    // Check if verification is good
    const checkPrompt = `Response in "yes" or "no". Is the following statement saying the solution is correct, or does not contain critical error or a major justification gap?\n\n${verificationOutput}`;

    const checkResult = await generateText({
      model,
      prompt: checkPrompt,
    });

    const goodVerify = checkResult.text;
    let bugReport = "";

    if (!goodVerify.toLowerCase().includes("yes")) {
      bugReport = this.extractDetailedSolution(
        verificationOutput,
        "Detailed Review",
        false
      );
    }

    return { bugReport, goodVerify };
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

    this.emit({ type: "init", data: { problem: problemStatement } });

    let questions: string | undefined;
    let plan: string | undefined;

    // Ask questions phase (optional)
    if (this.options.enableAskQuestions) {
      questions = await this.askQuestions(problemStatement, this.options.enableInteractiveMode);
      // Note: In interactive mode, the process may pause here for user input
      // The actual continuation will be handled by the calling code
    }

    // Planning phase (optional)
    if (this.options.enablePlanning) {
      plan = await this.generateThinkingPlan(
        problemStatement,
        this.options.userAnswers
      );
      // Add plan to otherPrompts for context
      if (plan) {
        otherPrompts.push(`\n### Thinking Plan ###\n${plan}\n`);
      }
    }

    // Initial exploration
    const initial = await this.initialExploration(problemStatement, otherPrompts);
    if (!initial) {
      throw new Error("Failed in initial exploration");
    }

    let solution = initial.solution;
    let verification = initial.verification;

    const iterations: DeepThinkIteration[] = [];
    const verifications: Verification[] = [];

    let errorCount = 0;
    let correctCount = verification.goodVerify.toLowerCase().includes("yes")
      ? 1
      : 0;

    // Main loop
    for (let i = 0; i < maxIterations; i++) {
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
          initialThought: initial.solution,
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
      initialThought: initial.solution,
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
      });

      return result.object.configs;
    } catch (error) {
      // Fallback: if generateObject fails, use generateText with manual parsing
      console.warn("generateObject failed, falling back to manual JSON parsing:", error);
      
      const textResult = await generateText({
        model,
        prompt: generateAgentPromptsPrompt.replace("{plan}", plan),
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

    this.emit({ type: "init", data: { problem: problemStatement } });

    let questions: string | undefined;

    // Ask questions phase (optional)
    if (this.options.enableAskQuestions) {
      this.emit({
        type: "progress",
        data: { message: "Generating clarification questions..." },
      });

      const model = await this.options.createModelProvider(this.options.thinkingModel);
      const prompt = buildAskQuestionsPrompt(problemStatement);

      const result = await generateText({
        model,
        prompt,
      });

      questions = result.text;
      this.emit({
        type: "asking",
        data: { questions },
      });
    }

    // Generate plan (with user answers if provided)
    const plan = await this.generatePlan(
      this.options.userAnswers
        ? `${problemStatement}\n\n### User Provided Context ###\n${this.options.userAnswers}`
        : problemStatement
    );

    // Generate agent configs
    const configs = await this.generateAgentConfigs(plan);
    
    // Use all agents suggested by LLM, unless numAgents is explicitly set as a limit
    const selectedConfigs = this.options.numAgents 
      ? configs.slice(0, this.options.numAgents)
      : configs;
    
    const numAgents = selectedConfigs.length;

    // Update agent configs in UI
    if (onAgentUpdate) {
      selectedConfigs.forEach((config) => {
        onAgentUpdate(config.agentId, {
          approach: config.approach,
          specificPrompt: config.specificPrompt,
        });
      });
    }

    // Run agents in parallel
    this.emit({
      type: "progress",
      data: { message: `Running ${numAgents} agents in parallel...` },
    });

    const agentResults = await Promise.all(
      selectedConfigs.map((config) =>
        this.runAgent(config, problemStatement, onAgentUpdate)
      )
    );

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

