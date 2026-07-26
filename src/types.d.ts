interface Resource {
  id: string;
  name: string;
  type: string;
  size: number;
  status: "unprocessed" | "processing" | "completed" | "failed";
}

interface FileMeta {
  name: string;
  size: number;
  type: string;
  lastModified: number;
}

interface Knowledge {
  id: string;
  title: string;
  content: string;
  type: "file" | "url" | "knowledge";
  fileMeta?: FileMeta;
  url?: string;
  createdAt: number;
  updatedAt: number;
}

interface ImageSource {
  url: string;
  description?: string;
}

interface Source {
  title?: string;
  content?: string;
  url: string;
  images?: ImageSource[];
}

interface SearchTask {
  state: "unprocessed" | "processing" | "completed" | "failed";
  query: string;
  researchGoal: string;
  learning: string;
  sources: Source[];
  images: ImageSource[];
}

interface PartialJson {
  value: JSONValue | undefined;
  state:
    | "undefined-input"
    | "successful-parse"
    | "repaired-parse"
    | "failed-parse";
}

interface WebSearchResult {
  content: string;
  url: string;
  title?: string;
}

// Deep Think Mode Types
type ThinkMode = "deep-think" | "ultra-think";

interface Verification {
  timestamp: number;
  passed: boolean;
  bugReport: string;
  goodVerify: string;
}

interface DeepThinkIteration {
  iteration: number;
  solution: string;
  verification: Verification;
  status: "thinking" | "verifying" | "correcting" | "completed" | "failed";
}

interface DeepThinkResult {
  mode: "deep-think";
  questions?: string; // 询问阶段生成的问题
  userAnswers?: string; // 用户的回答
  plan?: string; // 思考计划
  initialThought: string;
  improvements: string[];
  iterations: DeepThinkIteration[];
  verifications: Verification[];
  finalSolution: string;
  summary?: string;
  totalIterations: number;
  successfulVerifications: number;
  sources?: Source[]; // 引用来源追踪
  knowledgeEnhanced?: boolean; // 是否使用了知识增强
}

interface AgentResult {
  agentId: string;
  approach: string;
  specificPrompt: string;
  status: "pending" | "thinking" | "verifying" | "completed" | "failed";
  progress: number;
  solution?: string;
  verifications?: Verification[];
  error?: string;
}

interface UltraThinkResult {
  mode: "ultra-think";
  questions?: string; // 询问阶段生成的问题
  userAnswers?: string; // 用户的回答
  plan: string;
  agentResults: AgentResult[];
  synthesis: string;
  finalSolution: string;
  summary?: string;
  totalAgents: number;
  completedAgents: number;
  sources?: Source[]; // 引用来源追踪
  knowledgeEnhanced?: boolean; // 是否使用了知识增强
}

type ThinkResult = DeepThinkResult | UltraThinkResult;

// Multi-task Types —— 多任务后台运行
type ThinkTaskStatus =
  | "queued" // 排队中，等待并发槽位
  | "running" // 执行中
  | "waiting" // 等待用户回答澄清问题（交互式 Deep Think）
  | "completed"
  | "failed"
  | "cancelled";

/**
 * 断点续跑快照：引擎在各阶段完成后上报，失败时保留在任务上。
 * 恢复时用它跳过已完成的阶段，只重跑中断的部分。
 */
interface ThinkTaskSnapshot {
  /** 澄清问题（若启用询问阶段） */
  questions?: string;
  /** 用户对澄清问题的回答 */
  userAnswers?: string;
  /** 思考计划（若启用计划阶段） */
  plan?: string;
  /** pre-search 及思考过程中累积的来源 */
  sources?: Source[];

  // ── Deep Think ──
  /** 初次探索的产物，恢复时作为 initialThought */
  initialThought?: string;
  /** 最近一版解，恢复后作为主循环的起点 */
  solution?: string;
  /** 已完成的迭代记录 */
  iterations?: DeepThinkIteration[];
  /** 已完成的验证记录 */
  verifications?: Verification[];
  /** 中断时已跑完的轮数，恢复后从这里接着数 */
  completedIterations?: number;
  /** 中断时连续通过的验证次数 */
  correctCount?: number;

  // ── Ultra Think ──
  /** agent 配置，恢复时复用，不重新生成 */
  agentConfigs?: Array<{
    agentId: string;
    approach: string;
    specificPrompt: string;
  }>;
  /** 已跑完的 agent 结果，恢复时直接复用 */
  completedAgents?: AgentResult[];
}

interface ThinkTask {
  id: string;
  question: string;
  mode: ThinkMode;
  status: ThinkTaskStatus;
  createdAt: number;
  startedAt?: number;
  finishedAt?: number;

  // 运行时进度（原 GlobalStore 的全局字段，现按任务隔离）
  currentIteration: number;
  currentPhase: string;
  currentSolution: string;
  agentResults: AgentResult[];
  statusText: string;
  deepThinkResult: DeepThinkResult | null;
  ultraThinkResult: UltraThinkResult | null;

  // 交互式 Deep Think
  isWaitingForAnswers: boolean;
  questions?: string;

  // 提交时的输入快照：排队任务稍后启动时不能再读当时的表单
  numAgents?: number;
  knowledgeContext?: string;

  /** 断点续跑快照；失败/取消后保留，供「继续」使用 */
  snapshot?: ThinkTaskSnapshot;

  error?: string;
  historyId?: string;
}