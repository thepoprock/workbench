#!/usr/bin/env node
// Agent SDK starter harness for Workbench: a terminal chat around the Claude
// Agent SDK's query(). Copy this file, change the options (tools, system
// prompt, MCP servers, hooks) and point a Workbench "Agent SDK" harness at
// your copy. Config from WB_HARNESS_CONFIG (JSON: { model? }).
// Reference: https://platform.claude.com/docs/en/agent-sdk/overview

import readline from 'node:readline/promises';
import { query } from '@anthropic-ai/claude-agent-sdk';
import { bold, cyan, dim, emit, red } from './events.mjs';

const cfg = JSON.parse(process.env.WB_HARNESS_CONFIG || '{}');
const rl = readline.createInterface({ input: process.stdin, output: process.stdout });
let sessionId; // set from the first result; later turns resume the same conversation

// Ask in the terminal before any tool that needs permission.
async function canUseTool(toolName, input) {
  const what = `${toolName}${input.command ? `: ${input.command}` : input.file_path ? ` ${input.file_path}` : ''}`;
  await emit('Notification', { message: `needs your OK to use ${what}` });
  const a = (await rl.question(`${bold('Allow?')} ${what} ${dim('[y/N]')} `)).trim().toLowerCase();
  return a === 'y' || a === 'yes' ? { behavior: 'allow', updatedInput: input } : { behavior: 'deny', message: 'The user declined.' };
}

async function turn(prompt) {
  await emit('UserPromptSubmit', { prompt });
  let final = '';
  for await (const m of query({
    prompt,
    options: { cwd: process.cwd(), resume: sessionId, model: cfg.model || undefined, canUseTool },
  })) {
    if (m.type === 'assistant') {
      for (const block of m.message.content) {
        if (block.type === 'text' && block.text.trim()) console.log(`\n${block.text.trim()}\n`);
        if (block.type === 'tool_use') {
          const input = block.input ?? {};
          console.log(cyan(`⏺ ${block.name}`) + dim(` ${input.command ?? input.file_path ?? input.pattern ?? ''}`));
          await emit('PreToolUse', { tool_name: block.name, tool_input: input });
        }
      }
    } else if (m.type === 'result') {
      sessionId = m.session_id;
      if (m.subtype === 'success') final = m.result;
      else console.log(red(`Run ended: ${m.subtype}`));
      console.log(dim(`(${m.num_turns} turns · $${(m.total_cost_usd ?? 0).toFixed(4)})`));
    }
  }
  await emit('Stop', { last_assistant_message: final });
}

async function main() {
  console.log(`${bold('Agent SDK starter')} ${dim(`· ${cfg.model || 'default model'} · ${process.cwd()}`)}`);
  console.log(dim('Edit packages/runner/sdk-agent.mjs (or a copy) to build your own harness. /exit to quit.\n'));
  await emit('SessionStart', { source: 'startup' });
  for (;;) {
    const line = (await rl.question(bold('› '))).trim();
    if (!line) continue;
    if (line === '/exit') break;
    try {
      await turn(line);
    } catch (err) {
      console.log(red(`Agent error: ${err.message}`));
      await emit('Stop', { last_assistant_message: '' });
    }
  }
  await emit('SessionEnd', { reason: 'exit' });
  rl.close();
}

void main();
