import { createOpencodeClient, type Event } from "@opencode-ai/sdk";
import { createOpencodeServer } from "@opencode-ai/sdk";
import { Agent, fetch as undiciFetch, setGlobalDispatcher } from "undici";
import { logProgress, getAgentRunStatus } from "./supabase.js";

interface RunAgentOptions {
  workspace: string;
  title: string;
  description: string;
  agentRunId: string;
  ticketId: string;
}

const STATUS_POLL_INTERVAL_MS = 2000;
const STOP_CHECK_INTERVAL_MS = 1000;
const EVENT_STREAM_MAX_RETRIES = 5;
const CONNECT_TIMEOUT_MS = 30_000;

// Create a shared undici agent with no timeouts for long-running requests
const noTimeoutAgent = new Agent({
  headersTimeout: 0,
  bodyTimeout: 0,
  connectTimeout: CONNECT_TIMEOUT_MS,
});

// Custom fetch that uses undici with no timeouts
// This is needed because the SDK's SSE client uses raw fetch() which has default timeouts
// eslint-disable-next-line @typescript-eslint/no-explicit-any
function createNoTimeoutFetch(): any {
  return (input: string | URL | Request, init?: RequestInit) => {
    // Convert to string URL for undici compatibility
    const url = typeof input === "string" ? input : input instanceof URL ? input.toString() : input.url;
    return undiciFetch(url, {
      ...init,
      dispatcher: noTimeoutAgent,
    } as any);
  };
}

