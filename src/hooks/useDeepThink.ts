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

  /** 兜底：引擎启动前先搜一波资料，注入 knowledgeContext */
  async function runPreSearchFallback(
    problemStatement: string,
    searchModel: string,
    userAnswers?: string,
  ): Promise<{ sources: Source[]; context: string }> {
    handleProgress({ type: "progress", data: { message: "Pre-search: 分析问题，搜索外部资料..." } });
    try {
      const modelProvider = await createModelProvider(searchModel);
      const result = await runPreSearchPhase(problemStatement, modelProvider, search, {
        userAnswers,
        maxRounds: 2,
        onProgress: (msg) => handleProgress({ type: "progress", data: { message: msg } }),
      });
      if (result.allSources.length > 0) {
        handleProgress({ type: "progress", data: { message: `Pre-search: 完成 — ${result.allSources.length} 条结果` } });
      }
      return { sources: result.allSources, context: result.formattedContext };
    } catch (err) {
      console.warn("Pre-search failed, continuing:", err);
      return { sources: [], context: "" };
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

      const enableWebSearch = enableSearch === "1" &&
        (searchProvider === "model" ? isNetworkingModel(model) : true);
      const useExternalSearch = enableWebSearch && searchProvider !== "model";
      const searchFn = useExternalSearch ? (q: string) => search(q) : undefined;

      const modelStages = enableModelStages === "enable" ? {
        initial: modelStageInitial || undefined,
        improvement: modelStageImprovement || undefined,
        verification: modelStageVerification || undefined,
        correction: modelStageCorrection || undefined,
        summary: modelStageSummary || undefined,
        search: modelStageSearch || undefined,
      } : undefined;

      // 兜底：引擎启动前搜索。结果注入 knowledgeContext，让 DT 模型在 prompt 里直接引用
      let preSearchSources: Source[] = [];
      if (useExternalSearch) {
        const pre = await runPreSearchFallback(
          problemStatement,
          modelStages?.search || model,
        );
        preSearchSources = pre.sources;
        if (pre.context) {
          knowledgeContext = knowledgeContext
            ? `${pre.context}\n\n${knowledgeContext}`
            : pre.context;
        }
      }

      const result = await runDeepThink({
        problemStatement,
        otherPrompts,
        knowledgeContext,
        enableWebSearch,
        searchProvider: enableWebSearch
          ? { provider: searchProvider, maxResult: searchMaxResult }
          : undefined,
        searchFn,
        enableAskQuestions: enableAskQuestions === "enable",
        enablePlanning: enablePlanning === "enable",
        createModelProvider,
        thinkingModel: model,
        modelStages,
        onProgress: handleProgress,
      });

      if (result && preSearchSources.length > 0) {
        result.sources = mergeSources(preSearchSources, result.sources);
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
    numAgents?: number,
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

      const enableWebSearch = enableSearch === "1" &&
        (searchProvider === "model" ? isNetworkingModel(model) : true);
      const useExternalSearch = enableWebSearch && searchProvider !== "model";
      const searchFn = useExternalSearch ? (q: string) => search(q) : undefined;

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
        setAgentResults([]);
      }

      let preSearchSources: Source[] = [];
      if (useExternalSearch) {
        const pre = await runPreSearchFallback(
          problemStatement,
          modelStages?.search || model,
        );
        preSearchSources = pre.sources;
        if (pre.context) {
          knowledgeContext = knowledgeContext
            ? `${pre.context}\n\n${knowledgeContext}`
            : pre.context;
        }
      }

      const result = await runUltraThink({
        problemStatement,
        otherPrompts,
        knowledgeContext,
        enableWebSearch,
        searchProvider: enableWebSearch
          ? { provider: searchProvider, maxResult: searchMaxResult }
          : undefined,
        searchFn,
        enableAskQuestions: enableAskQuestions === "enable",
        enablePlanning: enablePlanning === "enable",
        numAgents,
        createModelProvider,
        thinkingModel: model,
        modelStages,
        onProgress: handleProgress,
        onAgentUpdate: (agentId: string, update: Partial<AgentResult>) => {
          updateAgentResult(agentId, update);
        },
      });

      if (result && preSearchSources.length > 0) {
        result.sources = mergeSources(preSearchSources, result.sources);
        result.knowledgeEnhanced = true;
      }
      return result;
    } catch (err) {
      handleError(err);
      return null;
    }
  }

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

      const enableWebSearch = enableSearch === "1" &&
        (searchProvider === "model" ? isNetworkingModel(model) : true);
      const useExternalSearch = enableWebSearch && searchProvider !== "model";
      const searchFn = useExternalSearch ? (q: string) => search(q) : undefined;

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
        enableWebSearch,
        searchProvider: enableWebSearch
          ? { provider: searchProvider, maxResult: searchMaxResult }
          : undefined,
        searchFn,
        enableAskQuestions: true,
        enableInteractiveMode: true,
        enablePlanning: enablePlanning === "enable",
        createModelProvider,
        thinkingModel: model,
        modelStages,
        onProgress: handleProgress,
      };

      setInteractiveState(prev => ({ ...prev, originalOptions: options }));

      const engine = new DeepThinkEngine(options);
      const questions = await engine.askQuestions(problemStatement, true);
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
      setInteractiveState(prev => ({
        ...prev,
        isWaitingForAnswers: false,
        questions: undefined,
      }));

      let knowledgeContext = interactiveState.originalOptions.knowledgeContext;
      const searchFn = interactiveState.originalOptions.searchFn;
      const problem = interactiveState.originalOptions.problemStatement;

      let preSearchSources: Source[] = [];
      if (searchFn) {
        const searchModel =
          interactiveState.originalOptions.modelStages?.search ||
          interactiveState.originalOptions.thinkingModel;
        const pre = await runPreSearchFallback(problem, searchModel, userAnswers);
        preSearchSources = pre.sources;
        if (pre.context) {
          knowledgeContext = knowledgeContext
            ? `${pre.context}\n\n${knowledgeContext}`
            : pre.context;
        }
      }

      const optionsWithAnswers: DeepThinkOptions = {
        ...interactiveState.originalOptions,
        knowledgeContext,
        searchFn,
        userAnswers,
        enableInteractiveMode: false,
        onProgress: handleProgress,
      };

      const result = await runDeepThink(optionsWithAnswers);

      if (result && preSearchSources.length > 0) {
        result.sources = mergeSources(preSearchSources, result.sources);
        result.knowledgeEnhanced = true;
      }

      setInteractiveState({ isWaitingForAnswers: false });
      return result;
    } catch (err) {
      handleError(err);
      return null;
    }
  }

  function resetInteractiveState() {
    setInteractiveState({ isWaitingForAnswers: false });
  }

  return {
    status,
    runDeepThinkMode,
    runUltraThinkMode,
    interactiveState,
    startInteractiveDeepThink,
    continueWithAnswers,
    resetInteractiveState,
  };
}

/** 去重合并 sources */
function mergeSources(a: Source[], b?: Source[]): Source[] {
  const seen = new Set<string>();
  const merged: Source[] = [];
  for (const s of [...a, ...(b || [])]) {
    if (!seen.has(s.url)) {
      seen.add(s.url);
      merged.push(s);
    }
  }
  return merged;
}

export default useDeepThinkEngine;
