#!/bin/sh
# verify 一次性服务入口：依次执行 生产构建 / 代码测试 / 冒烟（并发上报与断线续接），
# 以退出码汇总三类结果 —— 全部通过退出 0，任一失败退出 1。
fail=0

banner() { printf '\n========== %s ==========\n' "$1"; }

banner "[1/3] 生产构建 (tsc -> dist/)"
if npm run build; then
  echo ">> BUILD: PASS"
else
  echo ">> BUILD: FAIL"
  fail=1
fi

banner "[2/3] 代码测试 (node --test)"
if npm test; then
  echo ">> TESTS: PASS"
else
  echo ">> TESTS: FAIL"
  fail=1
fi

banner "[3/3] 冒烟：并发上报与断线续接 (BASE_URL=${BASE_URL:-http://127.0.0.1:8080})"
if node verify/smoke.mjs; then
  echo ">> SMOKE: PASS"
else
  echo ">> SMOKE: FAIL"
  fail=1
fi

banner "VERIFY 汇总"
if [ "$fail" -eq 0 ]; then
  echo "VERIFY RESULT: ALL PASS (exit 0)"
else
  echo "VERIFY RESULT: FAIL (exit 1)"
fi
exit "$fail"
