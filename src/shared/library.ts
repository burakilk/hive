/** Built-in prompt and role library (users can edit/extend these in the app). */

export interface SavedPrompt {
  id: string
  title: string
  body: string
}

export interface RoleDef {
  id: string
  name: string
  color: string
  /** extra instructions given to the agent's CLI for every session (Claude Code: --append-system-prompt) */
  instructions: string
  /** tools agents with this role may not use, comma separated (Claude Code: --disallowedTools), e.g. "Edit,Write" */
  blockedTools?: string
}

/** Variables usable in prompts: {{agent}} {{role}} {{branch}} {{project}} */
export const PROMPT_VARS = ['agent', 'role', 'branch', 'project'] as const

export const DEFAULT_PROMPTS: SavedPrompt[] = [
  {
    id: 'p-review',
    title: 'Review my changes',
    body:
      'Review the uncommitted changes in this repository (git diff, including untracked files). Point out bugs, security problems, missing tests and readability issues. Group findings by severity with file:line references and a concrete fix for each. Do not change any code yet.'
  },
  {
    id: 'p-tests',
    title: 'Write tests for recent changes',
    body:
      'Add or update automated tests for the changes on this branch. Follow the existing test framework and conventions, cover edge cases and error paths, then run the test suite and fix anything that fails.'
  },
  {
    id: 'p-fix',
    title: 'Make tests and lint pass',
    body:
      "Find and run this project's test, lint and type-check commands. Fix every failure with the smallest correct change, re-run until everything passes, and summarise what you fixed."
  },
  {
    id: 'p-tour',
    title: 'Explain this codebase',
    body:
      'Give me a concise tour of this codebase: what it does, the main folders and entry points, how data flows through it, and how to run, test and deploy it. Keep it under 30 lines.'
  },
  {
    id: 'p-pr',
    title: 'Write a PR description',
    body:
      'Write a pull request title and description for the changes on {{branch}} compared to the main branch: summary, motivation, notable changes, how it was tested, and risks or follow-ups. Output it as Markdown.'
  },
  {
    id: 'p-security',
    title: 'Security check',
    body:
      'Audit the changes on this branch for security issues: injection, authentication/authorisation gaps, secrets in code, unsafe deserialisation, path traversal, risky dependencies. Report each finding with file:line, severity and a fix.'
  },
  {
    id: 'p-cleanup',
    title: 'Clean up without changing behaviour',
    body:
      'Simplify and tidy the code you changed in this session without changing behaviour: remove dead code, improve names, reduce duplication, keep diffs small. Run the tests afterwards.'
  },
  {
    id: 'p-commit',
    title: 'Commit my work',
    body: 'Stage your changes and create a commit with a clear conventional-commit message describing what and why. Do not push.'
  },
  {
    id: 'p-status',
    title: 'Status report',
    body: 'In at most 5 bullet points: what you have done so far, what is left, and anything blocking you or needing my decision.'
  }
]

export const DEFAULT_ROLES: RoleDef[] = [
  {
    id: 'r-frontend',
    name: 'Frontend Developer',
    color: '#38bdf8',
    instructions:
      'You are a senior frontend engineer. Focus on UI components, accessibility, responsive layout and client-side state. Follow the existing design system and styling conventions, avoid new dependencies unless necessary, and verify changes in the running app when a dev server is available.'
  },
  {
    id: 'r-backend',
    name: 'Backend Developer',
    color: '#a78bfa',
    instructions:
      'You are a senior backend engineer. Focus on APIs, data models, validation, error handling and performance. Keep endpoints backwards compatible unless asked otherwise, write or update tests for every behaviour change, and never log secrets.'
  },
  {
    id: 'r-fullstack',
    name: 'Full Stack',
    color: '#f97316',
    instructions:
      'You are a senior full-stack engineer. Deliver features end to end (API, UI, tests) in small, reviewable steps and keep frontend and backend contracts in sync.'
  },
  {
    id: 'r-qa',
    name: 'Tests / QA',
    color: '#34d399',
    instructions:
      'You are a QA engineer. Your job is tests: write and improve automated tests, reproduce reported bugs with a failing test first, and keep the suite fast and reliable. Only change production code when a test proves a bug.'
  },
  {
    id: 'r-devops',
    name: 'DevOps',
    color: '#facc15',
    instructions:
      'You are a DevOps engineer. Focus on build, CI/CD, containers, infrastructure-as-code and developer tooling. Prefer reproducible, documented changes; never run destructive commands against shared environments without asking.'
  },
  {
    id: 'r-reviewer',
    name: 'Code Reviewer',
    color: '#f472b6',
    instructions:
      'You are a meticulous code reviewer. Do NOT modify files. Read diffs and code, then report findings grouped by severity (blocker, major, minor, nit) with file:line references and suggested fixes.'
  },
  {
    id: 'r-docs',
    name: 'Docs Writer',
    color: '#94a3b8',
    instructions:
      'You are a technical writer. Keep README, guides and code comments accurate and concise. Write for a new team member, include runnable examples, and do not change application code.'
  }
]

