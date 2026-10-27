#!/usr/bin/env bash
# 端到端测试：bash test/e2e.sh <网盘地址> <管理员密码> [额外测试的挂载点...]
# 需要配合 test/docker-compose.test.yml（MinIO + WebDAV）运行
# 例：bash test/e2e.sh http://服务器IP:8080 密码 /123   —— 额外测试已在网页里添加好的 /123 挂载
# 脚本只会增删 /本地、/s3、/dav 三个测试挂载，不会动你自己添加的其他挂载
# 注意：macOS 自带 bash 3.2 在 "$(...)" 里处理 \" 有问题，所以 JSON 一律先用 json() 构造到变量里
set -u
BASE=${1:-http://127.0.0.1:8080}
PASS=${2:?用法: e2e.sh <地址> <管理员密码> [额外挂载点...]}
shift 2
EXTRA=("$@")
WORK=$(mktemp -d)
JAR=$WORK/cookie
PASSED=0
FAILED=0

ok() { echo "  ✓ $1"; PASSED=$((PASSED + 1)); }
bad() { echo "  ✗ $1"; FAILED=$((FAILED + 1)); }
check() { if [ "$2" = "$3" ]; then ok "$1"; else bad "$1（期望 $3，实际 $2）"; fi; }

req() { curl -s -b "$JAR" -c "$JAR" -H 'Content-Type: application/json' "$@"; }
# json k1 v1 k2 v2 ...：值为 true/false 输出布尔，以 [ 或 { 开头按 JSON 解析
json() { node -e 'const a=process.argv.slice(1),o={};for(let i=0;i<a.length;i+=2){const v=a[i+1];o[a[i]]=v==="true"?true:v==="false"?false:/^[[{]/.test(v)?JSON.parse(v):v}console.log(JSON.stringify(o))' "$@"; }
# code METHOD PATH BODY：返回 HTTP 状态码
code() { req -o /dev/null -w '%{http_code}' -X "$1" "$BASE$2" -d "$3"; }
jq_() { node -e 'let s="";process.stdin.on("data",d=>s+=d).on("end",()=>{const j=JSON.parse(s);const r=('"$1"');if(r!==undefined)console.log(r)})'; }
names() { req -G "$BASE/api/fs/list" --data-urlencode "path=$1" | jq_ 'j.items?j.items.map(i=>i.name).sort().join(","):"ERR "+j.error'; }
upload() { curl -s -b "$JAR" -o /dev/null -w '%{http_code}' -F "file=@$2" "$BASE/api/fs/upload?path=$(node -p 'encodeURIComponent(process.argv[1])' "$1")&size=$(wc -c <"$2" | tr -d ' ')"; }
download() { curl -s -b "$JAR" -L -o "$2" -w '%{http_code}' -G "$BASE/api/fs/download" --data-urlencode "path=$1" "${@:3}"; }
md5of() { if command -v md5sum >/dev/null; then md5sum "$1" | cut -d' ' -f1; else md5 -q "$1"; fi; }

echo "== 登录"
B=$(json username admin password wrong)
check "错误密码被拒绝" "$(code POST /api/login "$B")" 401
check "未登录访问被拒绝" "$(curl -s -o /dev/null -w '%{http_code}' "$BASE/api/fs/list?path=/")" 401
B=$(json username admin password "$PASS")
check "正确密码登录" "$(code POST /api/login "$B")" 200

echo "== 添加存储"
for id in $(req "$BASE/api/storages" | jq_ 'j.filter(x=>["/本地","/s3","/dav"].includes(x.mountPath)).map(x=>x.id).join(" ")'); do
  req -X DELETE "$BASE/api/storages/$id" >/dev/null
done
S3OPT='{"endpoint":"http://minio:9000","bucket":"pan-test","accessKeyId":"minioadmin","secretAccessKey":"minioadmin123","forcePathStyle":true,"downloadMode":"proxy"}'
B=$(json type local mountPath /本地 options '{"root":"/data/local"}')
check "挂载 /本地" "$(code POST /api/storages "$B")" 200
B=$(json type s3 mountPath /s3 options "$S3OPT")
check "挂载 /s3" "$(code POST /api/storages "$B")" 200
B=$(json type webdav mountPath /dav options '{"url":"http://webdav","username":"dav","password":"dav123"}')
check "挂载 /dav" "$(code POST /api/storages "$B")" 200
check "根目录包含三个测试挂载点" "$(names / | tr ',' '\n' | grep -cxE 'dav|s3|本地')" 3
check "存储列表里密钥已打码" "$(req "$BASE/api/storages" | grep -c 'minioadmin123')" 0

echo "测试 网盘 中文" >"$WORK/小文件.txt"
head -c 20971520 /dev/urandom >"$WORK/big.bin"
BIG_MD5=$(md5of "$WORK/big.bin")
tail -c +101 "$WORK/big.bin" | head -c 100 >"$WORK/exp.bin"
RANGE_MD5=$(md5of "$WORK/exp.bin")

for M in /本地 /s3 /dav ${EXTRA[@]+"${EXTRA[@]}"}; do
  echo "== $M"
  D="$M/测试目录"
  B=$(json paths "[\"$D\",\"$M/改名目录\"]")
  code POST /api/fs/delete "$B" >/dev/null
  B=$(json path "$M" name 测试目录)
  check "新建文件夹" "$(code POST /api/fs/mkdir "$B")" 200
  check "上传中文名小文件" "$(upload "$D" "$WORK/小文件.txt")" 200
  check "上传 20MB 文件" "$(upload "$D" "$WORK/big.bin")" 200
  check "列目录" "$(names "$D")" "big.bin,小文件.txt"
  download "$D/小文件.txt" "$WORK/dl.txt" >/dev/null
  check "下载小文件内容一致" "$(cat "$WORK/dl.txt")" "测试 网盘 中文"
  download "$D/big.bin" "$WORK/dl.bin" >/dev/null
  check "下载 20MB 文件 MD5 一致" "$(md5of "$WORK/dl.bin")" "$BIG_MD5"
  check "Range 请求返回 206" "$(download "$D/big.bin" "$WORK/range.bin" -H 'Range: bytes=100-199')" 206
  check "Range 内容正确" "$(md5of "$WORK/range.bin")" "$RANGE_MD5"
  B=$(json path "$D/小文件.txt" name 改名.txt)
  check "重命名文件" "$(code POST /api/fs/rename "$B")" 200
  check "重命名后列表" "$(names "$D")" "big.bin,改名.txt"
  B=$(json path "$D" name 改名目录)
  check "重命名文件夹" "$(code POST /api/fs/rename "$B")" 200
  check "文件夹改名后内容还在" "$(names "$M/改名目录")" "big.bin,改名.txt"
  B=$(json paths "[\"$M/改名目录\"]")
  check "删除文件夹" "$(code POST /api/fs/delete "$B")" 200
  check "删除后不再列出" "$(names "$M" | tr ',' '\n' | grep -c 改名目录)" 0
done

echo "== 安全"
check "路径穿越被拒绝" "$(req -o /dev/null -w '%{http_code}' -G "$BASE/api/fs/list" --data-urlencode 'path=/本地/../../etc')" 400
B=$(json path /本地 name a/b)
check "文件名含 / 被拒绝" "$(code POST /api/fs/mkdir "$B")" 400
B=$(json paths '["/s3"]')
check "不能删除挂载点本身" "$(code POST /api/fs/delete "$B")" 400
B=$(json path /本地 name ..)
check "文件名 .. 被拒绝" "$(code POST /api/fs/mkdir "$B")" 400

echo "== 下载方式切换"
S3ID=$(req "$BASE/api/storages" | jq_ 'j.find(x=>x.mountPath=="/s3").id')
check "列表里显示 S3 为服务器代理" "$(req "$BASE/api/storages" | jq_ 'j.find(x=>x.mountPath=="/s3").options.downloadMode')" proxy
B=$(json mountPath /s3 options "${S3OPT/minioadmin123/******}")
B=${B/\"downloadMode\":\"proxy\"/\"downloadMode\":\"bogus\"}
check "非法下载方式被拒绝" "$(code PUT "/api/storages/$S3ID" "$B")" 400
B=${B/\"downloadMode\":\"bogus\"/\"downloadMode\":\"redirect\"}
check "切换为 302 重定向（密钥保持打码值）" "$(code PUT "/api/storages/$S3ID" "$B")" 200
upload /s3 "$WORK/小文件.txt" >/dev/null
loc=$(curl -s -b "$JAR" -o /dev/null -w '%{http_code} %{redirect_url}' -G "$BASE/api/fs/download" --data-urlencode 'path=/s3/小文件.txt')
check "302 模式返回预签名地址" "$(echo "$loc" | grep -cE '^302 http://minio:9000/pan-test/.*X-Amz-Signature')" 1
B=${B/\"downloadMode\":\"redirect\"/\"downloadMode\":\"proxy\"}
check "切换回服务器代理" "$(code PUT "/api/storages/$S3ID" "$B")" 200
check "代理模式直接返回 200" "$(download /s3/小文件.txt "$WORK/proxy.txt" --max-redirs 0)" 200
check "代理模式文件内容正确" "$(cat "$WORK/proxy.txt")" "测试 网盘 中文"
B=$(json paths '["/s3/小文件.txt"]')
check "打码后原密钥仍可用（删除成功）" "$(code POST /api/fs/delete "$B")" 200

rm -rf "$WORK"
echo
echo "通过 $PASSED，失败 $FAILED"
[ "$FAILED" -eq 0 ]
