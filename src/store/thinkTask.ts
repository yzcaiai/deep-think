import { create } from "zustand";
import { customAlphabet } from "nanoid";

export interface ThinkTaskStore {
  tasks: ThinkTask[];
  /** 当前展示的任务 id。空串表示「新任务」空白态 */
  activeTaskId: string;
}

export interface CreateTaskInput {
  question: string;
  mode: ThinkMode;
  numAgents?: number;
  knowledgeContext?: string;
  /** 从历史记录加载时直接落成已完成任务 */
  status?: ThinkTaskStatus;
  deepThinkResult?: DeepThinkResult | null;
  ultraThinkResult?: UltraThinkResult | null;
  historyId?: string;
}

interface ThinkTaskActions {
  create: (input: CreateTaskInput) => string;
  update: (id: string, patch: Partial<ThinkTask>) => void;
  updateAgentResult: (
    id: string,
    agentId: string,
    patch: Partial<AgentResult>
  ) => void;
  setActive: (id: string) => void;
  remove: (id: string) => void;
  get: (id: string) => ThinkTask | undefined;
  getActive: () => ThinkTask | undefined;
}

const nanoid = customAlphabet("1234567890abcdefghijklmnopqrstuvwxyz", 12);

export const useThinkTaskStore = create<ThinkTaskStore & ThinkTaskActions>(
  (set, get) => ({
    tasks: [],
    activeTaskId: "",

    create: (input) => {
      const id = nanoid();
      const task: ThinkTask = {
        id,
        question: input.question,
        mode: input.mode,
        status: input.status ?? "queued",
        createdAt: Date.now(),
        currentIteration: 0,
        currentPhase: "",
        currentSolution: "",
        agentResults: [],
        statusText: "",
        deepThinkResult: input.deepThinkResult ?? null,
        ultraThinkResult: input.ultraThinkResult ?? null,
        isWaitingForAnswers: false,
        numAgents: input.numAgents,
        knowledgeContext: input.knowledgeContext,
        historyId: input.historyId,
      };
      set((state) => ({
        tasks: [...state.tasks, task],
        activeTaskId: id,
      }));
      return id;
    },

    update: (id, patch) =>
      set((state) => {
        const index = state.tasks.findIndex((task) => task.id === id);
        if (index === -1) return state;
        const tasks = [...state.tasks];
        tasks[index] = { ...tasks[index], ...patch };
        return { tasks };
      }),

    updateAgentResult: (id, agentId, patch) =>
      set((state) => {
        const index = state.tasks.findIndex((task) => task.id === id);
        if (index === -1) return state;

        const task = state.tasks[index];
        const agentIndex = task.agentResults.findIndex(
          (agent) => agent.agentId === agentId
        );

        let agentResults: AgentResult[];
        if (agentIndex >= 0) {
          agentResults = [...task.agentResults];
          agentResults[agentIndex] = { ...agentResults[agentIndex], ...patch };
        } else {
          // LLM 动态创建的 agent：不存在时补一个
          const newAgent: AgentResult = {
            agentId,
            approach: "",
            specificPrompt: "",
            status: "pending",
            progress: 0,
            ...patch,
          };
          agentResults = [...task.agentResults, newAgent];
        }

        const tasks = [...state.tasks];
        tasks[index] = { ...task, agentResults };
        return { tasks };
      }),

    setActive: (id) => set(() => ({ activeTaskId: id })),

    remove: (id) =>
      set((state) => {
        const tasks = state.tasks.filter((task) => task.id !== id);
        return {
          tasks,
          activeTaskId:
            state.activeTaskId === id ? "" : state.activeTaskId,
        };
      }),

    get: (id) => get().tasks.find((task) => task.id === id),

    getActive: () => {
      const { tasks, activeTaskId } = get();
      return tasks.find((task) => task.id === activeTaskId);
    },
  })
);

/** 当前展示的任务；无选中任务时为 undefined（新任务空白态） */
export const useActiveTask = () =>
  useThinkTaskStore((state) =>
    state.tasks.find((task) => task.id === state.activeTaskId)
  );

/** 是否存在未结束的任务 —— 用于 beforeunload 拦截 */
export function hasPendingTasks(): boolean {
  return useThinkTaskStore
    .getState()
    .tasks.some(
      (task) =>
        task.status === "running" ||
        task.status === "queued" ||
        task.status === "waiting"
    );
}