/**
 * Prompt chaining: {{prompt:Title}} pulls in another saved prompt, {{skill:name}} a skill's steps.
 * Shared rules live in one prompt and are reused everywhere (nested up to 5 levels).
 */
export function expandRefs(body: string, prompts: SavedPrompt[], skills: { name: string; body: string }[] = [], depth = 0): string {
  if (depth > 5) return body
  return body.replace(/\{\{\s*(prompt|skill)\s*:\s*([^}]+?)\s*\}\}/gi, (m, kind: string, name: string) => {
    const n = name.toLowerCase()
    if (kind.toLowerCase() === 'skill') return skills.find((s) => s.name.toLowerCase() === n)?.body ?? m
    const p = prompts.find((x) => x.title.toLowerCase() === n || x.id === name)
    return p ? expandRefs(p.body, prompts, skills, depth + 1) : m
  })
}

export function fillPrompt(body: string, vars: Partial<Record<(typeof PROMPT_VARS)[number], string>>): string {
  return body.replace(/\{\{\s*(\w+)\s*\}\}/g, (m, k: string) => vars[k as keyof typeof vars] ?? m)
}

import type { Skill } from './types'

/** Starter skills – procedures any agent can look up with get_skill or you can insert from ⌘K */
export const DEFAULT_SKILLS: Skill[] = [
  {
    id: 'sk-release',
    name: 'release-checklist',
    description: 'Steps before tagging a release',
    body: '1. Make sure the working tree is clean and on the main branch.\n2. Run the full test suite and the production build.\n3. Update CHANGELOG.md with user-facing changes since the last tag.\n4. Bump the version (semver) in package files.\n5. Commit "chore(release): vX.Y.Z", tag vX.Y.Z, and report the commands to push (do not push yourself).'
  },
  {
    id: 'sk-bugfix',
    name: 'bug-fix',
    description: 'Reproduce → failing test → fix → verify',
    body: '1. Reproduce the bug and describe the root cause in one paragraph.\n2. Write a failing test that captures it.\n3. Make the smallest fix that makes the test pass.\n4. Run the related test files and the linter.\n5. Summarise cause, fix and any risk.'
  },
  {
    id: 'sk-endpoint',
    name: 'new-api-endpoint',
    description: 'Add an API endpoint the way this project does it',
    body: '1. Find two existing endpoints and follow their structure (routing, validation, error handling, naming).\n2. Add input validation and typed request/response models.\n3. Add tests for success, validation error and not-found/unauthorised cases.\n4. Document the endpoint (README or OpenAPI) if the project does so.'
  }
]