function configureHttpTimeouts(): void {
  // Also set global dispatcher for any other fetch calls
  setGlobalDispatcher(noTimeoutAgent);
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function getRetryDelay(attempt: number): number {
  return Math.min(1000 * 2 ** (attempt - 1), 10_000);
}

export async function runAgent(options: RunAgentOptions): Promise<void> {
  const { workspace, title, description, agentRunId, ticketId } = options;

  await logProgress(agentRunId, ticketId, "thinking", "Starting agent runtime");

  configureHttpTimeouts();

  // Create embedded server
  const server = await createOpencodeServer({
    port: 4096,
    timeout: 30000, // 30 seconds for server startup (default is 5s)
    config: {
      provider: {
        anthropic: {
          options: { apiKey: process.env.ANTHROPIC_API_KEY },
        },
      },
      permission: {
        bash: "allow",
        edit: "allow",
      },
    },
  });

  // Create client with custom fetch that has no timeouts
  // This is critical for SSE streams that can have long pauses between events
  const client = createOpencodeClient({
    baseUrl: server.url,
    fetch: createNoTimeoutFetch(),
  });

  console.log("OpenCode server ready (extended timeouts configured)");

  // Create abort controller for cancelling event stream
  const eventStreamAbort = new AbortController();

  try {
    // Create session in the workspace
    const sessionResult = await client.session.create({
      body: { title },
      query: { directory: workspace },
    });

    if (sessionResult.error) {
      throw new Error(
        `Failed to create session: ${JSON.stringify(sessionResult.error)}`,
      );
    }

    const sessionId = sessionResult.data.id;
    console.log(`Session created: ${sessionId}`);

    // Start event streaming in background (with abort signal)
    streamEventsToSupabase(
      client,
      sessionId,
      agentRunId,
      ticketId,
      workspace,
      eventStreamAbort.signal,
    );

    // Build and send prompt
    const prompt = buildPrompt(title, description);
    await logProgress(agentRunId, ticketId, "thinking", "Exploring...");

    const promptResult = await client.session.promptAsync({
      path: { id: sessionId },
      query: { directory: workspace },
      body: {
        agent: "build",
        parts: [{ type: "text", text: prompt }],
      },
    });

    if (promptResult.error) {
      throw new Error(
        `Failed to send prompt: ${JSON.stringify(promptResult.error)}`,
      );
    }

    await waitForAgentCompletion(
      client,
      sessionId,
      agentRunId,
      ticketId,
      workspace,
    );

    console.log("Agent task complete");

    await client.session.delete({
      path: { id: sessionId },
      query: { directory: workspace },
    });
  } finally {
    // Stop event stream and embedded server
    eventStreamAbort.abort();
    server.close();
  }
}

function buildPrompt(title: string, description: string): string {
  return `# Task: ${title}

## Description
${description}

## Instructions
1. Analyze the codebase to understand the current structure
2. Implement the requested changes
3. Ensure code quality and follow existing patterns
4. Do not create unnecessary files or make unrelated changes

Please proceed with the implementation.`;
}

async function waitForAgentCompletion(
  client: ReturnType<typeof createOpencodeClient>,
  sessionId: string,
  agentRunId: string,
  ticketId: string,
  workspace: string,
): Promise<void> {
  let statusErrorCount = 0;
  let lastStopCheck = 0;
  let lastRetryMessage: string | null = null;

  while (true) {
    // Check for stop request first (every iteration, not just every STOP_CHECK_INTERVAL_MS)
    const now = Date.now();
    if (now - lastStopCheck >= STOP_CHECK_INTERVAL_MS) {
      lastStopCheck = now;
      if (await isStopRequested(agentRunId)) {
        console.log("Stop requested, aborting session...");
        await logProgress(agentRunId, ticketId, "action", "Stopping agent run");
        
        // Abort the OpenCode session
        try {
          await client.session.abort({
            path: { id: sessionId },
            query: { directory: workspace },
          });
          console.log("Session abort sent");
        } catch (abortError) {
          console.error("Error sending abort:", abortError);
        }
        
        throw new Error("Stopped by user");
      }
    }

    const statusResult = await client.session.status({
      query: { directory: workspace },
    });

    if (statusResult.error) {
      statusErrorCount += 1;
      if (statusErrorCount >= 3) {
        throw new Error(
          `OpenCode server unavailable while checking session status: ${JSON.stringify(
            statusResult.error,
          )}`,
        );
      }
      await sleep(getRetryDelay(statusErrorCount));
      continue;
    }

    statusErrorCount = 0;
    const status = statusResult.data?.[sessionId];

    if (!status) {
      throw new Error("OpenCode server returned no status for active session");
    }

    if (status.type === "idle") {
      return;
    }

    if (status.type === "retry" && status.message !== lastRetryMessage) {
      lastRetryMessage = status.message;
      await logProgress(
        agentRunId,
        ticketId,
        "thinking",
        `Agent retrying: ${status.message}`,
      );
    }

    await sleep(STATUS_POLL_INTERVAL_MS);
  }
}

async function isStopRequested(agentRunId: string): Promise<boolean> {
  const status = await getAgentRunStatus(agentRunId);
  if (!status) {
    return false;
  }

  return status.status === "failed" && status.error === "Stopped by user";
}

// Track logged diffs to prevent duplicates (session.diff fires multiple times)
const loggedDiffKeys = new Set<string>();

async function streamEventsToSupabase(
  client: ReturnType<typeof createOpencodeClient>,
  sessionId: string,
  agentRunId: string,
  ticketId: string,
  workspace: string,
  abortSignal: AbortSignal,
): Promise<void> {
  // Clear tracked diffs for new session
  loggedDiffKeys.clear();

  let attempt = 0;

  while (attempt <= EVENT_STREAM_MAX_RETRIES && !abortSignal.aborted) {
    try {
      const eventResult = await client.event.subscribe({
        query: { directory: workspace },
        signal: abortSignal, // Pass abort signal to cancel the SSE connection
      });

      // The SSE result has a .stream property that is the async generator
      for await (const event of eventResult.stream) {
        // Check abort signal before processing each event
        if (abortSignal.aborted) {
          console.log("Event stream aborted");
          return;
        }
        await handleEvent(event as Event, sessionId, agentRunId, ticketId);
      }

      return;
    } catch (error) {
      // Don't retry if aborted
      if (abortSignal.aborted) {
        console.log("Event stream aborted");
        return;
      }

      attempt += 1;
      console.error(
        `Event stream error (attempt ${attempt}/${EVENT_STREAM_MAX_RETRIES}):`,
        error,
      );

      if (attempt >= EVENT_STREAM_MAX_RETRIES) {
        console.error("Event stream retries exhausted; stopping updates.");
        return;
      }

      await sleep(getRetryDelay(attempt));
    }
  }
}

async function handleEvent(
  event: Event,
  sessionId: string,
  agentRunId: string,
  ticketId: string,
): Promise<void> {
  // Type-safe property access helpers
  const props = event.properties as Record<string, unknown>;

  switch (event.type) {
    case "message.part.updated": {
      const part = props.part as Record<string, unknown>;
      if (!part) break;

      const partType = part.type as string;
      const state = part.state as Record<string, unknown> | undefined;

      // Agent reasoning/thinking
      if (partType === "reasoning") {
        const text = (part.text as string) || "";
        const timing = part.time as { start: number; end?: number } | undefined;
        if (text.trim()) {
          await logProgress(
            agentRunId,
            ticketId,
            "thinking",
            text.length > 100 ? text.slice(0, 100) + "..." : text,
            { fullText: text, timing },
          );
        }
      }

      // Tool calls with full details - only log when completed
      if (partType === "tool" && state?.status === "completed") {
        const tool = part.tool as string;
        const callId = part.callID as string;
        const input = state?.input;
        const output = state?.output as string | undefined;
        const title = state?.title as string | undefined;
        const timing = state?.time as
          | { start: number; end?: number }
          | undefined;

        // Truncate large outputs
        const truncatedOutput =
          output && output.length > 2000
            ? output.slice(0, 2000) + "\n... (truncated)"
            : output;

        await logProgress(agentRunId, ticketId, "tool_call", title || tool, {
          tool,
          input,
          output: truncatedOutput,
          callId,
          timing,
        });
      }

      // Note: Text responses (partType === "text") are not logged individually
      // because they fire for every streaming token, causing massive duplication.
      // The tool calls provide the meaningful action log.
      break;
    }

    case "session.diff": {
      // File changes - store for "Changes" tab (not in main agent log)
      const diffs = props.diff as
        | Array<{
            file: string;
            before: string;
            after: string;
            additions: number;
            deletions: number;
          }>
        | undefined;

      if (diffs) {
        for (const diff of diffs) {
          // Deduplicate based on file + content
          const diffKey = `${diff.file}:${(diff.after || "").slice(0, 100)}`;
          if (loggedDiffKeys.has(diffKey)) {
            continue;
          }
          loggedDiffKeys.add(diffKey);

          // Truncate very large diffs
          const truncatedBefore =
            diff.before && diff.before.length > 5000
              ? diff.before.slice(0, 5000) + "\n... (truncated)"
              : diff.before;
          const truncatedAfter =
            diff.after && diff.after.length > 5000
              ? diff.after.slice(0, 5000) + "\n... (truncated)"
              : diff.after;

          // Log as session_changes type (for separate Changes tab, not agent log)
          await logProgress(
            agentRunId,
            ticketId,
            "session_changes",
            `${diff.file} (+${diff.additions}/-${diff.deletions})`,
            {
              file: diff.file,
              before: truncatedBefore,
              after: truncatedAfter,
              additions: diff.additions,
              deletions: diff.deletions,
            },
          );
        }
      }
      break;
    }

    // Note: file.edited events are ignored since session.diff provides richer data

    case "session.error": {
      const errorSessionId = props.sessionID as string;
      if (errorSessionId === sessionId) {
        const error = props.error;
        const errorMsg = error ? JSON.stringify(error) : "Unknown error";
        await logProgress(agentRunId, ticketId, "error", errorMsg);
      }
      break;
    }

    case "todo.updated": {
      const todoSessionId = props.sessionID as string;
      if (todoSessionId !== sessionId) break;

      const todos = props.todos as
        | Array<{
            id: string;
            content: string;
            status: string;
            priority: string;
          }>
        | undefined;

      if (todos && todos.length > 0) {
        const completed = todos.filter((t) => t.status === "completed").length;
        const inProgress = todos.filter(
          (t) => t.status === "in_progress",
        ).length;

        await logProgress(
          agentRunId,
          ticketId,
          "todo_update",
          `Todos: ${completed}/${todos.length} complete${inProgress > 0 ? `, ${inProgress} in progress` : ""}`,
          { todos },
        );
      }
      break;
    }
  }
}
