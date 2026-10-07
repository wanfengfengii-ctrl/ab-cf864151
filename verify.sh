#!/bin/sh
# verify：以退出码汇总 代码测试 + 生产构建 + 冒烟（并发上报与断线续接）
# 用法：BASE_URL=http://app:8080 sh verify.sh
set -u
fail=0

echo "━━━━━━━━━━━━━━━━ [1/3] 代码测试 ━━━━━━━━━━━━━━━━"
if node --test; then
  echo "→ 代码测试 PASS"
else
  echo "→ 代码测试 FAIL"
  fail=1
fi

echo "━━━━━━━━━━━━━━━━ [2/3] 生产构建 ━━━━━━━━━━━━━━━━"
if node scripts/build.js; then
  echo "→ 生产构建 PASS"
else
  echo "→ 生产构建 FAIL"
  fail=1
fi

echo "━━━━━━━━━━━━━━━━ [3/3] 冒烟：并发上报与断线续接 ━━━━━━━━━━━━━━━━"
if BASE_URL="${BASE_URL:-http://127.0.0.1:8080}" node scripts/smoke.js; then
  echo "→ 冒烟 PASS"
else
  echo "→ 冒烟 FAIL"
  fail=1
fi

echo "━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━"
if [ "$fail" -eq 0 ]; then
  echo "VERIFY PASS：代码测试、生产构建、冒烟全部通过"
else
  echo "VERIFY FAIL：存在失败环节"
fi
exit "$fail"