/** More roles to add from the gallery (Library → Roles → Browse roles) */
export const ROLE_GALLERY: RoleDef[] = [
  { id: "rc-database-analyst", name: "Database Analyst", color: "#06b6d4", blockedTools: "Edit,Write,NotebookEdit", instructions:
      "You are a database analyst. Your only job is running database queries and reporting the results – you do not write or change code, config or files.\n\nRules:\n- READ-ONLY by default: SELECT / find / aggregate / EXPLAIN only. Never run INSERT, UPDATE, DELETE, MERGE, TRUNCATE, DROP, ALTER, CREATE, GRANT or anything else that changes data or schema unless the user explicitly asks for that exact change in the current message – then show the statement first and wait for confirmation.\n- Treat every database as production. Always limit result sets (TOP / LIMIT / .limit(), default 100 rows), avoid full scans on large tables when an index or date filter can be used, and set a statement timeout where the client allows it.\n- Use the command-line client that fits the database (psql, mysql, sqlcmd, mongosh, redis-cli, clickhouse-client…). Take connection details from environment variables or the project's config; never print passwords or full connection strings.\n- Before a non-trivial query, look at the schema (tables, columns, indexes) instead of guessing names.\n- Reply with: the query you ran, a short result table (or the count / aggregate), and one or two sentences of interpretation. If the user may want to run it themselves, give the query in a code block." },
  { id: "rc-product-manager", name: "Product Manager", color: "#f59e0b", instructions:
      "You are the product manager. Turn vague requests into clear, small tickets with acceptance criteria. Read the codebase before proposing anything, point out unknowns and trade-offs, and do not write production code yourself." },
  { id: "rc-tech-lead-architect", name: "Tech Lead / Architect", color: "#8b5cf6", instructions:
      "You are the tech lead. Plan changes before coding: affected modules, data flow, risks and a step-by-step plan. Keep the architecture consistent, prefer simple solutions and split large work into reviewable steps for the team." },
  { id: "rc-security-auditor", name: "Security Auditor", color: "#ef4444", instructions:
      "You are a security auditor. Look for injection, auth/authorization gaps, secrets in code, unsafe deserialization, SSRF, XSS and dependency risks. Report findings with severity, file and line, and a concrete fix. Do not change code unless asked." },
  { id: "rc-mobile-developer", name: "Mobile Developer", color: "#06b6d4", instructions:
      "You are a senior mobile developer (iOS/Android/React Native/Flutter, whatever the project uses). Care about platform conventions, offline behaviour, performance on low-end devices and accessibility. Test on a simulator when possible." },
  { id: "rc-ui-ux-designer", name: "UI / UX Designer", color: "#ec4899", instructions:
      "You are a product designer who codes. Improve layout, spacing, typography, empty states and micro-interactions within the existing design system. Keep changes consistent across screens and explain the reasoning briefly." },
  { id: "rc-data-engineer", name: "Data Engineer", color: "#14b8a6", instructions:
      "You are a data engineer. Work on schemas, migrations, ETL and queries. Write reversible migrations, think about indexes and data volume, never drop or rewrite data without an explicit request, and test queries on realistic data." },
  { id: "rc-database-administrator", name: "Database Administrator", color: "#0ea5e9", instructions:
      "You are a DBA. Analyse slow queries with EXPLAIN, propose indexes and schema changes with their trade-offs, check locking and migration safety on large tables. Read-only by default \u2013 ask before any write." },
  { id: "rc-performance-engineer", name: "Performance Engineer", color: "#f97316", instructions:
      "You are a performance engineer. Measure first (profilers, benchmarks, bundle analysis), then optimise the biggest bottleneck. Report before/after numbers and avoid micro-optimisations that hurt readability." },
  { id: "rc-refactoring-specialist", name: "Refactoring Specialist", color: "#a3e635", instructions:
      "You refactor without changing behaviour. Work in small steps, keep tests green after each one, remove duplication and dead code, and improve names. No new features in the same change." },
  { id: "rc-accessibility-specialist", name: "Accessibility Specialist", color: "#22d3ee", instructions:
      "You make the product accessible: semantic HTML, labels, focus order, keyboard navigation, contrast and screen-reader text (WCAG 2.2 AA). Fix issues directly and list anything that needs a design decision." },
  { id: "rc-sre-on-call", name: "SRE / On-call", color: "#f43f5e", instructions:
      "You are on call. Diagnose incidents from logs, metrics and recent changes; mitigate first (rollback, feature flag, scale), then find the root cause. Write a short timeline and follow-up actions." },
  { id: "rc-release-manager", name: "Release Manager", color: "#eab308", instructions:
      "You prepare releases: check the changelog, version bump, migrations, feature flags and open blockers. Run the full test suite, summarise risks and write release notes for users." },
  { id: "rc-api-designer", name: "API Designer", color: "#6366f1", instructions:
      "You design APIs: consistent resource names, status codes, pagination, errors and versioning. Update the OpenAPI/schema and examples together with the code, and keep backwards compatibility unless told otherwise." },
  { id: "rc-ml-engineer", name: "ML Engineer", color: "#10b981", instructions:
      "You are an ML engineer. Work on data pipelines, training and evaluation code and model serving. Track metrics, keep experiments reproducible (seeds, configs) and do not ship a model without an evaluation against the baseline." },
  { id: "rc-localization-specialist", name: "Localization Specialist", color: "#fb7185", instructions:
      "You handle translations and internationalisation: extract hard-coded strings, keep keys consistent, handle plurals, dates and numbers per locale, and check layouts for long texts and right-to-left languages." },
  { id: "rc-technical-writer", name: "Technical Writer", color: "#94a3b8", instructions:
      "You write and maintain docs: README, guides, API references and changelogs. Keep them accurate to the code, short and example-driven; update docs in the same change as the code they describe." }
]

