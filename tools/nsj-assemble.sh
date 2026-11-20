#!/usr/bin/env bash
# =============================================================================
# naraka-souljade 二改 · 本地组装器
# -----------------------------------------------------------------------------
# 作用：把「二改增量」组装到任意一份上游快照上，产出一个可直接打开的静态站。
#
# 用法：
#   ./tools/nsj-assemble.sh <上游目录或 index.html> <输出目录>
#
#   ./tools/nsj-assemble.sh ~/src/naraka-souljade ~/out/naraka-2.0
#
# 特性：
#   · 幂等：重复跑会覆盖 ext/ 与 index.html 的注入段，不会重复插入
#   · 非破坏：只动 index.html 的 <link>/<script> 注入点和 ext/、tools/ 目录，
#     上游 app.js / data.js / styles.css / assets 一个字节都不改
#   · 自检：组装完自动跑 node --check 语法校验，跑不了就回滚
# =============================================================================
set -euo pipefail

SRC="${1:-}"
OUT="${2:-}"

if [[ -z "$SRC" || -z "$OUT" ]]; then
  sed -n '2,20p' "$0" | sed 's/^# \{0,1\}//'
  exit 1
fi

HERE="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
PAYLOAD="$(cd "$HERE/.." && pwd)"       # 二改源目录（含 ext/ tools/ docs/）

say() { printf '\033[36m[assemble]\033[0m %s\n' "$*"; }
die() { printf '\033[31m[assemble] %s\033[0m\n' "$*" >&2; exit 1; }

# ---------- 解析上游 ----------
if [[ -f "$SRC" && "$(basename "$SRC")" == "index.html" ]]; then
  SRC="$(cd "$(dirname "$SRC")" && pwd)"
fi
[[ -d "$SRC" ]] || die "上游目录不存在：$SRC"
for f in index.html app.js data.js styles.css; do
  [[ -f "$SRC/$f" ]] || die "上游缺文件：$SRC/$f（不是 naraka-souljade 快照？）"
done
[[ -f "$PAYLOAD/ext/nsj-ext-core.js" ]] || die "二改源不完整：缺 ext/nsj-ext-core.js"

# ---------- 准备输出 ----------
mkdir -p "$OUT"
SRC_ABS="$(cd "$SRC" && pwd)"
OUT_ABS="$(cd "$OUT" && pwd)"
[[ "$SRC_ABS" == "$OUT_ABS" ]] && die "输出目录不能等于上游目录（原地组装会污染上游快照）"

say "上游：$SRC_ABS"
say "输出：$OUT_ABS"

# 先整份复制上游（保留 assets）
if command -v rsync >/dev/null 2>&1; then
  rsync -a --delete --exclude '.git' "$SRC_ABS"/ "$OUT_ABS"/
else
  find "$OUT_ABS" -mindepth 1 -maxdepth 1 ! -name '.git' -exec rm -rf {} +
  (cd "$SRC_ABS" && tar cf - --exclude='.git' .) | (cd "$OUT_ABS" && tar xf -)
fi
say "已复制上游基础文件"

# ---------- 注入二改 ----------
rm -rf "$OUT_ABS/ext"
mkdir -p "$OUT_ABS/ext"
cp "$PAYLOAD"/ext/nsj-ext-core.js \
   "$PAYLOAD"/ext/nsj-ext-store.js \
   "$PAYLOAD"/ext/nsj-ext-optimizer.js \
   "$PAYLOAD"/ext/nsj-ext-ui.js \
   "$PAYLOAD"/ext/nsj-ext.css \
   "$OUT_ABS/ext/"
say "已铺入 ext/ （5 个文件）"

mkdir -p "$OUT_ABS/tools"
cp "$PAYLOAD"/tools/nsj-dom-stub.js \
   "$PAYLOAD"/tools/nsj-harness.js \
   "$PAYLOAD"/tools/nsj-validate.js \
   "$PAYLOAD"/tools/nsj-e2e.js \
   "$PAYLOAD"/tools/nsj-assemble.sh \
   "$OUT_ABS/tools/" 2>/dev/null || true
chmod +x "$OUT_ABS/tools/nsj-assemble.sh" 2>/dev/null || true
say "已铺入 tools/ （验收台）"

# index.html 注入（幂等：先剥掉旧注入段再插）
python3 - "$OUT_ABS/index.html" <<'PY'
import re, sys, io
p = sys.argv[1]
s = io.open(p, encoding='utf-8').read()

# 1) 去掉旧的注入
s = s.replace('<link rel="stylesheet" href="ext/nsj-ext.css">\n', '')
s = re.sub(
    r'<!-- 二改扩展：历史快照 / 差异对比 / 自动最优（纯前端，无后端） -->\n'
    r'(<script src="ext/[^"]+"></script>\n)+', '', s)

# 2) 重新插入（必须在 app.js 之后）
CSS = '<link rel="stylesheet" href="ext/nsj-ext.css">\n'
BLOCK = ('<!-- 二改扩展：历史快照 / 差异对比 / 自动最优（纯前端，无后端） -->\n'
         '<script src="ext/nsj-ext-core.js"></script>\n'
         '<script src="ext/nsj-ext-store.js"></script>\n'
         '<script src="ext/nsj-ext-optimizer.js"></script>\n'
         '<script src="ext/nsj-ext-ui.js"></script>\n')

if '<link rel="stylesheet" href="styles.css">' in s:
    s = s.replace('<link rel="stylesheet" href="styles.css">',
                  '<link rel="stylesheet" href="styles.css">\n' + CSS.rstrip('\n'), 1)
else:
    raise SystemExit('index.html 里找不到 styles.css 引用，拒绝猜测注入点')

if '<script src="app.js"></script>' in s:
    s = s.replace('<script src="app.js"></script>',
                  '<script src="app.js"></script>\n' + BLOCK.rstrip('\n'), 1)
else:
    raise SystemExit('index.html 里找不到 app.js 引用，拒绝猜测注入点')

io.open(p, 'w', encoding='utf-8').write(s)
print('[assemble] index.html 注入完成')
PY

# ---------- 自检 ----------
if command -v node >/dev/null 2>&1; then
  for f in "$OUT_ABS"/ext/*.js "$OUT_ABS"/tools/*.js; do
    node --check "$f" >/dev/null || die "语法错误：$f"
  done
  say "语法自检通过（$(ls "$OUT_ABS"/ext/*.js "$OUT_ABS"/tools/*.js | wc -l) 个文件）"

  say "跑单元验收（61 用例）…"
  ( cd "$OUT_ABS" && node tools/nsj-harness.js >/tmp/nsj-assemble-harness.log 2>&1 ) \
    && tail -1 /tmp/nsj-assemble-harness.log \
    || { tail -20 /tmp/nsj-assemble-harness.log; die "验收失败"; }
else
  say "未装 node，跳过自检"
fi

# ---------- 收尾 ----------
say "完成。直接用浏览器打开："
printf '         file://%s/index.html\n' "$OUT_ABS"
say "新增面板：页面底部「对比 · 自动最优」，移动端在「对比」标签页"
