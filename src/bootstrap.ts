/**
 * Bootstrap file that patches globalThis.fetch BEFORE any other modules load.
 * 
 * Node 20's native fetch has a hardcoded ~5 minute (300 second) headers timeout.
 * This causes the agent to fail during long-running operations when there are
 * pauses between responses (e.g., SSE streams, long API calls).
 * 
 * We replace globalThis.fetch with undici's fetch configured with no timeouts.
 * This MUST happen before any other modules are imported, because they may
 * capture a reference to fetch at import time.
 */
import { Agent, fetch as undiciFetch } from "undici";

const noTimeoutAgent = new Agent({
  headersTimeout: 0,     // Disable headers timeout (default is 300s)
  bodyTimeout: 0,        // Disable body timeout
  connectTimeout: 30_000, // 30s connect timeout is reasonable
});

// Replace global fetch with undici fetch using our custom agent
// eslint-disable-next-line @typescript-eslint/no-explicit-any
(globalThis as any).fetch = (input: RequestInfo | URL, init?: RequestInit) => {
  const url = typeof input === "string" 
    ? input 
    : input instanceof URL 
      ? input.toString() 
      : input.url;
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  return undiciFetch(url, { ...init, dispatcher: noTimeoutAgent } as any);
};

console.log("Patched globalThis.fetch with undici (no timeout)");

// Now dynamically import the main module
import("./index.js");
