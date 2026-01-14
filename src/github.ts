import { createAppAuth } from "@octokit/auth-app";
import { Octokit } from "@octokit/rest";

// GitHub App credentials from environment
const appId = process.env.GITHUB_APP_ID!;
const privateKey = process.env.GITHUB_APP_PRIVATE_KEY!;

// Create authenticated Octokit instance for a specific installation
export function createOctokit(installationId: string): Octokit {
  return new Octokit({
    authStrategy: createAppAuth,
    auth: {
      appId,
      privateKey,
      installationId,
    },
  });
}

// Get authenticated clone URL for a repo
export async function getAuthenticatedCloneUrl(
  repoUrl: string,
  installationId: string,
): Promise<string> {
  // Get installation access token
  const auth = createAppAuth({
    appId,
    privateKey,
    installationId,
  });

  const { token } = await auth({ type: "installation" });

  // Convert https://github.com/owner/repo to https://x-access-token:TOKEN@github.com/owner/repo.git
  const url = new URL(repoUrl);
  url.username = "x-access-token";
  url.password = token;
  if (!url.pathname.endsWith(".git")) {
    url.pathname += ".git";
  }

  return url.toString();
}

// Create a pull request
export async function createPullRequest(
  repoUrl: string,
  branchName: string,
  title: string,
  body: string,
  installationId: string,
): Promise<string> {
  const octokit = createOctokit(installationId);

  // Parse owner/repo from URL
  const match = repoUrl.match(/github\.com\/([^/]+)\/([^/]+?)(?:\.git)?$/);
  if (!match) {
    throw new Error(`Invalid GitHub URL: ${repoUrl}`);
  }
  const [, owner, repo] = match;

  // Get default branch
  const { data: repoData } = await octokit.repos.get({ owner, repo });
  const baseBranch = repoData.default_branch;

  console.log(`Default branch for ${owner}/${repo}: ${baseBranch}`);

  // Create PR
  const { data: pr } = await octokit.pulls.create({
    owner,
    repo,
    title,
    body,
    head: branchName,
    base: baseBranch,
  });

  return pr.html_url;
}
