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
# 分块上传（和网页一样）：创建任务 → 逐块 PUT → 完成 → 轮询到写入存储。成功输出 200，否则输出出错的状态码
upload() {
  local size name r id cs n i c st B
  size=$(wc -c <"$2" | tr -d ' ')
  name=$(basename "$2")
  B=$(json path "$1" name "$name" size "$size" lastModified "$RANDOM$RANDOM")
  r=$(req -X POST "$BASE/api/uploads" -d "$B")
  id=$(echo "$r" | jq_ 'j.id'); cs=$(echo "$r" | jq_ 'j.chunkSize')
  [ -n "$id" ] || { echo 500; return; }
  n=$(( (size + cs - 1) / cs )); [ "$n" -eq 0 ] && n=1
  for ((i = 0; i < n; i++)); do
    c=$(dd if="$2" bs="$cs" skip="$i" count=1 2>/dev/null | curl -s -b "$JAR" -o /dev/null -w '%{http_code}' -X PUT \
      -H 'Content-Type: application/octet-stream' --data-binary @- "$BASE/api/uploads/$id/$i")
    [ "$c" = 200 ] || { echo "$c"; return; }
  done
  req -o /dev/null -X POST "$BASE/api/uploads/$id/complete"
  for ((i = 0; i < 300; i++)); do
    st=$(req "$BASE/api/uploads/$id" | jq_ 'j.status')
    [ "$st" = done ] && { echo 200; return; }
    [ "$st" = error ] && { echo 500; return; }
    sleep 0.5
  done
  echo 504
}
legacy_upload() { curl -s -b "$JAR" -o /dev/null -w '%{http_code}' -F "file=@$2" "$BASE/api/fs/upload?path=$(node -p 'encodeURIComponent(process.argv[1])' "$1")&size=$(wc -c <"$2" | tr -d ' ')"; }
download() { curl -s -b "$JAR" -L -o "$2" -w '%{http_code}' -G "$BASE/api/fs/download" --data-urlencode "path=$1" "${@:3}"; }
md5of() { if command -v md5sum >/dev/null; then md5sum "$1" | cut -d' ' -f1; else md5 -q "$1"; fi; }

echo "== 登录"
B=$(json username admin password wrong)
check "错误密码被拒绝" "$(code POST /api/login "$B")" 401
check "未登录访问被拒绝" "$(curl -s -o /dev/null -w '%{http_code}' "$BASE/api/fs/list?path=/")" 401
B=$(json username admin password "$PASS" remember false)
check "不记住我：会话 Cookie 不带 Max-Age" "$(curl -s -o /dev/null -D - -H 'Content-Type: application/json' -X POST "$BASE/api/login" -d "$B" | grep -i '^set-cookie' | grep -ci 'max-age')" 0
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

echo "== 分块上传"
SIZE=$(wc -c <"$WORK/big.bin" | tr -d ' ')
B=$(json path /本地 name 续传.bin size "$SIZE" lastModified 12345)
R=$(req -X POST "$BASE/api/uploads" -d "$B")
ID=$(echo "$R" | jq_ 'j.id'); CS=$(echo "$R" | jq_ 'j.chunkSize'); NCH=$(echo "$R" | jq_ 'j.chunks')
check "单块不超过 95MB（Cloudflare 免费版上限 100MB）" "$((CS <= 95 * 1024 * 1024))" 1
check "20MB 文件分成多块" "$((NCH > 1))" 1
chunk() { dd if="$WORK/big.bin" bs="$CS" skip="$1" count=1 2>/dev/null | curl -s -b "$JAR" -o /dev/null -w '%{http_code}' -X PUT -H 'Content-Type: application/octet-stream' --data-binary @- "$BASE/api/uploads/$ID/$1"; }
check "上传第 1 块" "$(chunk 0)" 200
check "块大小不对被拒绝" "$(head -c 100 /dev/zero | curl -s -b "$JAR" -o /dev/null -w '%{http_code}' -X PUT --data-binary @- "$BASE/api/uploads/$ID/1")" 400
check "块序号越界被拒绝" "$(head -c 100 /dev/zero | curl -s -b "$JAR" -o /dev/null -w '%{http_code}' -X PUT --data-binary @- "$BASE/api/uploads/$ID/999")" 400
check "缺块时不能完成" "$(req -o /dev/null -w '%{http_code}' -X POST "$BASE/api/uploads/$ID/complete")" 400
check "同一文件再次创建任务：复用任务并记得已收到第 1 块" "$(req -X POST "$BASE/api/uploads" -d "$B" | jq_ 'j.id + " " + j.received.join(",")')" "$ID 0"
for ((i = 1; i < NCH; i++)); do chunk $i >/dev/null; done
check "续传剩余块后完成" "$(req -o /dev/null -w '%{http_code}' -X POST "$BASE/api/uploads/$ID/complete")" 200
for ((i = 0; i < 60; i++)); do [ "$(req "$BASE/api/uploads/$ID" | jq_ 'j.status')" = done ] && break; sleep 0.5; done
download "/本地/续传.bin" "$WORK/resumed.bin" >/dev/null
check "续传后的文件 MD5 一致" "$(md5of "$WORK/resumed.bin")" "$BIG_MD5"
check "未登录不能上传块" "$(head -c 10 /dev/zero | curl -s -o /dev/null -w '%{http_code}' -X PUT --data-binary @- "$BASE/api/uploads/$ID/0")" 401
check "旧的整文件上传接口仍可用" "$(legacy_upload /本地 "$WORK/小文件.txt")" 200
B=$(json paths '["/本地/续传.bin","/本地/小文件.txt"]')
code POST /api/fs/delete "$B" >/dev/null

