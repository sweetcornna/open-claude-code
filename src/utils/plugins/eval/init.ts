/**
 * `occ plugin eval init <name>` — scaffold a case.
 *
 * The template is the documentation most authors will actually read, so it
 * ships with a working deterministic assertion and leaves the judge commented
 * out. Someone who never opens the docs still ends up with a case that costs
 * one model call per run instead of two, and the comment explains what the
 * second one would buy them.
 */

import { existsSync, mkdirSync, writeFileSync } from 'fs'
import { join } from 'path'
import {
  CASE_FILE_NAME,
  CASE_NAME_PATTERN,
  EVALS_DIR_NAME,
} from './discovery.js'

/** Blank-but-runnable case. Every field the schema accepts is mentioned. */
export function caseTemplate(name: string): string {
  return `# Eval case for \`occ plugin eval\`.
#
# Run it from the plugin root:   occ plugin eval .
# See what it would cost first:  occ plugin eval . --dry-run
#
# Each case runs twice per repetition: once with the plugin loaded and once
# without. The reported number is the difference — that is what says whether
# the plugin helped.

name: ${name}
description: TODO — one line on what this case is probing.
tags: []

# What the agent is asked to do. Use \`prompt_file: prompt.md\` instead if it
# is long enough to deserve its own file.
prompt: |
  TODO — describe the task.

# Optional directory copied into a fresh workspace before every run, so each
# repetition starts from identical state.
# files: files

runs: 1
max_turns: 12

# Tools the agent may use. Read, Grep, Glob, Write, Edit and Skill are granted
# on the case's own authority; Bash, WebFetch, WebSearch and MCP tools also
# need --allow-tools from whoever runs the eval.
allowed_tools: [Read, Glob, Grep, Write, Edit, Skill]

# Deterministic checks. These cost nothing and are the preferred way to grade.
assert:
  - type: file_exists
    path: TODO.md

  # Did the plugin's skill actually fire? \`skill_used\` is reported but not
  # scored, because it can only ever pass in the with-plugin arm — scoring it
  # would manufacture a positive delta out of a tautology.
  # - type: skill_used
  #   skill: TODO-skill-name

  # - type: file_matches
  #   path: TODO.md
  #   pattern: '^## Done'
  # - type: output_matches
  #   pattern: 'finished'
  # - type: command          # needs --allow-assert-commands
  #   run: 'npm test'
  #   expect_exit_code: 0

# Optional LLM grader. Costs one extra model call per run, per arm. Add it only
# for qualities a regex genuinely cannot see — tone, structure, judgement.
# judge:
#   rubric: |
#     TODO — describe what a good answer looks like.
#   weight: 1
`
}

export type InitResult =
  | { ok: true; path: string }
  | { ok: false; error: string }

/** Create `evals/<name>/case.yaml` under `cwd`. Never overwrites. */
export function scaffoldCase(cwd: string, name: string): InitResult {
  if (!CASE_NAME_PATTERN.test(name)) {
    return {
      ok: false,
      error: `case name "${name}" is invalid — use letters, digits, '.', '_', '-' only`,
    }
  }
  const dir = join(cwd, EVALS_DIR_NAME, name)
  const file = join(dir, CASE_FILE_NAME)
  if (existsSync(file)) {
    return { ok: false, error: `${file} already exists` }
  }
  try {
    mkdirSync(dir, { recursive: true })
    writeFileSync(file, caseTemplate(name))
    return { ok: true, path: file }
  } catch (error) {
    return {
      ok: false,
      error: error instanceof Error ? error.message : String(error),
    }
  }
}