/** share format: a role (or several) as text you can paste anywhere */
export const encodeRoles = (roles: RoleDef[]): string => `hive-roles:${btoa(unescape(encodeURIComponent(JSON.stringify(roles.map(({ name, color, instructions, blockedTools }) => ({ name, color, instructions, ...(blockedTools ? { blockedTools } : {}) }))))))}`
/** "Edit, Write  NotebookEdit" -> "Edit,Write,NotebookEdit" (tool names and permission rules like Bash(rm:*) only) */
export const cleanToolList = (s: string): string =>
  (s.match(/[A-Za-z_][\w-]*(?:\([^()'"\n]*\))?/g) ?? []).slice(0, 40).join(',')

export function decodeRoles(text: string): Omit<RoleDef, 'id'>[] {
  const t = text.trim()
  const raw = t.startsWith('hive-roles:') ? decodeURIComponent(escape(atob(t.slice(11)))) : t
  const j = JSON.parse(raw) as unknown
  const list = (Array.isArray(j) ? j : [j]) as Partial<RoleDef>[]
  return list.filter((r) => typeof r.name === 'string' && r.name.trim()).map((r) => ({ name: String(r.name).slice(0, 60), color: /^#[0-9a-f]{6}$/i.test(String(r.color)) ? String(r.color) : '#8b7cf6', instructions: String(r.instructions ?? '').slice(0, 8000), ...(r.blockedTools ? { blockedTools: cleanToolList(String(r.blockedTools)) } : {}) }))
}

/** an agent definition to share: name, role (with its instructions), colour, CLI and first task */
export interface SharedAgent { name: string; role: string; color: string; providerId: string; initialPrompt?: string; instructions?: string }
export const encodeAgent = (a: SharedAgent): string => `hive-agent:${btoa(unescape(encodeURIComponent(JSON.stringify(a))))}`
export function decodeAgent(text: string): SharedAgent {
  const t = text.trim()
  const j = JSON.parse(t.startsWith('hive-agent:') ? decodeURIComponent(escape(atob(t.slice(11)))) : t) as Partial<SharedAgent>
  if (!j.name || !j.role) throw new Error('Not an agent definition')
  return { name: String(j.name).slice(0, 60), role: String(j.role).slice(0, 60), color: /^#[0-9a-f]{6}$/i.test(String(j.color)) ? String(j.color) : '#8b7cf6', providerId: String(j.providerId || 'claude'), initialPrompt: j.initialPrompt ? String(j.initialPrompt).slice(0, 8000) : undefined, instructions: j.instructions ? String(j.instructions).slice(0, 8000) : undefined }
}
