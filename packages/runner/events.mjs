// Workbench harness event protocol.
//
// Any program Workbench runs as an agent gets two env vars:
//   WORKBENCH_HOOK_URL    http://127.0.0.1:<port>/hook/<session id>
//   WORKBENCH_HOOK_TOKEN  per-session secret, sent as the X-Workbench-Hook header
// POST JSON events with Claude Code's hook shape and Workbench treats the
// harness like Claude Code: live status, changelog entries, error tracking
// and search all work. The events that matter:
//   SessionStart                                   ready
//   UserPromptSubmit   { prompt }                  working
//   PreToolUse         { tool_name, tool_input }   working, shows the tool
//   PostToolUse        { tool_name }               working
//   PostToolUseFailure { tool_name, tool_input, error }   recorded as an error
//   Notification       { message }                 needs the user (e.g. a permission prompt)
//   Stop               { last_assistant_message }  turn done; feeds the changelog
// Outside Workbench (no env vars) emit() is a no-op.

const url = process.env.WORKBENCH_HOOK_URL;
const token = process.env.WORKBENCH_HOOK_TOKEN;

export async function emit(event, fields = {}) {
  if (!url || !token) return;
  try {
    await fetch(url, {
      method: 'POST',
      headers: { 'content-type': 'application/json', 'x-workbench-hook': token },
      body: JSON.stringify({ hook_event_name: event, ...fields }),
      signal: AbortSignal.timeout(2000),
    });
  } catch {
    // Workbench unreachable: the agent keeps working, status just won't update.
  }
}

export const dim = (s) => `\x1b[2m${s}\x1b[0m`;
export const bold = (s) => `\x1b[1m${s}\x1b[0m`;
export const red = (s) => `\x1b[31m${s}\x1b[0m`;
export const cyan = (s) => `\x1b[36m${s}\x1b[0m`;
