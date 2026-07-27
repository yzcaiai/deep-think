import { useTranslation } from "react-i18next";
import { toast } from "sonner";
import useModelProvider from "@/hooks/useAiProvider";
import useWebSearch from "@/hooks/useWebSearch";
import { useSettingStore } from "@/store/setting";
import { useThinkTaskStore, type CreateTaskInput } from "@/store/thinkTask";
import { useHistoryStore } from "@/store/history";
import {
  runDeepThink,
  runUltraThink,
  DeepThinkEngine,
  type DeepThinkProgressEvent,
  type DeepThinkOptions,
} from "@/utils/deep-think";
import { runPreSearchPhase } from "@/utils/deep-think/preSearch";
import {
  schedule,
  cancel,
  isAbortError,
  beginRun,
  isCurrentGeneration,
  invalidateRun,
  clearRun,
} from "@/utils/deep-think/registry";
import { parseError } from "@/utils/error";
import { isNetworkingModel } from "@/utils/model";

/**
 * 交互式 Deep Think 的活对象（引擎实例 + 原始 options）。
 * 不可序列化，因此按 taskId 存模块级 Map，不进 zustand store。
 */
const interactiveSessions = new Map<
  string,
  { engine: DeepThinkEngine; options: DeepThinkOptions }
>();

