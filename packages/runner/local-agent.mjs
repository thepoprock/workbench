#!/usr/bin/env node
// Local-model agent for Workbench: a small tool-using loop against any
// OpenAI-compatible chat endpoint (Ollama, LM Studio, llama.cpp server).
// Config comes from WB_HARNESS_CONFIG (JSON: { baseUrl, model, apiKey? }).
// Tools: list_files, read_file, write_file, run_command — writes and commands
// ask for confirmation. Paths are confined to the working directory.

import { exec } from 'node:child_process';
import { mkdirSync, readFileSync, readdirSync, statSync, writeFileSync } from 'node:fs';
import { dirname, relative, resolve } from 'node:path';
import readline from 'node:readline/promises';
import { bold, cyan, dim, emit, red } from './events.mjs';

const cfg = JSON.parse(process.env.WB_HARNESS_CONFIG || '{}');
const baseUrl = (cfg.baseUrl || 'http://localhost:11434/v1').replace(/\/+$/, '');
let model = cfg.model || 'llama3.1';
const cwd = process.cwd();
const MAX_STEPS = 20;
const MAX_OUTPUT = 20_000;

const SYSTEM = `You are a coding assistant working in ${cwd}. Use the tools to look at files and run commands when that helps; paths are relative to that directory. Be concise.`;

const tools = [
  fn('list_files', 'List files and folders in a directory.', { path: { type: 'string', description: 'Directory, default "."' } }, []),
  fn('read_file', 'Read a text file.', { path: { type: 'string' } }, ['path']),
  fn('write_file', 'Create or overwrite a text file (the user confirms).', { path: { type: 'string' }, content: { type: 'string' } }, ['path', 'content']),
  fn('run_command', 'Run a shell command in the working directory (the user confirms).', { command: { type: 'string' } }, ['command']),
];

function fn(name, description, properties, required) {
  return { type: 'function', function: { name, description, parameters: { type: 'object', properties, required } } };
}

const rl = readline.createInterface({ input: process.stdin, output: process.stdout });
let messages = [{ role: 'system', content: SYSTEM }];

function inside(p) {
  const full = resolve(cwd, p || '.');
  const rel = relative(cwd, full);
  if (rel.startsWith('..') || resolve(cwd, rel) !== full) throw new Error(`path is outside ${cwd}: ${p}`);
  return full;
}

const clip = (s) => (s.length > MAX_OUTPUT ? `${s.slice(0, MAX_OUTPUT)}\n…(truncated)` : s);

async function confirm(what) {
  await emit('Notification', { message: `needs your OK to ${what}` });
  const a = (await rl.question(`${bold('Allow?')} ${what} ${dim('[y/N]')} `)).trim().toLowerCase();
  return a === 'y' || a === 'yes';
}

async function runTool(name, args) {
  switch (name) {
    case 'list_files': {
      const dir = inside(args.path);
      return readdirSync(dir)
        .map((f) => (statSync(resolve(dir, f)).isDirectory() ? `${f}/` : f))
        .join('\n');
    }
    case 'read_file':
      return clip(readFileSync(inside(args.path), 'utf8'));
    case 'write_file': {
      const p = inside(args.path);
      if (!(await confirm(`write ${relative(cwd, p)} (${String(args.content ?? '').length} chars)`))) throw new Error('user declined');
      mkdirSync(dirname(p), { recursive: true });
      writeFileSync(p, String(args.content ?? ''));
      return `wrote ${relative(cwd, p)}`;
    }
    case 'run_command': {
      if (!(await confirm(`run: ${args.command}`))) throw new Error('user declined');
      return await new Promise((done, fail) =>
        exec(args.command, { cwd, timeout: 120_000, maxBuffer: 4 * 1024 * 1024 }, (err, stdout, stderr) => {
          const out = clip(`${stdout}${stderr ? `\n${stderr}` : ''}`.trim());
          if (err) fail(new Error(`Exit code ${err.code ?? 1}\n${out}`));
          else done(out || '(no output)');
        }),
      );
    }
    default:
      throw new Error(`unknown tool ${name}`);
  }
}

async function chat() {
  const res = await fetch(`${baseUrl}/chat/completions`, {
    method: 'POST',
    headers: { 'content-type': 'application/json', ...(cfg.apiKey ? { authorization: `Bearer ${cfg.apiKey}` } : {}) },
    body: JSON.stringify({ model, messages, tools, stream: false }),
  });
  if (!res.ok) throw new Error(`${res.status} ${res.statusText}: ${(await res.text()).slice(0, 300)}`);
  const data = await res.json();
  const msg = data.choices?.[0]?.message;
  if (!msg) throw new Error('empty response from model server');
  return msg;
}

async function turn(prompt) {
  await emit('UserPromptSubmit', { prompt });
  messages.push({ role: 'user', content: prompt });
  let last = '';
  for (let step = 0; step < MAX_STEPS; step++) {
    const msg = await chat();
    messages.push(msg);
    if (msg.content) {
      last = msg.content;
      console.log(`\n${msg.content.trim()}\n`);
    }
    const calls = msg.tool_calls ?? [];
    if (!calls.length) break;
    for (const call of calls) {
      const name = call.function?.name ?? '?';
      let args = {};
      try {
        args = JSON.parse(call.function?.arguments || '{}');
      } catch {}
      const summary = args.command ?? args.path ?? '';
      console.log(cyan(`⏺ ${name}`) + dim(summary ? ` ${summary}` : ''));
      await emit('PreToolUse', { tool_name: name, tool_input: args });
      let content;
      try {
        content = await runTool(name, args);
        await emit('PostToolUse', { tool_name: name, tool_input: args });
        console.log(dim(`  ${content.split('\n').slice(0, 4).join('\n  ')}${content.split('\n').length > 4 ? '\n  …' : ''}`));
      } catch (err) {
        content = `Error: ${err.message}`;
        await emit('PostToolUseFailure', { tool_name: name, tool_input: args, error: err.message });
        console.log(red(`  ${err.message.split('\n')[0]}`));
      }
      messages.push({ role: 'tool', tool_call_id: call.id, name, content });
    }
  }
  await emit('Stop', { last_assistant_message: last });
}

async function main() {
  console.log(`${bold('Local model agent')} ${dim(`· ${model} · ${baseUrl}`)}`);
  try {
    const r = await fetch(`${baseUrl}/models`, { signal: AbortSignal.timeout(3000) });
    if (!r.ok) throw new Error(String(r.status));
  } catch {
    console.log(red(`Can't reach ${baseUrl}. Start your model server (e.g. "ollama serve") or change the harness URL.`));
  }
  console.log(dim('Commands: /model <name>, /clear, /exit\n'));
  await emit('SessionStart', { source: 'startup' });
  for (;;) {
    const line = (await rl.question(bold('› '))).trim();
    if (!line) continue;
    if (line === '/exit') break;
    if (line === '/clear') {
      messages = [{ role: 'system', content: SYSTEM }];
      console.log(dim('conversation cleared'));
      continue;
    }
    if (line.startsWith('/model ')) {
      model = line.slice(7).trim();
      console.log(dim(`model: ${model}`));
      continue;
    }
    try {
      await turn(line);
    } catch (err) {
      console.log(red(`Model request failed: ${err.message}`));
      await emit('Stop', { last_assistant_message: '' });
    }
  }
  await emit('SessionEnd', { reason: 'exit' });
  rl.close();
}

void main();
