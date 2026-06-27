import { useState } from "react";
import { useTranslation } from "react-i18next";
import { toast } from "sonner";
import useModelProvider from "@/hooks/useAiProvider";
import useWebSearch from "@/hooks/useWebSearch";
import { useGlobalStore } from "@/store/global";
import { useSettingStore } from "@/store/setting";
import {
  runDeepThink,
  runUltraThink,
  DeepThinkEngine,
  type DeepThinkProgressEvent,
  type DeepThinkOptions,
} from "@/utils/deep-think";
import { runPreSearchPhase } from "@/utils/deep-think/preSearch";
import { parseError } from "@/utils/error";
import { isNetworkingModel } from "@/utils/model";

// 交互式Deep Think的状态接口
interface InteractiveDeepThinkState {
  isWaitingForAnswers: boolean;
  questions?: string;
  engine?: DeepThinkEngine;
  originalOptions?: DeepThinkOptions;
}

function useDeepThinkEngine() {
  const { t } = useTranslation();
  const { createModelProvider, getModel } = useModelProvider();
  const { search } = useWebSearch();
  const [status, setStatus] = useState<string>("");
  const [interactiveState, setInteractiveState] = useState<InteractiveDeepThinkState>({
    isWaitingForAnswers: false,
  });

  function handleError(error: unknown) {
    console.error(error);
    const errorMessage = parseError(error);
    toast.error(errorMessage);
  }

  function handleProgress(event: DeepThinkProgressEvent) {
    const {
      setCurrentIteration,
      setCurrentPhase,
      setCurrentSolution,
    } = useGlobalStore.getState();

    switch (event.type) {
      case "init":
        setStatus(t("deepThink.status.initializing"));
        setCurrentIteration(0);
        setCurrentPhase("initializing");
        break;
      case "asking":
        setCurrentPhase("asking");
        setStatus(t("deepThink.status.asking"));
        break;
      case "waiting_for_answers":
        setCurrentPhase("waiting_for_answers");
        setStatus(t("deepThink.status.waitingForAnswers"));
        setInteractiveState(prev => ({
          ...prev,
          isWaitingForAnswers: true,
          questions: event.data.questions,
        }));
        break;
      case "planning":
        setCurrentPhase("planning");
        setStatus(t("deepThink.status.planning"));
        break;
      case "thinking":
        setCurrentIteration(event.data.iteration);
        setCurrentPhase(event.data.phase);
        setStatus(
          t("deepThink.status.thinking", {
            iteration: event.data.iteration,
            phase: event.data.phase,
          })
        );
        break;
      case "solution":
        setCurrentSolution(event.data.solution);
        setStatus(
          t("deepThink.status.generatedSolution", {
            iteration: event.data.iteration,
          })
        );
        break;
      case "verification":
        setStatus(
          t("deepThink.status.verification", {
            result: event.data.passed ? t("deepThink.verification.passed") : t("deepThink.verification.failed"),
          })
        );
        break;
      case "correction":
        setCurrentIteration(event.data.iteration);
        setCurrentPhase("correcting");
        setStatus(
          t("deepThink.status.correcting", {
            iteration: event.data.iteration,
          })
        );
        break;
      case "summarizing":
        setCurrentPhase("summarizing");
        setStatus(t("deepThink.status.summarizing"));
        break;
      case "success":
        setStatus(t("deepThink.status.success"));
        toast.success(t("deepThink.status.success"));
        break;
      case "failure":
        setStatus(t("deepThink.status.failure"));
        toast.error(t("deepThink.status.failure"));
        break;
      case "progress":
        setStatus(event.data.message);
        break;
    }
  }

  async function runDeepThinkMode(
    problemStatement: string,
    otherPrompts: string[] = [],
    knowledgeContext?: string
  ): Promise<DeepThinkResult | null> {
    try {
      const { model } = getModel();
      const {
        enableSearch,
        searchProvider,
        searchMaxResult,
        enableModelStages,
        modelStageInitial,
        modelStageImprovement,
        modelStageVerification,
        modelStageCorrection,
        modelStageSummary,
        modelStageSearch,
        enableAskQuestions,
        enablePlanning,
      } = useSettingStore.getState();

      // 检查是否启用联网：模型内置搜索要求模型本身支持联网；外部 provider（grok/tavily…）无此限制
      const enableWebSearch =
        enableSearch &&
        (searchProvider === "model" ? isNetworkingModel(model) : true);

      // 构建分阶段模型配置
      const modelStages = enableModelStages === "enable" ? {
        initial: modelStageInitial || undefined,
        improvement: modelStageImprovement || undefined,
        verification: modelStageVerification || undefined,
        correction: modelStageCorrection || undefined,
        summary: modelStageSummary || undefined,
        search: modelStageSearch || undefined,
      } : undefined;

      // === Pre-search 阶段：外部搜索 provider（grok 等）在 DT 运行前主动搜资料 ===
      // 不依赖 DT 引擎内部的 tool-calling——纯推理模型也能拿到真实资料
      let preSearchSources: Source[] = [];
      let preSearchContext: string | undefined;

      if (enableWebSearch && searchProvider !== "model") {
        handleProgress({
          type: "progress",
          data: { message: "Pre-search: 分析问题，生成搜索计划..." },
        });

        try {
          const searchModel = modelStages?.search || model;
          const modelProvider = await createModelProvider(searchModel);
          const preSearchResult = await runPreSearchPhase(
            problemStatement,
            modelProvider,
            (q: string) => search(q),
            {
              maxRounds: 3,
              onProgress: (msg) => {
                handleProgress({ type: "progress", data: { message: msg } });
              },
            }
          );

          preSearchSources = preSearchResult.allSources;
          preSearchContext = preSearchResult.formattedContext;

          if (preSearchContext) {
            knowledgeContext = knowledgeContext
              ? `${knowledgeContext}\n\n${preSearchContext}`
              : preSearchContext;
          }
        } catch (err) {
          console.warn("Pre-search phase failed, continuing without search results:", err);
        }
      }

      const result = await runDeepThink({
        problemStatement,
        otherPrompts,
        knowledgeContext,
        enableWebSearch: enableWebSearch || undefined,
        searchProvider: enableWebSearch
          ? { provider: searchProvider, maxResult: searchMaxResult }
          : undefined,
        enableAskQuestions: enableAskQuestions === "enable",
        enablePlanning: enablePlanning === "enable",
        createModelProvider,
        thinkingModel: model,
        modelStages,
        onProgress: handleProgress,
      });

      // 合并 pre-search 来源到最终结果
      if (result && preSearchSources.length > 0) {
        result.sources = [
          ...preSearchSources,
          ...(result.sources || []),
        ];
        result.knowledgeEnhanced = true;
      }

      return result;
    } catch (err) {
      handleError(err);
      return null;
    }
  }

  async function runUltraThinkMode(
    problemStatement: string,
    numAgents?: number, // Optional: if not set, LLM decides
    otherPrompts: string[] = [],
    knowledgeContext?: string
  ): Promise<UltraThinkResult | null> {
    try {
      const { model } = getModel();
      const { setAgentResults, updateAgentResult } = useGlobalStore.getState();
      const {
        enableSearch,
        searchProvider,
        searchMaxResult,
        enableModelStages,
        modelStageInitial,
        modelStageImprovement,
        modelStageVerification,
        modelStageCorrection,
        modelStageSummary,
        modelStagePlanning,
        modelStageAgentConfig,
        modelStageAgentThinking,
        modelStageSynthesis,
        modelStageSearch,
        enableAskQuestions,
        enablePlanning,
      } = useSettingStore.getState();

      // 检查是否启用联网：模型内置搜索要求模型本身支持联网；外部 provider（grok/tavily…）无此限制
      const enableWebSearch =
        enableSearch &&
        (searchProvider === "model" ? isNetworkingModel(model) : true);

      // 构建分阶段模型配置
      const modelStages = enableModelStages === "enable" ? {
        initial: modelStageInitial || undefined,
        improvement: modelStageImprovement || undefined,
        verification: modelStageVerification || undefined,
        correction: modelStageCorrection || undefined,
        summary: modelStageSummary || undefined,
        planning: modelStagePlanning || undefined,
        agentConfig: modelStageAgentConfig || undefined,
        agentThinking: modelStageAgentThinking || undefined,
        synthesis: modelStageSynthesis || undefined,
        search: modelStageSearch || undefined,
      } : undefined;

      // 初始化 agents - 如果指定了 numAgents，预先创建占位符
      if (numAgents) {
        const initialAgents: AgentResult[] = Array.from(
          { length: numAgents },
          (_, i) => ({
            agentId: `agent_${String(i + 1).padStart(2, "0")}`,
            approach: "准备中...",
            specificPrompt: "",
            status: "pending",
            progress: 0,
          })
        );
        setAgentResults(initialAgents);
      } else {
        // 如果没指定，清空之前的结果，等 LLM 决定
        setAgentResults([]);
      }

      // === Pre-search 阶段：外部搜索 provider 在 DT 运行前主动搜资料 ===
      let preSearchSources: Source[] = [];
      let preSearchContext: string | undefined;

      if (enableWebSearch && searchProvider !== "model") {
        handleProgress({
          type: "progress",
          data: { message: "Pre-search: 分析问题，生成搜索计划..." },
        });

        try {
          const searchModel = modelStages?.search || model;
          const modelProvider = await createModelProvider(searchModel);
          const preSearchResult = await runPreSearchPhase(
            problemStatement,
            modelProvider,
            (q: string) => search(q),
            {
              maxRounds: 3,
              onProgress: (msg) => {
                handleProgress({ type: "progress", data: { message: msg } });
              },
            }
          );

          preSearchSources = preSearchResult.allSources;
          preSearchContext = preSearchResult.formattedContext;

          if (preSearchContext) {
            knowledgeContext = knowledgeContext
              ? `${knowledgeContext}\n\n${preSearchContext}`
              : preSearchContext;
          }
        } catch (err) {
          console.warn("Pre-search phase failed, continuing without search results:", err);
        }
      }

      const result = await runUltraThink({
        problemStatement,
        otherPrompts,
        knowledgeContext,
        enableWebSearch: enableWebSearch || undefined,
        searchProvider: enableWebSearch
          ? { provider: searchProvider, maxResult: searchMaxResult }
          : undefined,
        enableAskQuestions: enableAskQuestions === "enable",
        enablePlanning: enablePlanning === "enable",
        numAgents, // Can be undefined - LLM will decide
        createModelProvider,
        thinkingModel: model,
        modelStages,
        onProgress: handleProgress,
        onAgentUpdate: (agentId: string, update: Partial<AgentResult>) => {
          updateAgentResult(agentId, update);
        },
      });

      // 合并 pre-search 来源到最终结果
      if (result && preSearchSources.length > 0) {
        result.sources = [
          ...preSearchSources,
          ...(result.sources || []),
        ];
        result.knowledgeEnhanced = true;
      }

      return result;
    } catch (err) {
      handleError(err);
      return null;
    }
  }

  // 交互式Deep Think方法
  async function startInteractiveDeepThink(
    problemStatement: string,
    otherPrompts: string[] = [],
    knowledgeContext?: string
  ): Promise<{ questions?: string } | null> {
    try {
      const { model } = getModel();
      const {
        enableSearch,
        searchProvider,
        searchMaxResult,
        enableModelStages,
        modelStageInitial,
        modelStageImprovement,
        modelStageVerification,
        modelStageCorrection,
        modelStageSummary,
        modelStageSearch,
        enablePlanning,
      } = useSettingStore.getState();

      // 检查是否启用联网：模型内置搜索要求模型本身支持联网；外部 provider（grok/tavily…）无此限制
      const enableWebSearch =
        enableSearch &&
        (searchProvider === "model" ? isNetworkingModel(model) : true);

      // 构建分阶段模型配置
      const modelStages = enableModelStages === "enable" ? {
        initial: modelStageInitial || undefined,
        improvement: modelStageImprovement || undefined,
        verification: modelStageVerification || undefined,
        correction: modelStageCorrection || undefined,
        summary: modelStageSummary || undefined,
        search: modelStageSearch || undefined,
      } : undefined;

      const options: DeepThinkOptions = {
        problemStatement,
        otherPrompts,
        knowledgeContext,
        enableWebSearch: enableWebSearch || undefined,
        searchProvider: enableWebSearch
          ? { provider: searchProvider, maxResult: searchMaxResult }
          : undefined,
        enableAskQuestions: true, // 启用问问题功能
        enableInteractiveMode: true, // 启用交互模式
        enablePlanning: enablePlanning === "enable",
        createModelProvider,
        thinkingModel: model,
        modelStages,
        onProgress: handleProgress,
      };

      // 保存选项供后续使用
      setInteractiveState(prev => ({ ...prev, originalOptions: options }));

      // 创建引擎实例但不运行完整流程，只生成问题
      const engine = new DeepThinkEngine(options);
      
      // 手动调用问问题流程
      const questions = await engine.askQuestions(problemStatement, true);
      
      // 保存引擎实例
      setInteractiveState(prev => ({ ...prev, engine }));

      return { questions };
    } catch (err) {
      handleError(err);
      return null;
    }
  }

  async function continueWithAnswers(userAnswers: string): Promise<any> {
    if (!interactiveState.engine || !interactiveState.originalOptions) {
      throw new Error("没有找到待继续的Deep Think会话");
    }

    try {
      // 重置交互状态
      setInteractiveState(prev => ({
        ...prev,
        isWaitingForAnswers: false,
        questions: undefined,
      }));

      // 创建包含用户答案的新选项
      const optionsWithAnswers: DeepThinkOptions = {
        ...interactiveState.originalOptions,
        userAnswers,
        enableInteractiveMode: false, // 关闭交互模式，直接运行完整流程
        onProgress: handleProgress, // 确保使用正确的进度处理器
      };

      // === Pre-search 阶段：用户回答后、DT 运行前搜索 ===
      let preSearchSources: Source[] = [];

      if (
        optionsWithAnswers.enableWebSearch &&
        optionsWithAnswers.searchProvider?.provider !== "model"
      ) {
        handleProgress({
          type: "progress",
          data: { message: "Pre-search: 分析问题，生成搜索计划..." },
        });

        try {
          const searchModel =
            optionsWithAnswers.modelStages?.search ||
            optionsWithAnswers.thinkingModel;
          const modelProvider = await createModelProvider(searchModel);
          const preSearchResult = await runPreSearchPhase(
            optionsWithAnswers.problemStatement,
            modelProvider,
            (q: string) => search(q),
            {
              userAnswers,
              maxRounds: 3,
              onProgress: (msg) => {
                handleProgress({ type: "progress", data: { message: msg } });
              },
            }
          );

          preSearchSources = preSearchResult.allSources;
          const searchContext = preSearchResult.formattedContext;

          if (searchContext) {
            optionsWithAnswers.knowledgeContext = optionsWithAnswers.knowledgeContext
              ? `${optionsWithAnswers.knowledgeContext}\n\n${searchContext}`
              : searchContext;
          }
        } catch (err) {
          console.warn("Pre-search phase failed, continuing without search results:", err);
        }
      }

      // 运行完整的Deep Think流程
      const result = await runDeepThink(optionsWithAnswers);

      // 合并 pre-search 来源到最终结果
      if (result && preSearchSources.length > 0) {
        result.sources = [
          ...preSearchSources,
          ...(result.sources || []),
        ];
        result.knowledgeEnhanced = true;
      }

      // 清理交互状态
      setInteractiveState({
        isWaitingForAnswers: false,
      });

      return result;
    } catch (err) {
      handleError(err);
      return null;
    }
  }

  function resetInteractiveState() {
    setInteractiveState({
      isWaitingForAnswers: false,
    });
  }

  return {
    status,
    runDeepThinkMode,
    runUltraThinkMode,
    // 交互式Deep Think相关
    interactiveState,
    startInteractiveDeepThink,
    continueWithAnswers,
    resetInteractiveState,
  };
}

export default useDeepThinkEngine;

