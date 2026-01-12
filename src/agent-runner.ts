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
  // Only process events for our session
  switch (event.type) {
    case "file.edited":
      await logProgress(
        agentRunId,
        ticketId,
        "file_edit",
        `Modified: ${event.properties.file}`,
      );
      break;
    case "session.error":
      if (event.properties.sessionID === sessionId) {
        const errorMsg = event.properties.error
          ? JSON.stringify(event.properties.error)
          : "Unknown error";
        await logProgress(agentRunId, ticketId, "error", errorMsg);
      }
      break;
    case "message.part.updated":
      // Tool usage - log when a tool completes
      if (
        event.properties.part.type === "tool" &&
        event.properties.part.state.status === "completed"
      ) {
        await logProgress(
          agentRunId,
          ticketId,
          "action",
          `Tool: ${event.properties.part.tool}`,
        );
      }
      break;
  }
}
