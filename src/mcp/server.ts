import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import type { Transport } from "@modelcontextprotocol/sdk/shared/transport.js";
import { defaultRunner } from "../core/runner.js";
import type { MultiAgentRunner } from "../core/runner.js";
import { registerMcpTools, BackgroundDispatchService } from "./tools.js";
import { VERSION } from "../version.js";

export interface McpServerOptions {
  name?: string;
  version?: string;
  runner?: MultiAgentRunner;
  handleSignals?: boolean;
  transport?: Transport;
  /**
   * T1.4 background-dispatch service. Tests inject one bound to a temporary
   * home directory; production defaults to a registry under the resolved
   * AgentMesh home. When provided it is also used by startMcpServer for the
   * startup orphan sweep and graceful shutdown.
   */
  backgroundService?: BackgroundDispatchService;
}

/**
 * Upper bound for waiting on in-flight executions during shutdown. The wait is
 * event-driven (resolves as soon as every aborted run has recorded its turn);
 * this cap only bounds the pathological case. A hard SIGKILL before flushing
 * remains an honest residual boundary.
 */
const SHUTDOWN_FLUSH_BUDGET_MS = 10_000;

/**
 * Best-effort host notification on background-task terminal/stall events
 * (Plan 2026-09-01). Uses the generic logging notification because
 * notifications/progress is only valid within an in-flight request —
 * delegate_task has already returned by the time a background task
 * terminates. Hosts that do not surface logging messages to the model simply
 * ignore these; long-polling poll_task remains the reliable observation
 * mechanism.
 */
function attachBackgroundTaskNotifier(
  server: McpServer,
  background: BackgroundDispatchService,
): void {
  const bus = background.registry.eventBus;
  if (!bus) return;
  bus.subscribe((event) => {
    if (event.type !== "task.completed" && event.type !== "task.stalled") return;
    const data =
      event.type === "task.completed"
        ? `Background task ${event.taskId} ${event.status}. Call poll_task with taskId="${event.taskId}" to fetch the terminal result.`
        : `Background task ${event.taskId} appears stalled (no output for a while). Inspect it with poll_task.`;
    try {
      void server.sendLoggingMessage({ level: "info", logger: "agentmesh", data }).catch(() => {
        // Hosts may reject unsupported notifications; never crash the task.
      });
    } catch {
      // Same posture: notification failure must not affect task execution.
    }
  });
}

/**
 * Creates and initializes the Multi-Agent Bridge MCP Server instance.
 */
export function createMcpServer(options: McpServerOptions = {}): McpServer {
  const server = new McpServer(
    {
      name: options.name || "agentmesh",
      version: options.version || VERSION,
    },
    // Logging capability is required for sendLoggingMessage to actually emit
    // (background-task notifications, Plan 2026-09-01); without it the SDK
    // silently drops every logging message.
    { capabilities: { logging: {} } },
  );

  const runner = options.runner || defaultRunner;
  registerMcpTools(server, runner, { background: options.backgroundService });
  if (options.backgroundService) {
    attachBackgroundTaskNotifier(server, options.backgroundService);
  }

  return server;
}

/**
 * Starts the MCP server on stdio transport.
 */
export async function startMcpServer(options: McpServerOptions = {}): Promise<McpServer> {
  // One shared service instance for tool registration, startup reaping and
  // graceful shutdown; createMcpServer would otherwise build its own default.
  const background = options.backgroundService ?? new BackgroundDispatchService();
  const server = createMcpServer({ ...options, backgroundService: background });
  const transport = options.transport || new StdioServerTransport();
  const runner = options.runner || defaultRunner;

  // T1.4 startup orphan sweep: registrations whose owning bridge process died
  // are removed from the task registry before any new work is accepted.
  await background.registry.scanAndReapOrphans();

  await server.connect(transport);

  if (options.handleSignals === false) return server;

  // Handle process signals for graceful shutdown. Unregister on normal close so
  // repeated programmatic starts do not accumulate process listeners.
  const originalClose = server.close.bind(server);
  let closePromise: Promise<void> | undefined;
  let shutdownStarted = false;
  const removeSignalHandlers = () => {
    process.off("SIGINT", handleExit);
    process.off("SIGTERM", handleExit);
  };
  const closeServer = async () => {
    if (!closePromise) {
      removeSignalHandlers();
      closePromise = originalClose();
    }
    await closePromise;
  };

  /**
   * Disconnect path (stdio close, SIGINT, SIGTERM): abort in-flight executions
   * through their registered controllers and wait — bounded by the flush budget
   * — for each aborted run to record its terminal failed turn with full cancel
   * evidence before the process goes away.
   */
  const gracefulShutdown = async () => {
    if (shutdownStarted) return;
    shutdownStarted = true;
    try {
      await Promise.race([
        Promise.allSettled([
          runner.abortAllInFlight(),
          background.abortAll("AgentMesh server is shutting down."),
        ]),
        new Promise((resolve) => setTimeout(resolve, SHUTDOWN_FLUSH_BUDGET_MS)),
      ]);
    } catch {
      // Shutdown must proceed even if aborting or flushing fails.
    }
    await closeAndExit();
  };

  const closeAndExit = async () => {
    try {
      await closeServer();
    } catch {
      // Ignore
    }
    process.exitCode = 0;
  };

  const handleExit = () => {
    void gracefulShutdown();
  };

  process.on("SIGINT", handleExit);
  process.on("SIGTERM", handleExit);
  const previousOnClose = transport.onclose?.bind(transport);
  transport.onclose = () => {
    previousOnClose?.();
    void gracefulShutdown();
  };
  server.close = closeServer;

  return server;
}