function useDeepThinkEngine() {
  const { t } = useTranslation();
  const { createModelProvider, getModel } = useModelProvider();
  const { search } = useWebSearch();

  /** 只在该任务正被展示时才打扰用户 */
  function isActiveTask(taskId: string): boolean {
    return useThinkTaskStore.getState().activeTaskId === taskId;
  }

  function handleError(taskId: string, error: unknown): string {
    console.error(error);
    const errorMessage = parseError(error);
    if (isActiveTask(taskId)) toast.error(errorMessage);
    return errorMessage;
  }

  function handleProgress(taskId: string, event: DeepThinkProgressEvent) {
    const { update } = useThinkTaskStore.getState();

    switch (event.type) {
      case "init": {
        // 续跑时不要把 iteration 清零，否则 UI 会闪一下「第 0 轮」
        const existing = useThinkTaskStore.getState().get(taskId);
        update(taskId, {
          statusText: t("deepThink.status.initializing"),
          currentIteration: existing?.snapshot?.completedIterations ?? 0,
          currentPhase: "initializing",
        });
        break;
      }
      case "asking":
        update(taskId, {
          currentPhase: "asking",
          statusText: t("deepThink.status.asking"),
        });
        break;
      case "waiting_for_answers":
        update(taskId, {
          status: "waiting",
          currentPhase: "waiting_for_answers",
          statusText: t("deepThink.status.waitingForAnswers"),
          isWaitingForAnswers: true,
          questions: event.data.questions,
        });
        break;
      case "planning":
        update(taskId, {
          currentPhase: "planning",
          statusText: t("deepThink.status.planning"),
        });
        break;
      case "thinking":
        update(taskId, {
          currentIteration: event.data.iteration,
          currentPhase: event.data.phase,
          statusText: t("deepThink.status.thinking", {
            iteration: event.data.iteration,
            phase: event.data.phase,
          }),
        });
        break;
      case "solution":
        update(taskId, {
          currentSolution: event.data.solution,
          statusText: t("deepThink.status.generatedSolution", {
            iteration: event.data.iteration,
          }),
        });
        break;
      case "verification":
        update(taskId, {
          statusText: t("deepThink.status.verification", {
            result: event.data.passed
              ? t("deepThink.verification.passed")
              : t("deepThink.verification.failed"),
          }),
        });
        break;
      case "correction":
        update(taskId, {
          currentIteration: event.data.iteration,
          currentPhase: "correcting",
          statusText: t("deepThink.status.correcting", {
            iteration: event.data.iteration,
          }),
        });
        break;
      case "summarizing":
        update(taskId, {
          currentPhase: "summarizing",
          statusText: t("deepThink.status.summarizing"),
        });
        break;
      case "success":
        update(taskId, { statusText: t("deepThink.status.success") });
        if (isActiveTask(taskId)) toast.success(t("deepThink.status.success"));
        break;
      case "failure":
        update(taskId, { statusText: t("deepThink.status.failure") });
        if (isActiveTask(taskId)) toast.error(t("deepThink.status.failure"));
        break;
      case "progress":
        update(taskId, { statusText: event.data.message });
        break;
      case "snapshot": {
        // 增量合并 —— 引擎分阶段上报，各次只带自己那部分字段
        const prev = useThinkTaskStore.getState().get(taskId)?.snapshot ?? {};
        update(taskId, { snapshot: { ...prev, ...event.data } });
        break;
      }
    }
  }

  /** 兜底：引擎启动前先搜一波资料，注入 knowledgeContext */
  async function runPreSearchFallback(
    taskId: string,
    problemStatement: string,
    searchModel: string,
    userAnswers?: string,
    abortSignal?: AbortSignal
  ): Promise<{ sources: Source[]; context: string }> {
    handleProgress(taskId, {
      type: "progress",
      data: { message: "Pre-search: 分析问题，搜索外部资料..." },
    });
    try {
      const modelProvider = await createModelProvider(searchModel);
      const result = await runPreSearchPhase(problemStatement, modelProvider, search, {
        userAnswers,
        maxRounds: 2,
        abortSignal,
        onProgress: (msg) =>
          handleProgress(taskId, { type: "progress", data: { message: msg } }),
      });
      if (result.allSources.length > 0) {
        handleProgress(taskId, {
          type: "progress",
          data: { message: `Pre-search: 完成 — ${result.allSources.length} 条结果` },
        });
      }
      return { sources: result.allSources, context: result.formattedContext };
    } catch (err) {
      if (isAbortError(err)) throw err;
      console.warn("Pre-search failed, continuing:", err);
      return { sources: [], context: "" };
    }
  }

  async function runDeepThinkMode(
    taskId: string,
    problemStatement: string,
    otherPrompts: string[] = [],
    knowledgeContext?: string,
    abortSignal?: AbortSignal,
    resumeFrom?: ThinkTaskSnapshot,
    generation?: number
  ): Promise<DeepThinkResult> {
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
    // 续跑时跳过 —— 上次搜到的资料已在快照的 sources 里
    let preSearchSources: Source[] = resumeFrom?.sources ?? [];
    if (useExternalSearch && !resumeFrom) {
      const pre = await runPreSearchFallback(
        taskId,
        problemStatement,
        modelStages?.search || model,
        undefined,
        abortSignal
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
      abortSignal,
      resumeFrom,
      // 续跑交互式任务时带回用户当初的回答，避免重新提问
      userAnswers: resumeFrom?.userAnswers,
      onProgress: (event) => {
        if (generation !== undefined && !isCurrentGeneration(taskId, generation)) return;
        handleProgress(taskId, event);
      },
    });

    if (result && preSearchSources.length > 0) {
      result.sources = mergeSources(preSearchSources, result.sources);
      result.knowledgeEnhanced = true;
    }
    return result;
  }

  async function runUltraThinkMode(
    taskId: string,
    problemStatement: string,
    numAgents?: number,
    otherPrompts: string[] = [],
    knowledgeContext?: string,
    abortSignal?: AbortSignal,
    resumeFrom?: ThinkTaskSnapshot,
    generation?: number
  ): Promise<UltraThinkResult> {
    const { model } = getModel();
    const { update, updateAgentResult } = useThinkTaskStore.getState();
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
      update(taskId, { agentResults: initialAgents });
    } else {
      update(taskId, { agentResults: [] });
    }

    // 续跑时跳过 —— 上次搜到的资料已在快照的 sources 里
    let preSearchSources: Source[] = resumeFrom?.sources ?? [];
    if (useExternalSearch && !resumeFrom) {
      const pre = await runPreSearchFallback(
        taskId,
        problemStatement,
        modelStages?.search || model,
        undefined,
        abortSignal
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
      abortSignal,
      resumeFrom,
      userAnswers: resumeFrom?.userAnswers,
      onProgress: (event) => {
        if (generation !== undefined && !isCurrentGeneration(taskId, generation)) return;
        handleProgress(taskId, event);
      },
      onAgentUpdate: (agentId: string, agentUpdate: Partial<AgentResult>) => {
        if (generation !== undefined && !isCurrentGeneration(taskId, generation)) return;
        updateAgentResult(taskId, agentId, agentUpdate);
      },
    });

    if (result && preSearchSources.length > 0) {
      result.sources = mergeSources(preSearchSources, result.sources);
      result.knowledgeEnhanced = true;
    }
    return result;
  }

  /**
   * 交互式 Deep Think 第一步：只生成澄清问题，然后停下等用户回答。
   * 引擎实例存入 interactiveSessions，由 continueWithAnswers 接手。
   */
  async function startInteractiveDeepThink(
    taskId: string,
    problemStatement: string,
    otherPrompts: string[] = [],
    knowledgeContext?: string,
    abortSignal?: AbortSignal,
    generation?: number
  ): Promise<{ questions?: string }> {
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
      abortSignal,
      onProgress: (event) => {
        if (generation !== undefined && !isCurrentGeneration(taskId, generation)) return;
        handleProgress(taskId, event);
      },
    };

    const engine = new DeepThinkEngine(options);
    const questions = await engine.askQuestions(problemStatement, true);
    if (generation !== undefined && !isCurrentGeneration(taskId, generation)) {
      return { questions };
    }
    interactiveSessions.set(taskId, { engine, options });

    return { questions };
  }

  /**
   * 交互式 Deep Think 第二步：拿到用户回答后跑完整流程。
   * 重新排队 —— 用户可能隔很久才回答，此时并发槽位应重新竞争。
   */
  function continueWithAnswers(taskId: string, userAnswers: string) {
    const session = interactiveSessions.get(taskId);
    if (!session) {
      toast.error("没有找到待继续的 Deep Think 会话");
      return;
    }

    const { get, update } = useThinkTaskStore.getState();
    const prevSnapshot = get(taskId)?.snapshot ?? {};
    update(taskId, {
      status: "queued",
      isWaitingForAnswers: false,
      questions: undefined,
      statusText: "",
      // 记进快照：万一后续失败，续跑时不必再问一遍
      snapshot: {
        ...prevSnapshot,
        questions: prevSnapshot.questions ?? get(taskId)?.questions,
        userAnswers,
      },
    });

    // 交互阶段可能已经挂过一个 schedule；先作废旧 generation 再开新一轮
    const generation = beginRun(taskId);
    void schedule(taskId, async (signal) => {
      if (signal.aborted || !isCurrentGeneration(taskId, generation)) return;
      update(taskId, { status: "running", startedAt: Date.now() });
      try {
        let knowledgeContext = session.options.knowledgeContext;
        const searchFn = session.options.searchFn;
        const problem = session.options.problemStatement;

        let preSearchSources: Source[] = [];
        if (searchFn) {
          const searchModel =
            session.options.modelStages?.search || session.options.thinkingModel;
          const pre = await runPreSearchFallback(
            taskId,
            problem,
            searchModel,
            userAnswers,
            signal
          );
          preSearchSources = pre.sources;
          if (pre.context) {
            knowledgeContext = knowledgeContext
              ? `${pre.context}\n\n${knowledgeContext}`
              : pre.context;
          }
        }

        if (!isCurrentGeneration(taskId, generation)) return;

        const result = await runDeepThink({
          ...session.options,
          knowledgeContext,
          userAnswers,
          enableInteractiveMode: false,
          abortSignal: signal,
          onProgress: (event) => {
            if (!isCurrentGeneration(taskId, generation)) return;
            handleProgress(taskId, event);
          },
        });

        if (result && preSearchSources.length > 0) {
          result.sources = mergeSources(preSearchSources, result.sources);
          result.knowledgeEnhanced = true;
        }

        finishTask(taskId, "deep-think", problem, result, generation);
      } catch (err) {
        failTask(taskId, err, generation);
      } finally {
        // 只有本轮还是 current 时才清 session，避免误删后续 resume 的会话
        if (isCurrentGeneration(taskId, generation)) {
          interactiveSessions.delete(taskId);
        }
      }
    });
  }

  /** 写入结果、存历史、标记完成。generation 不匹配时说明任务已被取消/续跑，忽略。 */
  function finishTask(
    taskId: string,
    mode: ThinkMode,
    question: string,
    result: DeepThinkResult | UltraThinkResult,
    generation: number
  ) {
    if (!isCurrentGeneration(taskId, generation)) return;
    const { update } = useThinkTaskStore.getState();
    const { saveThink } = useHistoryStore.getState();
    const historyId = saveThink(mode, question, result);

    update(taskId, {
      status: "completed",
      finishedAt: Date.now(),
      historyId: historyId || undefined,
      ...(mode === "deep-think"
        ? { deepThinkResult: result as DeepThinkResult }
        : { ultraThinkResult: result as UltraThinkResult }),
    });
  }

  /**
   * 区分「用户取消」和「真实失败」。
   * generation 不匹配时说明用户已经点了重试/取消后又开了新一轮——
   * 旧回调绝不能把新一轮打回 cancelled/failed（那就是「一点重试就失败」）。
   */
  function failTask(taskId: string, err: unknown, generation: number) {
    if (!isCurrentGeneration(taskId, generation)) return;
    const { update } = useThinkTaskStore.getState();
    if (isAbortError(err)) {
      update(taskId, {
        status: "cancelled",
        finishedAt: Date.now(),
        statusText: "",
      });
      return;
    }
    const message = handleError(taskId, err);
    update(taskId, {
      status: "failed",
      finishedAt: Date.now(),
      error: message,
    });
  }

  /**
   * 统一入口：建任务 → 排队 → 后台执行。
   * 立即返回 taskId 而不等待完成 —— 这是「后台跑」的关键。
   */
  function startTask(input: CreateTaskInput): string {
    const taskId = useThinkTaskStore.getState().create(input);
    dispatchRun(taskId);
    return taskId;
  }

  /**
   * 排队执行某个任务。startTask 和 resumeTask 共用 ——
   * 唯一差别是恢复时会带上 task.snapshot 交给引擎。
   */
  function dispatchRun(taskId: string) {
    const { get, update } = useThinkTaskStore.getState();
    const task = get(taskId);
    if (!task) return;

    const { enableAskQuestions } = useSettingStore.getState();
    const snapshot = task.snapshot;
    // 已经问过问题（快照里有）就不必再走交互流程
    const interactive =
      task.mode === "deep-think" &&
      enableAskQuestions === "enable" &&
      !snapshot?.questions;

    // 开新一轮：作废同 taskId 上仍在 flight 的旧回调（取消后立刻点重试就是这个场景）
    const generation = beginRun(taskId);

    void schedule(taskId, async (signal) => {
      // 排队期间被取消 / 已被更新的 generation 取代：直接退出，不要闪 running、不要 failTask
      if (signal.aborted || !isCurrentGeneration(taskId, generation)) return;
      update(taskId, {
        status: "running",
        startedAt: Date.now(),
        finishedAt: undefined,
        error: undefined,
      });
      try {
        if (interactive) {
          // 生成问题后停下等用户回答；handleProgress 的 waiting_for_answers
          // 分支会把状态置为 waiting
          await startInteractiveDeepThink(
            taskId,
            task.question,
            [],
            task.knowledgeContext,
            signal,
            generation
          );
          return;
        }

        if (task.mode === "deep-think") {
          const result = await runDeepThinkMode(
            taskId,
            task.question,
            [],
            task.knowledgeContext,
            signal,
            snapshot,
            generation
          );
          finishTask(taskId, "deep-think", task.question, result, generation);
        } else {
          const result = await runUltraThinkMode(
            taskId,
            task.question,
            task.numAgents,
            [],
            task.knowledgeContext,
            signal,
            snapshot,
            generation
          );
          finishTask(taskId, "ultra-think", task.question, result, generation);
        }
      } catch (err) {
        failTask(taskId, err, generation);
      }
    });
  }

  /**
   * 断点续跑：从失败/取消处继续。
   * 有快照则跳过已完成阶段（DT 从中断轮次接着跑，UT 只重跑未完成的 agent）；
   * 无快照则等价于从头重试。
   *
   * 也可对 running/queued 任务调用——会先 abort 当前一轮再开新一轮
   * （generation 保护保证旧回调不会把新一轮打回失败）。
   */
  function resumeTask(taskId: string) {
    const task = useThinkTaskStore.getState().get(taskId);
    if (!task) return;

    // 若仍在跑/排队，先 abort 旧 controller（generation 会在 dispatchRun 里递增）
    if (task.status === "running" || task.status === "queued") {
      cancel(taskId);
    }

    useThinkTaskStore.getState().update(taskId, {
      status: "queued",
      statusText: "",
      error: undefined,
      finishedAt: undefined,
    });
    dispatchRun(taskId);
  }

  /** 取消任务：中断在途请求，作废 generation，清理交互会话 */
  function cancelTask(taskId: string) {
    cancel(taskId);
    invalidateRun(taskId); // 作废 in-flight 的 finish/fail，避免晚到的 abort 再写一次状态
    interactiveSessions.delete(taskId);
    const { get, update } = useThinkTaskStore.getState();
    const task = get(taskId);
    // 排队中/等待回答/运行中：直接落终态（运行中的 catch 也会因 generation 不匹配而忽略）
    if (
      task &&
      (task.status === "queued" ||
        task.status === "waiting" ||
        task.status === "running")
    ) {
      update(taskId, {
        status: "cancelled",
        finishedAt: Date.now(),
        isWaitingForAnswers: false,
        statusText: "",
      });
    }
  }

  /** 删除任务：先取消，再从列表移除 */
  function removeTask(taskId: string) {
    clearRun(taskId);
    interactiveSessions.delete(taskId);
    useThinkTaskStore.getState().remove(taskId);
  }

  return {
    startTask,
    resumeTask,
    continueWithAnswers,
    cancelTask,
    removeTask,
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
