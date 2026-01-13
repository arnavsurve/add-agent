import { createOpencode, type Event } from "@opencode-ai/sdk";
import { logProgress } from "./supabase.js";

interface RunAgentOptions {
  workspace: string;
  title: string;
  description: string;
  agentRunId: string;
  ticketId: string;
}

export async function runAgent(options: RunAgentOptions): Promise<void> {
  const { workspace, title, description, agentRunId, ticketId } = options;

  await logProgress(agentRunId, ticketId, "thinking", "Starting agent runtime");

  // Create embedded server + client
  const { client, server } = await createOpencode({
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

  console.log("OpenCode server ready");

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

    // Start event streaming in background
    streamEventsToSupabase(client, sessionId, agentRunId, ticketId, workspace);

    // Build and send prompt
    const prompt = buildPrompt(title, description);
    await logProgress(agentRunId, ticketId, "thinking", "Exploring...");

    const promptResult = await client.session.prompt({
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

    console.log("Agent task complete");
    await logProgress(
      agentRunId,
      ticketId,
      "action",
      "Implementation complete",
    );

    // Abort and cleanup session to stop any ongoing work
    await client.session.abort({
      path: { id: sessionId },
      query: { directory: workspace },
    });

    await client.session.delete({
      path: { id: sessionId },
      query: { directory: workspace },
    });
  } finally {
    // Stop embedded server
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

// Track logged diffs to prevent duplicates (session.diff fires multiple times)
const loggedDiffKeys = new Set<string>();

async function streamEventsToSupabase(
  client: Awaited<ReturnType<typeof createOpencode>>["client"],
  sessionId: string,
  agentRunId: string,
  ticketId: string,
  workspace: string,
): Promise<void> {
  // Clear tracked diffs for new session
  loggedDiffKeys.clear();

  try {
    const eventResult = await client.event.subscribe({
      query: { directory: workspace },
    });

    // The SSE result has a .stream property that is the async generator
    for await (const event of eventResult.stream) {
      await handleEvent(event as Event, sessionId, agentRunId, ticketId);
    }
  } catch (error) {
    console.error("Event stream error:", error);
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
  }
}