echo "== 安全"
check "路径穿越被拒绝" "$(req -o /dev/null -w '%{http_code}' -G "$BASE/api/fs/list" --data-urlencode 'path=/本地/../../etc')" 400
B=$(json path /本地 name a/b)
check "文件名含 / 被拒绝" "$(code POST /api/fs/mkdir "$B")" 400
B=$(json paths '["/s3"]')
check "不能删除挂载点本身" "$(code POST /api/fs/delete "$B")" 400
B=$(json path /本地 name 重名测试)
code POST /api/fs/mkdir "$B" >/dev/null
check "重名返回 409" "$(code POST /api/fs/mkdir "$B")" 409
check "错误信息不暴露服务器路径" "$(req -X POST "$BASE/api/fs/mkdir" -d "$B" | grep -c '/data')" 0
B=$(json paths '["/本地/重名测试"]')
code POST /api/fs/delete "$B" >/dev/null
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

echo "== 注册与用户空间"
SID_LOCAL=$(req "$BASE/api/storages" | jq_ 'j.find(x=>x.mountPath=="/本地").id')
SID_DAV=$(req "$BASE/api/storages" | jq_ 'j.find(x=>x.mountPath=="/dav").id')
B=$(json registration '{"open":false,"inviteCode":""}')
code PUT /api/settings "$B" >/dev/null
TU="e2e$RANDOM"; TP="userpass-$RANDOM"
B=$(json username "$TU" password "$TP")
check "未开放时不能注册" "$(curl -s -o /dev/null -w '%{http_code}' -H 'Content-Type: application/json' -X POST "$BASE/api/register" -d "$B")" 403
B=$(json registration '{"open":true,"inviteCode":"e2e-invite"}' privateSpace "{\"storageId\":\"$SID_LOCAL\",\"dir\":\"/e2e-users\"}" publicSpace "{\"storageId\":\"$SID_DAV\",\"dir\":\"/\",\"writable\":true}")
check "管理员开放注册并设置空间" "$(code PUT /api/settings "$B")" 200
check "登录页能看到需要邀请码" "$(curl -s "$BASE/api/register" | jq_ 'j.open+"/"+j.needInvite')" "true/true"
B=$(json username "$TU" password "$TP" inviteCode wrong)
check "邀请码错误被拒绝" "$(curl -s -o /dev/null -w '%{http_code}' -H 'Content-Type: application/json' -X POST "$BASE/api/register" -d "$B")" 403
B=$(json username "$TU" password short inviteCode e2e-invite)
check "密码太短被拒绝" "$(curl -s -o /dev/null -w '%{http_code}' -H 'Content-Type: application/json' -X POST "$BASE/api/register" -d "$B")" 400
ADMIN_JAR=$JAR; JAR=$WORK/user-cookie
B=$(json username "$TU" password "$TP" inviteCode e2e-invite)
check "注册成功" "$(code POST /api/register "$B")" 200
check "重名不能注册" "$(curl -s -o /dev/null -w '%{http_code}' -H 'Content-Type: application/json' -X POST "$BASE/api/register" -d "$B")" 409
check "普通用户根目录只有两个空间" "$(names /)" "公共空间,我的空间"
check "私人空间自动创建且为空" "$(names /我的空间)" ""
check "看不到管理员的挂载" "$(req -o /dev/null -w '%{http_code}' -G "$BASE/api/fs/list" --data-urlencode 'path=/本地')" 404
check "不能管理存储" "$(req -o /dev/null -w '%{http_code}' "$BASE/api/storages")" 403
check "不能修改系统设置" "$(code PUT /api/settings '{}')" 403
check "上传到我的空间" "$(upload /我的空间 "$WORK/小文件.txt")" 200
check "上传到公共空间" "$(upload /公共空间 "$WORK/小文件.txt")" 200
JAR=$ADMIN_JAR
check "管理员在存储里能看到用户的文件" "$(names "/本地/e2e-users/$TU")" "小文件.txt"
B=$(json publicSpace "{\"storageId\":\"$SID_DAV\",\"dir\":\"/\",\"writable\":false}")
code PUT /api/settings "$B" >/dev/null
JAR=$WORK/user-cookie
B=$(json path /公共空间 name 只读测试.txt size 10 lastModified 1)
check "公共空间设为只读后不能上传" "$(code POST /api/uploads "$B")" 403
check "只读公共空间不能新建文件夹" "$(code POST /api/fs/mkdir "$(json path /公共空间 name 新文件夹)")" 403
check "只读公共空间仍可下载" "$(download /公共空间/小文件.txt "$WORK/pub.txt"; cat "$WORK/pub.txt")" "200测试 网盘 中文"

