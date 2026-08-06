#!/usr/bin/env bash
# 代码有变更却未暂存 README 时，拦截 git commit，提示先更新文档
set -euo pipefail

input=$(cat)
command=$(printf '%s' "$input" | jq -r '.command // empty')

# 仅处理 commit；push 由 Cursor rule 约束（文档应已在提交中）
if ! printf '%s' "$command" | grep -Eq '(^|[[:space:];&|])git[[:space:]]+commit([[:space:]]|$)'; then
  printf '%s\n' '{"permission":"allow"}'
  exit 0
fi

# 跳过 amend / 显式仅提交文档等特殊情况仍允许，但代码+缺 README 时拦截
if printf '%s' "$command" | grep -Eq -- '--amend'; then
  printf '%s\n' '{"permission":"allow"}'
  exit 0
fi

cd "$(git rev-parse --show-toplevel 2>/dev/null || pwd)"

staged=$(git diff --cached --name-only 2>/dev/null || true)
if [[ -z "$staged" ]]; then
  printf '%s\n' '{"permission":"allow"}'
  exit 0
fi

code_changed=$(printf '%s\n' "$staged" | grep -E '^(server/|public/|package\.json|pnpm-lock\.yaml|config\.example\.json)' || true)
readme_staged=$(printf '%s\n' "$staged" | grep -E '^README\.md$' || true)

if [[ -n "$code_changed" && -z "$readme_staged" ]]; then
  jq -n \
    --arg msg '本次暂存包含代码/配置变更，但未包含 README.md。请先按项目规则更新文档并 git add README.md，再重新 commit。' \
    '{permission:"deny", user_message:$msg, agent_message:$msg}'
  exit 0
fi

printf '%s\n' '{"permission":"allow"}'
exit 0
