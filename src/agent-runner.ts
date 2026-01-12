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

  await logProgress(
    agentRunId,
    ticketId,
    "thinking",
    "Starting agent runtime...",
  );

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
    await logProgress(
      agentRunId,
      ticketId,
      "thinking",
      "Analyzing codebase and implementing changes...",
    );

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

async function streamEventsToSupabase(
  client: Awaited<ReturnType<typeof createOpencode>>["client"],
  sessionId: string,
  agentRunId: string,
  ticketId: string,
  workspace: string,
): Promise<void> {
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

  // Debug: log all event types
  console.log(`[Event] ${event.type}`, JSON.stringify(props, null, 2).slice(0, 500));

  switch (event.type) {
    case "message.part.updated": {
      const part = props.part as Record<string, unknown>;
      if (!part) break;

      const partType = part.type as string;
      const state = part.state as Record<string, unknown> | undefined;

      console.log(`[Part] type=${partType}, state.status=${state?.status}`);

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
            { fullText: text, timing }
          );
        }
      }

      // Tool calls - capture both pending and completed states
      if (partType === "tool") {
        const tool = part.tool as string;
        const callId = part.callID as string;
        const status = state?.status as string;

        // Log when tool completes (has output)
        if (status === "completed") {
          const input = state?.input;
          const output = state?.output as string | undefined;
          const title = state?.title as string | undefined;
          const timing = state?.time as { start: number; end?: number } | undefined;

          // Truncate large outputs
          const truncatedOutput = output && output.length > 2000
            ? output.slice(0, 2000) + "\n... (truncated)"
            : output;

          await logProgress(
            agentRunId,
            ticketId,
            "tool_call",
            title || tool,
            {
              tool,
              input,
              output: truncatedOutput,
              callId,
              timing,
            }
          );
        }
        // Log when tool starts running (for immediate feedback)
        else if (status === "running" || status === "pending") {
          const title = state?.title as string | undefined;
          await logProgress(
            agentRunId,
            ticketId,
            "action",
            `Running: ${title || tool}`,
            { tool, callId, status }
          );
        }
      }

      // Agent text responses
      if (partType === "text") {
        const text = (part.text as string) || "";
        if (text.trim()) {
          await logProgress(
            agentRunId,
            ticketId,
            "response",
            text.length > 200 ? text.slice(0, 200) + "..." : text,
            { fullText: text }
          );
        }
      }
      break;
    }

    case "session.diff": {
      // File changes with actual diff content
      const diffs = props.diff as Array<{
        file: string;
        before: string;
        after: string;
        additions: number;
        deletions: number;
      }> | undefined;

      if (diffs) {
        for (const diff of diffs) {
          // Truncate very large diffs
          const truncatedBefore = diff.before && diff.before.length > 5000
            ? diff.before.slice(0, 5000) + "\n... (truncated)"
            : diff.before;
          const truncatedAfter = diff.after && diff.after.length > 5000
            ? diff.after.slice(0, 5000) + "\n... (truncated)"
            : diff.after;

          await logProgress(
            agentRunId,
            ticketId,
            "file_edit",
            `${diff.file} (+${diff.additions}/-${diff.deletions})`,
            {
              file: diff.file,
              before: truncatedBefore,
              after: truncatedAfter,
              additions: diff.additions,
              deletions: diff.deletions,
            }
          );
        }
      }
      break;
    }

    case "file.edited": {
      // Simple file edit notification (fallback if no session.diff)
      const file = props.file as string;
      if (file) {
        await logProgress(
          agentRunId,
          ticketId,
          "file_edit",
          `Modified: ${file}`,
          { file }
        );
      }
      break;
    }

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