echo "== 回收站"
B=$(json paths '["/我的空间/小文件.txt"]')
check "删除移到回收站" "$(code POST /api/fs/delete "$B")" 200
check "删除后不在原位置" "$(names /我的空间)" ""
TID=$(req "$BASE/api/trash" | jq_ 'j[0]&&j[0].id')
check "回收站里能看到" "$(req "$BASE/api/trash" | jq_ 'j.map(x=>x.name+"@"+x.from+"@"+x.daysLeft).join(",")')" "小文件.txt@/我的空间@30"
check "管理员看不到别人的回收站" "$(curl -s -b "$ADMIN_JAR" "$BASE/api/trash" | jq_ 'j.filter(x=>x.id=="'"$TID"'").length')" 0
check "回收站目录不能直接访问" "$(req -o /dev/null -w '%{http_code}' -G "$BASE/api/fs/list" --data-urlencode 'path=/我的空间/.pan-trash')" 404
upload /我的空间 "$WORK/小文件.txt" >/dev/null
check "还原（原位置有同名文件时自动改名）" "$(req -X POST "$BASE/api/trash/$TID/restore" | jq_ 'j.name')" "小文件 (恢复).txt"
check "还原后两个文件都在" "$(names /我的空间)" "小文件 (恢复).txt,小文件.txt"
B=$(json paths '["/我的空间/小文件 (恢复).txt"]')
code POST /api/fs/delete "$B" >/dev/null
TID=$(req "$BASE/api/trash" | jq_ 'j[0].id')
check "彻底删除" "$(req -o /dev/null -w '%{http_code}' -X DELETE "$BASE/api/trash/$TID")" 200
check "彻底删除后回收站为空" "$(req "$BASE/api/trash" | jq_ 'j.length')" 0

