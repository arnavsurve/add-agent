import { simpleGit } from "simple-git";
import { getAuthenticatedCloneUrl, createPullRequest } from "./github.js";
import {
  logProgress,
  updateTicketStatus,
  updateAgentRun,
  updateAgentRunBranch,
  markAgentRunPushed,
} from "./supabase.js";
import { runAgent } from "./agent-runner.js";
import fs from "fs/promises";

/**
 * Extract a human-readable error message from various error types
 */
function extractErrorMessage(error: unknown): string {
  if (error === null || error === undefined) {
    return "Unknown error (null/undefined)";
  }

  // Handle Error objects
  if (error instanceof Error) {
    // Check for nested cause (common in fetch errors)
    const cause = (error as Error & { cause?: Error }).cause;
    if (cause instanceof Error) {
      return `${error.message}: ${cause.message}`;
    }

    // Check for Git errors with more details
    const gitError = error as Error & { task?: { commands?: string[] } };
    if (gitError.task?.commands) {
      return `${error.message} (command: ${gitError.task.commands.join(" ")})`;
    }

    return error.message;
  }

  // Handle plain objects with message property
  if (typeof error === "object" && error !== null) {
    const errObj = error as Record<string, unknown>;
    if (typeof errObj.message === "string") {
      return errObj.message;
    }
    if (typeof errObj.error === "string") {
      return errObj.error;
    }
    // Try to stringify, but limit length
    try {
      const str = JSON.stringify(error);
      return str.length > 500 ? str.slice(0, 500) + "..." : str;
    } catch {
      return "Unknown error (non-serializable object)";
    }
  }

  // Handle strings
  if (typeof error === "string") {
    return error;
  }

  return `Unknown error: ${String(error)}`;
}


// Job passed via environment variable
interface AgentJob {
  ticketId: string;
  agentRunId: string;
  repoUrl: string;
  branchName: string;
  title: string;
  description: string;
  installationId: string;
}

async function main() {
  // Parse job from environment
  const jobJson = process.env.AGENT_JOB;
  if (!jobJson) {
    console.error("AGENT_JOB environment variable not set");
    process.exit(1);
  }

  const job: AgentJob = JSON.parse(jobJson);
  const workspace = `/tmp/workspace-${job.ticketId}`;
  const runBranchName = `${job.branchName}-${job.agentRunId.slice(0, 8)}`;

  console.log(`Starting agent for ticket: ${job.title}`);
  console.log(`Repo: ${job.repoUrl}`);
  console.log(`Branch: ${runBranchName}`);
  console.log(`Installation ID: ${job.installationId}`);

  try {
    await logProgress(
      job.agentRunId,
      job.ticketId,
      "started",
      `Agent starting for: ${job.title}`,
    );

    // 0. Clean up workspace if it exists (from previous failed runs)
    try {
      await fs.rm(workspace, { recursive: true, force: true });
    } catch {
      // Ignore if doesn't exist
    }

    // 1. Clone repository
    await logProgress(
      job.agentRunId,
      job.ticketId,
      "thinking",
      "Cloning repository",
    );
    const authUrl = await getAuthenticatedCloneUrl(
      job.repoUrl,
      job.installationId,
    );
    await simpleGit().clone(authUrl, workspace);
    console.log("Repository cloned");

    // 2. Create branch and configure git identity
    const git = simpleGit(workspace);
    await git.addConfig("user.email", "arnav@surve.dev");
    await git.addConfig("user.name", "ADD Agent");
    await git.checkoutLocalBranch(runBranchName);
    await updateAgentRunBranch(job.agentRunId, runBranchName);
    await logProgress(
      job.agentRunId,
      job.ticketId,
      "action",
      `Created branch: ${runBranchName}`,
    );
    console.log(`Created branch: ${runBranchName}`);

    // 3. Run AI agent to implement the changes
    await runAgent({
      workspace,
      title: job.title,
      description: job.description,
      agentRunId: job.agentRunId,
      ticketId: job.ticketId,
    });

    // 4. Commit changes (if any)
    const status = await git.status();
    if (!status.isClean()) {
      await git.add(".");
      await git.commit(
        `[ADD Agent] ${job.title}\n\nAgent-Run-ID: ${job.agentRunId}`,
      );
      await logProgress(
        job.agentRunId,
        job.ticketId,
        "commit",
        "Changes committed",
      );
      console.log("Changes committed");
    } else {
      await logProgress(
        job.agentRunId,
        job.ticketId,
        "action",
        "No changes needed",
      );
      console.log("No changes to commit");
    }

    // 5. Push branch (only if we have commits)
    await logProgress(
      job.agentRunId,
      job.ticketId,
      "action",
      `Pushing to remote (${runBranchName})`,
    );
    await git.push("origin", runBranchName, ["--set-upstream"]);
    await markAgentRunPushed(job.agentRunId, runBranchName);
    console.log("Pushed to GitHub");

    // 6. Create PR
    await logProgress(
      job.agentRunId,
      job.ticketId,
      "thinking",
      "Creating pull request",
    );
    const prUrl = await createPullRequest(
      job.repoUrl,
      runBranchName,
      `[ADD Agent] ${job.title}`,
      `## Summary

This PR was created by the ADD (Agent Driven Development) platform.

**Original ticket:**
${job.description}

---

Agent-Run-ID: \`${job.agentRunId}\`
*Generated by ADD Agent*`,
      job.installationId,
    );
    console.log(`PR created: ${prUrl}`);

    // 7. Update ticket and agent run
    await logProgress(
      job.agentRunId,
      job.ticketId,
      "complete",
      `PR created: ${prUrl}`,
      { prUrl },
    );
    await updateTicketStatus(job.ticketId, "review");
    await updateAgentRun(job.agentRunId, "complete", undefined, prUrl);

    console.log("Agent completed successfully!");
    process.exit(0);
  } catch (error) {
    const errorMessage = extractErrorMessage(error);
    console.error("Agent failed:", errorMessage);
    console.error("Full error:", error);

    // Log detailed error to progress logs for user visibility
    await logProgress(job.agentRunId, job.ticketId, "error", errorMessage);

    // Update agent run as failed
    await updateAgentRun(job.agentRunId, "failed", errorMessage);

    // Update ticket status back to queued so user can retry
    // (keeping it in-progress would be misleading since agent is dead)
    await updateTicketStatus(job.ticketId, "queued");

    process.exit(1);
  }
}

main();