echo "== 分享和直链"
B=$(json path /我的空间/小文件.txt type share code abcd days 7)
SHR=$(req -X POST "$BASE/api/shares" -d "$B"); SHID=$(echo "$SHR" | jq_ 'j.id')
check "创建带提取码的分享" "$(echo "$SHR" | jq_ 'j.code+" "+j.url.startsWith("/s/")')" "abcd true"
check "分享页能打开" "$(curl -s -o /dev/null -w '%{http_code}' "$BASE/s/$SHID")" 200
check "公开信息需要提取码" "$(curl -s "$BASE/api/public/share/$SHID" | jq_ 'j.name+" "+j.needCode+" "+j.unlocked')" "小文件.txt true false"
check "未输入提取码不能下载" "$(curl -s -o /dev/null -w '%{http_code}' "$BASE/api/public/share/$SHID/download")" 401
check "提取码错误" "$(curl -s -o /dev/null -w '%{http_code}' -H 'Content-Type: application/json' -X POST "$BASE/api/public/share/$SHID/unlock" -d '{"code":"zzzz"}')" 403
VJ=$WORK/visitor
curl -s -c "$VJ" -o /dev/null -H 'Content-Type: application/json' -X POST "$BASE/api/public/share/$SHID/unlock" -d '{"code":"ABCD"}'
check "提取码不区分大小写，解锁后能下载" "$(curl -s -b "$VJ" "$BASE/api/public/share/$SHID/download")" "测试 网盘 中文"
B=$(json path /我的空间/小文件.txt type direct days 1)
DURL=$(req -X POST "$BASE/api/shares" -d "$B" | jq_ 'j.url')
check "直链直接返回文件" "$(curl -s "$BASE$DURL")" "测试 网盘 中文"
B=$(json path /我的空间 type direct days 1)
check "空间本身不能分享" "$(code POST /api/shares "$B")" 400
mkdir_b=$(json path /我的空间 name 分享文件夹); code POST /api/fs/mkdir "$mkdir_b" >/dev/null
B=$(json path /我的空间/分享文件夹 type direct days 1)
check "文件夹不能用直链" "$(code POST /api/shares "$B")" 400
B=$(json path /我的空间/小文件.txt type share code 1 days 7)
check "提取码格式不对被拒绝" "$(code POST /api/shares "$B")" 400
B=$(json path /我的空间/小文件.txt type share days 3)
check "有效期只能选 1/7/30/永久" "$(code POST /api/shares "$B")" 400
check "统计访问和下载次数" "$(req "$BASE/api/shares" | jq_ 'j.map(x=>x.type+":"+x.views+"/"+x.downloads).sort().join(",")')" "direct:1/1,share:1/1"
check "未登录不能取消分享" "$(curl -s -o /dev/null -w '%{http_code}' -X DELETE "$BASE/api/shares/$SHID")" 401
check "取消分享" "$(req -o /dev/null -w '%{http_code}' -X DELETE "$BASE/api/shares/$SHID")" 200
check "取消后链接失效" "$(curl -s -o /dev/null -w '%{http_code}' "$BASE/api/public/share/$SHID")" 404
JAR=$ADMIN_JAR

echo "== 清理测试用户"
TUID=$(req "$BASE/api/users" | jq_ 'j.find(x=>x.username=="'"$TU"'").id')
check "管理员停用用户后对方被登出" "$(code PUT "/api/users/$TUID" '{"disabled":true}'; curl -s -o /dev/null -w '%{http_code}' -b "$WORK/user-cookie" "$BASE/api/fs/list?path=/")" "200401"
check "删除用户" "$(req -o /dev/null -w '%{http_code}' -X DELETE "$BASE/api/users/$TUID")" 200
check "被删用户的直链失效" "$(curl -s -o /dev/null -w '%{http_code}' "$BASE$DURL")" 404
B=$(json registration '{"open":false,"inviteCode":""}' privateSpace '{"storageId":"","dir":"/users"}' publicSpace '{"storageId":"","dir":"/","writable":true}')
code PUT /api/settings "$B" >/dev/null

echo "== 修改账号"
ORIG_USER=$(req "$BASE/api/me" | jq_ 'j.user')
NEWPASS="${PASS}-e2e"
cp "$JAR" "$WORK/old-cookie"
B=$(json currentPassword wrong username e2e-user newPassword "$NEWPASS")
check "当前密码错误被拒绝" "$(code PUT /api/account "$B")" 403
B=$(json currentPassword "$PASS" newPassword short)
check "新密码太短被拒绝" "$(code PUT /api/account "$B")" 400
B=$(json currentPassword "$PASS" username "a|b")
check "非法用户名被拒绝" "$(code PUT /api/account "$B")" 400
B=$(json currentPassword "$PASS" username e2e-user newPassword "$NEWPASS")
check "修改用户名和密码" "$(code PUT /api/account "$B")" 200
check "当前设备保持登录" "$(req "$BASE/api/me" | jq_ 'j.user')" e2e-user
check "其他设备的旧会话失效" "$(curl -s -o /dev/null -w '%{http_code}' -b "$WORK/old-cookie" "$BASE/api/fs/list?path=/")" 401
B=$(json username "$ORIG_USER" password "$PASS")
check "旧账号密码不能再登录" "$(code POST /api/login "$B")" 401
B=$(json username e2e-user password "$NEWPASS")
check "新账号密码可以登录" "$(code POST /api/login "$B")" 200
B=$(json currentPassword "$NEWPASS" username "$ORIG_USER" newPassword "$PASS")
check "改回原来的账号密码" "$(code PUT /api/account "$B")" 200
B=$(json username "$ORIG_USER" password "$PASS")
check "原账号密码可以登录" "$(code POST /api/login "$B")" 200

rm -rf "$WORK"
echo
echo "通过 $PASSED，失败 $FAILED"
[ "$FAILED" -eq 0 ]
