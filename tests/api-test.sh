#!/usr/bin/env bash
# JunDrive API 集成测试（针对 wrangler dev 本地环境）
# 登录走邮箱验证码；本地 DEV_MAIL_LOG=1 时验证码随响应返回
# 注：测试数据用 ASCII 名称，规避 Windows 下 curl.exe 对命令行参数的 ANSI 转码
set -u
BASE="${TEST_BASE:-http://127.0.0.1:8787}"
JAR=$(mktemp)
JAR2=$(mktemp)
JAR3=$(mktemp)
TMP=$(mktemp -d)
IP='CF-Connecting-IP: 1.2.3.4'
PASS=0; FAIL=0

chk() {
  if [ "$2" = "$3" ]; then PASS=$((PASS+1)); echo "PASS: $1";
  else FAIL=$((FAIL+1)); echo "FAIL: $1 (expected=[$2] actual=[$3])"; fi
}

jget() { node -e "let d='';process.stdin.on('data',c=>d+=c).on('end',()=>{try{const o=JSON.parse(d);const v=$1;console.log(typeof v==='object'&&v!==null?JSON.stringify(v):v)}catch(e){console.log('PARSE_ERR')}})"; }

echo "===== 0. 清理本地测试数据 ====="
printf "DELETE FROM files; DELETE FROM shares; DELETE FROM uploads; DELETE FROM login_failures; DELETE FROM email_codes; DELETE FROM users; DELETE FROM images;\n" > "$TMP/clean.sql"
npx wrangler d1 execute DB --local --file="$TMP/clean.sql" > /dev/null 2>&1 || { echo "警告: 清理命令执行失败"; npx wrangler d1 execute DB --local --file="$TMP/clean.sql"; }
echo "已清理本地 D1 测试表"

echo "===== 1. 邮箱验证码登录 ====="
code=$(curl -s -o /dev/null -w '%{http_code}' -H "$IP" "$BASE/api/list")
chk "未登录访问 list 为 401" 401 "$code"

code=$(curl -s -o /dev/null -w '%{http_code}' -H "$IP" -H 'Content-Type: application/json' -d '{"email":"attacker@example.com"}' -X POST "$BASE/api/auth/send-code")
chk "非白名单邮箱被拒 403" 403 "$code"

SEND=$(curl -s -c "$JAR" -H "$IP" -H 'Content-Type: application/json' -d '{"email":"junwind.xqw@gmail.com"}' -X POST "$BASE/api/auth/send-code")
CODE=$(echo "$SEND" | jget 'o.devCode')
chk "send-code 返回开发验证码" "yes" "$(echo "$CODE" | grep -qE '^[0-9]{6}$' && echo yes || echo no)"

code=$(curl -s -o /dev/null -w '%{http_code}' -H "$IP" -H 'Content-Type: application/json' -d '{"email":"junwind.xqw@gmail.com","code":"000000"}' -X POST "$BASE/api/auth/verify")
chk "错误验证码 401" 401 "$code"

code=$(curl -s -o /dev/null -w '%{http_code}' -c "$JAR" -H "$IP" -H 'Content-Type: application/json' -d "{\"email\":\"junwind.xqw@gmail.com\",\"code\":\"$CODE\"}" -X POST "$BASE/api/auth/verify")
chk "正确验证码登录 200" 200 "$code"

me=$(curl -s -b "$JAR" -H "$IP" "$BASE/api/me")
chk "me 返回管理员邮箱" "junwind.xqw@gmail.com" "$(echo "$me" | jget 'o.email')"
chk "验证码登录后未设密码" "false" "$(echo "$me" | jget 'o.hasPassword')"

echo "===== 1b. 注册 / 密码登录 / 找回密码 ====="
# 测试用密码每次随机生成（T + 随机 hex + a1，保证含字母和数字且 ≥ 8 位）
RND=$(head -c 6 /dev/urandom | od -An -tx1 | tr -d ' \n')
PW1="T${RND}a1"; PW2="T${RND}b2"; PW3="T${RND}c3"

SEND=$(curl -s -H "$IP" -H 'Content-Type: application/json' -d '{"email":"junwind.xqw@gmail.com","purpose":"register"}' -X POST "$BASE/api/auth/send-code")
REGCODE=$(echo "$SEND" | jget 'o.devCode')
chk "注册验证码返回" "yes" "$(echo "$REGCODE" | grep -qE '^[0-9]{6}$' && echo yes || echo no)"

code=$(curl -s -o /dev/null -w '%{http_code}' -H "$IP" -H 'Content-Type: application/json' -d '{"email":"junwind.xqw@gmail.com","code":"000000","password":"'"$PW1"'"}' -X POST "$BASE/api/auth/register")
chk "错误验证码注册 401" 401 "$code"

code=$(curl -s -o /dev/null -w '%{http_code}' -H "$IP" -H 'Content-Type: application/json' -d "{\"email\":\"junwind.xqw@gmail.com\",\"code\":\"$REGCODE\",\"password\":\"short1\"}" -X POST "$BASE/api/auth/register")
chk "弱密码注册 400" 400 "$code"

code=$(curl -s -o /dev/null -w '%{http_code}' -H "$IP" -H 'Content-Type: application/json' -d "{\"email\":\"junwind.xqw@gmail.com\",\"code\":\"$REGCODE\",\"password\":\"$PW1\"}" -X POST "$BASE/api/auth/register")
chk "注册成功 200" 200 "$code"

me=$(curl -s -b "$JAR" -H "$IP" "$BASE/api/me")
chk "注册后 hasPassword" "true" "$(echo "$me" | jget 'o.hasPassword')"

code=$(curl -s -o /dev/null -w '%{http_code}' -H "$IP" -H 'Content-Type: application/json' -d '{"email":"junwind.xqw@gmail.com","password":"'"$PW2"'"}' -X POST "$BASE/api/auth/login")
chk "错误密码登录 401" 401 "$code"

code=$(curl -s -o /dev/null -w '%{http_code}' -c "$JAR3" -H "$IP" -H 'Content-Type: application/json' -d "{\"email\":\"junwind.xqw@gmail.com\",\"password\":\"$PW1\"}" -X POST "$BASE/api/auth/login")
chk "正确密码登录 200" 200 "$code"

code=$(curl -s -o /dev/null -w '%{http_code}' -b "$JAR3" -H "$IP" "$BASE/api/list")
chk "密码登录会话可用 200" 200 "$code"

code=$(curl -s -o /dev/null -w '%{http_code}' -b "$JAR3" -H "$IP" -H 'Content-Type: application/json' -d '{"oldPassword":"'"$PW2"'","newPassword":"'"$PW3"'"}' -X POST "$BASE/api/auth/change-password")
chk "修改密码旧密码错误 401" 401 "$code"

code=$(curl -s -o /dev/null -w '%{http_code}' -c "$JAR3" -b "$JAR3" -H "$IP" -H 'Content-Type: application/json' -d '{"oldPassword":"'"$PW1"'","newPassword":"'"$PW2"'"}' -X POST "$BASE/api/auth/change-password")
chk "修改密码成功 200" 200 "$code"

code=$(curl -s -o /dev/null -w '%{http_code}' -b "$JAR3" -H "$IP" "$BASE/api/list")
chk "改密后当前会话仍有效 200" 200 "$code"

SEND=$(curl -s -H "$IP" -H 'Content-Type: application/json' -d '{"email":"junwind.xqw@gmail.com","purpose":"reset"}' -X POST "$BASE/api/auth/send-code")
RESETCODE=$(echo "$SEND" | jget 'o.devCode')
chk "重置验证码返回" "yes" "$(echo "$RESETCODE" | grep -qE '^[0-9]{6}$' && echo yes || echo no)"

code=$(curl -s -o /dev/null -w '%{http_code}' -H "$IP" -H 'Content-Type: application/json' -d '{"email":"junwind.xqw@gmail.com","code":"000000","password":"'"$PW3"'"}' -X POST "$BASE/api/auth/reset-password")
chk "错误验证码重置 401" 401 "$code"

code=$(curl -s -o /dev/null -w '%{http_code}' -H "$IP" -H 'Content-Type: application/json' -d "{\"email\":\"junwind.xqw@gmail.com\",\"code\":\"$RESETCODE\",\"password\":\"$PW3\"}" -X POST "$BASE/api/auth/reset-password")
chk "重置密码成功 200" 200 "$code"

code=$(curl -s -o /dev/null -w '%{http_code}' -H "$IP" -H 'Content-Type: application/json' -d '{"email":"junwind.xqw@gmail.com","password":"'"$PW2"'"}' -X POST "$BASE/api/auth/login")
chk "重置后旧密码登录 401" 401 "$code"

code=$(curl -s -o /dev/null -w '%{http_code}' -c "$JAR3" -H "$IP" -H 'Content-Type: application/json' -d "{\"email\":\"junwind.xqw@gmail.com\",\"password\":\"$PW3\"}" -X POST "$BASE/api/auth/login")
chk "重置后新密码登录 200" 200 "$code"

code=$(curl -s -o /dev/null -w '%{http_code}' -H "$IP" -H 'Content-Type: application/json' -d '{"email":"junwind.xqw@gmail.com","purpose":"register"}' -X POST "$BASE/api/auth/send-code")
chk "已注册邮箱再注册 409" 409 "$code"

# 重置密码使 epoch +1，旧主会话（$JAR）已失效，用最终密码重新登录主会话供后续小节使用
code=$(curl -s -o /dev/null -w '%{http_code}' -c "$JAR" -H "$IP" -H 'Content-Type: application/json' -d "{\"email\":\"junwind.xqw@gmail.com\",\"password\":\"$PW3\"}" -X POST "$BASE/api/auth/login")
chk "主会话用新密码重新登录 200" 200 "$code"

echo "===== 2. 文件夹 ====="
F1=$(curl -s -b "$JAR" -H "$IP" -H 'Content-Type: application/json' -d '{"name":"test-dir"}' -X POST "$BASE/api/folder")
F1ID=$(echo "$F1" | jget 'o.item.id')
chk "创建文件夹" "test-dir" "$(echo "$F1" | jget 'o.item.name')"

F2=$(curl -s -b "$JAR" -H "$IP" -H 'Content-Type: application/json' -d '{"name":"test-dir"}' -X POST "$BASE/api/folder")
chk "重名文件夹自动加后缀" "test-dir (1)" "$(echo "$F2" | jget 'o.item.name')"
F2ID=$(echo "$F2" | jget 'o.item.id')

code=$(curl -s -o /dev/null -w '%{http_code}' -b "$JAR" -H "$IP" -H 'Content-Type: application/json' -d '{"name":"a/b"}' -X POST "$BASE/api/folder")
chk "非法名称被拒绝 400" 400 "$code"

echo "===== 3. 上传（单分片 / 零字节 / 多分片） ====="
head -c 1024 /dev/urandom > "$TMP/small.bin"
SZ=$(stat -c%s "$TMP/small.bin")
UP=$(curl -s -b "$JAR" -H "$IP" -H 'Content-Type: application/json' -d "{\"name\":\"small.bin\",\"size\":$SZ,\"mime\":\"application/octet-stream\",\"parentId\":\"$F1ID\"}" -X POST "$BASE/api/upload/init")
UPID=$(echo "$UP" | jget 'o.uploadId')
PSIZE=$(echo "$UP" | jget 'o.partSize')
chk "init 返回 8MiB 分片大小" "8388608" "$PSIZE"

ETAG=$(curl -s -b "$JAR" -H "$IP" -X PUT --data-binary "@$TMP/small.bin" "$BASE/api/upload/$UPID/part/1" | jget 'o.etag')
chk "分片1上传返回 etag" "yes" "$([ -n "$ETAG" ] && [ "$ETAG" != "PARSE_ERR" ] && [ "$ETAG" != "undefined" ] && echo yes || echo no)"

DONE=$(curl -s -b "$JAR" -H "$IP" -H 'Content-Type: application/json' -d "{\"parts\":[{\"partNumber\":1,\"etag\":\"$ETAG\"}]}" -X POST "$BASE/api/upload/$UPID/complete")
SMALL_ID=$(echo "$DONE" | jget 'o.item.id')
chk "小文件上传完成" "small.bin" "$(echo "$DONE" | jget 'o.item.name')"
chk "小文件大小正确" "$SZ" "$(echo "$DONE" | jget 'o.item.size')"

UP=$(curl -s -b "$JAR" -H "$IP" -H 'Content-Type: application/json' -d '{"name":"empty.txt","size":0,"mime":"text/plain","parentId":null}' -X POST "$BASE/api/upload/init")
UPID=$(echo "$UP" | jget 'o.uploadId')
DONE=$(curl -s -b "$JAR" -H "$IP" -H 'Content-Type: application/json' -d '{"parts":[]}' -X POST "$BASE/api/upload/$UPID/complete")
chk "零字节文件上传" "0" "$(echo "$DONE" | jget 'o.item.size')"

head -c 20971520 /dev/urandom > "$TMP/big.bin"   # 20MB
SHA_ORIG=$(sha256sum "$TMP/big.bin" | cut -d' ' -f1)
UP=$(curl -s -b "$JAR" -H "$IP" -H 'Content-Type: application/json' -d "{\"name\":\"big.bin\",\"size\":20971520,\"mime\":\"application/octet-stream\",\"parentId\":\"$F1ID\"}" -X POST "$BASE/api/upload/init")
UPID=$(echo "$UP" | jget 'o.uploadId')
chk "20MB init 成功" "yes" "$([ -n "$UPID" ] && [ "$UPID" != "PARSE_ERR" ] && [ "$UPID" != "undefined" ] && echo yes || echo no)"
ETAGS=()
for n in 1 2 3; do
  case $n in
    1) dd if="$TMP/big.bin" bs=1M count=8 skip=0 of="$TMP/p$n" status=none ;;
    2) dd if="$TMP/big.bin" bs=1M count=8 skip=8 of="$TMP/p$n" status=none ;;
    3) dd if="$TMP/big.bin" bs=1M count=4 skip=16 of="$TMP/p$n" status=none ;;
  esac
  ETAGS+=("$(curl -s -b "$JAR" -H "$IP" -X PUT --data-binary "@$TMP/p$n" "$BASE/api/upload/$UPID/part/$n" | jget 'o.etag')")
done
PARTS_JSON=$(printf '{"partNumber":1,"etag":"%s"},{"partNumber":2,"etag":"%s"},{"partNumber":3,"etag":"%s"}' "${ETAGS[0]}" "${ETAGS[1]}" "${ETAGS[2]}")
DONE=$(curl -s -b "$JAR" -H "$IP" -H 'Content-Type: application/json' -d "{\"parts\":[$PARTS_JSON]}" -X POST "$BASE/api/upload/$UPID/complete")
BIG_ID=$(echo "$DONE" | jget 'o.item.id')
chk "20MB 多分片上传大小正确" "20971520" "$(echo "$DONE" | jget 'o.item.size')"

echo "===== 4. 列表 / 下载 / Range ====="
LIST=$(curl -s -b "$JAR" -H "$IP" "$BASE/api/list?folderId=$F1ID")
chk "目录列表包含 big.bin" "yes" "$(echo "$LIST" | grep -q 'big\.bin' && echo yes || echo no)"

curl -s -b "$JAR" -H "$IP" "$BASE/api/file/$BIG_ID/download" -o "$TMP/dl.bin"
SHA_DL=$(sha256sum "$TMP/dl.bin" | cut -d' ' -f1)
chk "下载内容哈希一致" "$SHA_ORIG" "$SHA_DL"

R=$(curl -s -b "$JAR" -H "$IP" -H 'Range: bytes=0-99' -D - -o "$TMP/r1" "$BASE/api/file/$BIG_ID/raw")
chk "Range 0-99 返回 206" "yes" "$(echo "$R" | head -1 | grep -q 206 && echo yes || echo no)"
chk "Content-Range 正确" "yes" "$(echo "$R" | grep -qi "content-range: bytes 0-99/20971520" && echo yes || echo no)"
chk "Range 片段大小 100" "100" "$(stat -c%s "$TMP/r1")"

R=$(curl -s -b "$JAR" -H "$IP" -H 'Range: bytes=-50' -D - -o "$TMP/r2" "$BASE/api/file/$BIG_ID/raw")
chk "后缀 Range -50 返回 206" "yes" "$(echo "$R" | head -1 | grep -q 206 && echo yes || echo no)"
chk "Content-Range 后缀正确" "yes" "$(echo "$R" | grep -qi "content-range: bytes 20971470-20971519/20971520" && echo yes || echo no)"

code=$(curl -s -o /dev/null -w '%{http_code}' -b "$JAR" -H "$IP" -H 'Range: bytes=99999999-' "$BASE/api/file/$BIG_ID/raw")
chk "越界 Range 返回 416" 416 "$code"

echo "===== 5. 重命名 / 移动 / 搜索 / 路径 ====="
code=$(curl -s -o /dev/null -w '%{http_code}' -b "$JAR" -H "$IP" -H 'Content-Type: application/json' -X PATCH -d '{"name":"big-renamed.bin"}' "$BASE/api/item/$BIG_ID")
chk "重命名 200" 200 "$code"

code=$(curl -s -o /dev/null -w '%{http_code}' -b "$JAR" -H "$IP" -H 'Content-Type: application/json' -X PATCH -d "{\"parentId\":\"$F2ID\"}" "$BASE/api/item/$BIG_ID")
chk "移动到子目录 200" 200 "$code"

code=$(curl -s -o /dev/null -w '%{http_code}' -b "$JAR" -H "$IP" -H 'Content-Type: application/json' -X PATCH -d "{\"parentId\":\"$F1ID\"}" "$BASE/api/item/$F2ID")
chk "把子目录移入父目录 200" 200 "$code"

code=$(curl -s -o /dev/null -w '%{http_code}' -b "$JAR" -H "$IP" -H 'Content-Type: application/json' -X PATCH -d "{\"parentId\":\"$F2ID\"}" "$BASE/api/item/$F1ID")
chk "移动到自身子目录被拒绝 400" 400 "$code"

S=$(curl -s -b "$JAR" -H "$IP" "$BASE/api/search?q=renamed")
chk "搜索命中重命名文件" "yes" "$(echo "$S" | grep -q 'big-renamed' && echo yes || echo no)"

P=$(curl -s -b "$JAR" -H "$IP" "$BASE/api/path?folderId=$F2ID")
chk "路径面包屑正确" "2" "$(echo "$P" | jget 'o.path.length')"

echo "===== 6. 分享（无密码 / 有密码 / 文件夹 / 过期） ====="
SH=$(curl -s -b "$JAR" -H "$IP" -H 'Content-Type: application/json' -d "{\"fileId\":\"$BIG_ID\"}" -X POST "$BASE/api/share")
TOKEN=$(echo "$SH" | jget 'o.token')
chk "创建分享返回 token" "yes" "$([ -n "$TOKEN" ] && [ "$TOKEN" != "PARSE_ERR" ] && echo yes || echo no)"

PM=$(curl -s -H "$IP" "$BASE/api/pub/$TOKEN")
chk "公开分享 meta" "big-renamed.bin" "$(echo "$PM" | jget 'o.name')"

curl -s -H "$IP" "$BASE/api/pub/$TOKEN/file/$BIG_ID/download" -o "$TMP/sdl.bin"
SHA_SDL=$(sha256sum "$TMP/sdl.bin" | cut -d' ' -f1)
chk "公开下载哈希一致" "$SHA_ORIG" "$SHA_SDL"

SH2=$(curl -s -b "$JAR" -H "$IP" -H 'Content-Type: application/json' -d "{\"fileId\":\"$SMALL_ID\",\"password\":\"abc123\",\"expireDays\":7}" -X POST "$BASE/api/share")
TOKEN2=$(echo "$SH2" | jget 'o.token')
PM=$(curl -s -H "$IP" "$BASE/api/pub/$TOKEN2")
chk "密码分享 meta 需要密码" "true" "$(echo "$PM" | jget 'o.needsPassword')"

code=$(curl -s -o /dev/null -w '%{http_code}' -H "$IP" -H 'Content-Type: application/json' -d '{"password":"wrong"}' -X POST "$BASE/api/pub/$TOKEN2/verify")
chk "错误口令 401" 401 "$code"

code=$(curl -s -o /dev/null -w '%{http_code}' -c "$JAR2" -H "$IP" -H 'Content-Type: application/json' -d '{"password":"abc123"}' -X POST "$BASE/api/pub/$TOKEN2/verify")
chk "正确口令 200" 200 "$code"
PM=$(curl -s -b "$JAR2" -H "$IP" "$BASE/api/pub/$TOKEN2")
chk "口令通过后可见" "small.bin" "$(echo "$PM" | jget 'o.name')"
code=$(curl -s -o /dev/null -w '%{http_code}' -b "$JAR2" -H "$IP" "$BASE/api/pub/$TOKEN2/file/$SMALL_ID/download")
chk "口令通过后可下载" 200 "$code"
code=$(curl -s -o /dev/null -w '%{http_code}' -H "$IP" "$BASE/api/pub/$TOKEN2/file/$SMALL_ID/download")
chk "无口令 Cookie 下载被拒" 401 "$code"

SH3=$(curl -s -b "$JAR" -H "$IP" -H 'Content-Type: application/json' -d "{\"fileId\":\"$F1ID\"}" -X POST "$BASE/api/share")
TOKEN3=$(echo "$SH3" | jget 'o.token')
PL=$(curl -s -H "$IP" "$BASE/api/pub/$TOKEN3/list")
chk "文件夹分享可列出" "yes" "$(echo "$PL" | grep -q 'small\.bin' && echo yes || echo no)"

SHL=$(curl -s -b "$JAR" -H "$IP" "$BASE/api/shares")
chk "分享列表包含 3 条" "3" "$(echo "$SHL" | jget 'o.shares.length')"

# 把第一个分享改为已过期（token 仅含 base64url 字符集；SQL 经临时文件传入，避免拼接命令行）
printf "UPDATE shares SET expires_at = 1000 WHERE token = '%s';\n" "$TOKEN" > "$TMP/exp.sql"
if ! npx wrangler d1 execute DB --local --file="$TMP/exp.sql" > "$TMP/exp.out" 2>&1; then
  echo "NOTE: d1 execute 输出:"; cat "$TMP/exp.out"
fi
code=$(curl -s -o /dev/null -w '%{http_code}' -H "$IP" "$BASE/api/pub/$TOKEN")
chk "过期分享 410" 410 "$code"

echo "===== 7. 删除（级联） ====="
code=$(curl -s -o /dev/null -w '%{http_code}' -b "$JAR" -H "$IP" -X DELETE "$BASE/api/item/$BIG_ID")
chk "删除文件 200" 200 "$code"
code=$(curl -s -o /dev/null -w '%{http_code}' -b "$JAR" -H "$IP" "$BASE/api/file/$BIG_ID/download")
chk "删除后下载 404" 404 "$code"

code=$(curl -s -o /dev/null -w '%{http_code}' -b "$JAR" -H "$IP" -X DELETE "$BASE/api/item/$F1ID")
chk "删除文件夹 200" 200 "$code"
code=$(curl -s -o /dev/null -w '%{http_code}' -b "$JAR" -H "$IP" "$BASE/api/pub/$TOKEN3/list")
chk "文件夹删除后分享 404" 404 "$code"

LIST=$(curl -s -b "$JAR" -H "$IP" "$BASE/api/list")
chk "根目录文件夹全部删除" "0" "$(echo "$LIST" | jget 'o.items.filter(i=>i.type==="folder").length')"

echo "===== 7b. 图床（上传 / 公开直链 / 转存 / 删除） ====="
# 生成真实图片样本，无需 PIL / ImageMagick
node - "$TMP" <<'NODE'
const fs = require('node:fs');
const { deflateSync } = require('node:zlib');
const dir = process.argv[2];
const CRC_TABLE = [...Array(256)].map((_, n) => {
  let c = n;
  for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
  return c >>> 0;
});
const crc32 = (buf) => {
  let c = 0xffffffff;
  for (const b of buf) c = CRC_TABLE[(c ^ b) & 0xff] ^ (c >>> 8);
  return (c ^ 0xffffffff) >>> 0;
};
function png(w, h) {
  const sig = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]);
  const ihdr = Buffer.alloc(13);
  ihdr.writeUInt32BE(w, 0);
  ihdr.writeUInt32BE(h, 4);
  ihdr[8] = 8;
  ihdr[9] = 2;
  const chunk = (type, data) => {
    const len = Buffer.alloc(4);
    len.writeUInt32BE(data.length, 0);
    const t = Buffer.from(type, 'ascii');
    const crc = Buffer.alloc(4);
    crc.writeUInt32BE(crc32(Buffer.concat([t, data])), 0);
    return Buffer.concat([len, t, data, crc]);
  };
  const rows = [...Array(h)].map(() => Buffer.concat([Buffer.from([0]), Buffer.alloc(w * 3, 0xcc)]));
  return Buffer.concat([sig, chunk('IHDR', ihdr), chunk('IDAT', deflateSync(Buffer.concat(rows))), chunk('IEND', Buffer.alloc(0))]);
}
function gif(w, h) {
  const parts = [Buffer.from('GIF89a', 'ascii')];
  const lsd = Buffer.alloc(7);
  lsd.writeUInt16LE(w, 0);
  lsd.writeUInt16LE(h, 2);
  lsd[4] = 0x80;
  parts.push(lsd, Buffer.from([0xff, 0xff, 0xff, 0x00, 0x00, 0x00]), Buffer.from([0x2c]));
  const desc = Buffer.alloc(8);
  desc.writeUInt16LE(0, 0);
  desc.writeUInt16LE(0, 2);
  desc.writeUInt16LE(w, 4);
  desc.writeUInt16LE(h, 6);
  parts.push(desc, Buffer.from([0x07]));
  const bits = [];
  for (const code of [4, ...[...Array(w * h)].map(() => 0), 5]) {
    for (let i = 0; i < 3; i++) bits.push((code >> i) & 1);
  }
  const data = Buffer.alloc(Math.ceil(bits.length / 8));
  bits.forEach((b, i) => {
    if (b) data[i >> 3] |= 0x80 >> (i & 7);
  });
  parts.push(Buffer.from([2, data.length]), data, Buffer.from([0x00, 0x3b]));
  return Buffer.concat(parts);
}
function bmp(w, h) {
  const rowSize = Math.ceil((w * 3) / 4) * 4;
  const pixels = Buffer.alloc(rowSize * h, 0xcc);
  const header = Buffer.alloc(14);
  header.write('BM', 0, 'ascii');
  header.writeUInt32LE(54 + pixels.length, 2);
  header.writeUInt32LE(54, 10);
  const info = Buffer.alloc(40);
  info.writeUInt32LE(40, 0);
  info.writeInt32LE(w, 4);
  info.writeInt32LE(h, 8);
  info.writeUInt16LE(1, 12);
  info.writeUInt16LE(24, 14);
  info.writeUInt32LE(pixels.length, 20);
  return Buffer.concat([header, info, pixels]);
}
function webp(w, h) {
  const payload = Buffer.alloc(5);
  payload[0] = 0x2f;
  payload.writeUIntLE(((w - 1) & 0x3fff) | (((h - 1) & 0x3fff) << 14), 1, 4);
  const vp8l = Buffer.concat([Buffer.from('VP8L', 'ascii'), (() => { const s = Buffer.alloc(4); s.writeUInt32LE(payload.length, 0); return s; })(), payload]);
  const size = Buffer.alloc(4);
  size.writeUInt32LE(4 + vp8l.length, 0);
  return Buffer.concat([Buffer.from('RIFF', 'ascii'), size, Buffer.from('WEBP', 'ascii'), vp8l]);
}
fs.writeFileSync(`${dir}/pic.png`, png(320, 180));
fs.writeFileSync(`${dir}/pic.gif`, gif(48, 24));
fs.writeFileSync(`${dir}/pic.bmp`, bmp(64, 32));
fs.writeFileSync(`${dir}/pic.webp`, webp(33, 17));
fs.writeFileSync(`${dir}/evil.png`, Buffer.concat([Buffer.from([0x89, 0x50, 0x4e, 0x47]), Buffer.from('<script>alert(1)</script>')]));
fs.writeFileSync(`${dir}/evil.html`, Buffer.from('<!doctype html><script>alert(1)</script>'));
fs.writeFileSync(`${dir}/huge.png`, Buffer.concat([Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]), Buffer.alloc(11 * 1024 * 1024)]));
NODE

code=$(curl -s -o /dev/null -w '%{http_code}' -H "$IP" -F "file=@$TMP/pic.png" "$BASE/api/imagebed/upload")
chk "未登录上传 401" 401 "$code"

code=$(curl -s -o /dev/null -w '%{http_code}' -b "$JAR" -H "$IP" -F "file=@$TMP/evil.png" "$BASE/api/imagebed/upload")
chk "伪造的 png 被拒 400" 400 "$code"
code=$(curl -s -o /dev/null -w '%{http_code}' -b "$JAR" -H "$IP" -F "file=@$TMP/evil.html" "$BASE/api/imagebed/upload")
chk "HTML 文件被拒 400" 400 "$code"
code=$(curl -s -o /dev/null -w '%{http_code}' -b "$JAR" -H "$IP" -X POST -F "notfile=@$TMP/pic.png" "$BASE/api/imagebed/upload")
chk "缺少文件字段 400" 400 "$code"
code=$(curl -s -o /dev/null -w '%{http_code}' -b "$JAR" -H "$IP" -F "file=@$TMP/huge.png" "$BASE/api/imagebed/upload")
chk "超过 10MB 被拒 413" 413 "$code"

UP=$(curl -s -b "$JAR" -H "$IP" -F "file=@$TMP/pic.png" "$BASE/api/imagebed/upload")
IMGID=$(echo "$UP" | jget 'o.item.id')
IMGURL=$(echo "$UP" | jget 'o.item.url')
chk "上传返回公开直链" "yes" "$(echo "$IMGURL" | grep -qE "^/i/${IMGID}\.png$" && echo yes || echo no)"
chk "解析 PNG 宽 320" "320" "$(echo "$UP" | jget 'o.item.width')"
chk "解析 PNG 高 180" "180" "$(echo "$UP" | jget 'o.item.height')"
chk "记录字节大小" "$(stat -c%s "$TMP/pic.png")" "$(echo "$UP" | jget 'o.item.size')"

for ext in gif bmp webp; do
  curl -s -b "$JAR" -H "$IP" -F "file=@$TMP/pic.$ext" "$BASE/api/imagebed/upload" > /dev/null
done

# 公开直链：无 Cookie 直接可访问，且带缓存与 nosniff 头
H=$(curl -s -D - -o "$TMP/dl.png" "$BASE$IMGURL")
chk "公开直链 200（无需登录）" "yes" "$(echo "$H" | head -1 | grep -q 200 && echo yes || echo no)"
chk "Content-Type 为 image/png" "yes" "$(echo "$H" | grep -qi 'content-type: image/png' && echo yes || echo no)"
chk "长缓存头" "yes" "$(echo "$H" | grep -qi 'cache-control: public, max-age=31536000, immutable' && echo yes || echo no)"
chk "nosniff 头" "yes" "$(echo "$H" | grep -qi 'x-content-type-options: nosniff' && echo yes || echo no)"
chk "直链内容与源文件一致" "$(sha256sum "$TMP/pic.png" | cut -d' ' -f1)" "$(sha256sum "$TMP/dl.png" | cut -d' ' -f1)"

code=$(curl -s -o /dev/null -w '%{http_code}' "$BASE/i/$IMGID")
chk "缺扩展名的直链 404" 404 "$code"
code=$(curl -s -o /dev/null -w '%{http_code}' "$BASE/i/not-a-uuid.png")
chk "非法 id 的直链 404" 404 "$code"
code=$(curl -s --path-as-is -o /dev/null -w '%{http_code}' "$BASE/i/%")
chk "非法编码的直链 404" 404 "$code"
code=$(curl -s -o /dev/null -w '%{http_code}' "$BASE/i/files/$IMGID.png")
chk "带路径前缀的直链 404" 404 "$code"

LIST=$(curl -s -b "$JAR" -H "$IP" "$BASE/api/imagebed/list")
chk "图床列表 4 张" "4" "$(echo "$LIST" | jget 'o.items.length')"
chk "统计总数为 4" "4" "$(echo "$LIST" | jget 'o.total')"
chk "webp 归一化扩展名" "webp" "$(echo "$LIST" | jget 'o.items.some(i=>i.ext==="webp") ? "webp" : "none"')"
chk "列表带公开直链" "yes" "$(echo "$LIST" | jget 'o.items.every(i=>/^\/i\/[0-9a-f-]{36}\.(png|gif|bmp|webp)$/.test(i.url)) ? "yes" : "no"')"

# cursor 键集分页：limit=1 逐页翻完，应不重不漏
SEEN=""
CUR=""
for _ in $(seq 1 10); do
  RESP=$(curl -s -b "$JAR" -H "$IP" "$BASE/api/imagebed/list?limit=1${CUR:+&cursor=$CUR}")
  ID=$(echo "$RESP" | jget 'o.items.length ? o.items[0].id : ""')
  CUR=$(echo "$RESP" | jget 'o.nextCursor || ""')
  [ -n "$ID" ] || break
  SEEN="$SEEN $ID"
done
chk "cursor 分页遍历完整" "4" "$(echo "$SEEN" | wc -w)"
chk "cursor 分页无重复" "4" "$(echo "$SEEN" | tr ' ' '\n' | grep -c .)"

# 上传要计入限流（login_failures 中 imgup: 前缀的行数）
IMGROWS=$(npx wrangler d1 execute DB --local --json --command "SELECT COUNT(*) AS c FROM login_failures WHERE ip LIKE 'imgup:%'" 2>/dev/null | jget 'o[0].results[0].c')
chk "上传计入限流计数" "yes" "$([ "${IMGROWS:-0}" -ge 4 ] && echo yes || echo no)"

# 网盘图片转存到图床：两份 R2 对象互不影响
PUP=$(curl -s -b "$JAR" -H "$IP" -H 'Content-Type: application/json' -d "{\"name\":\"drive-pic.png\",\"size\":$(stat -c%s "$TMP/pic.png"),\"mime\":null,\"parentId\":null}" -X POST "$BASE/api/upload/init")
PUPID=$(echo "$PUP" | jget 'o.uploadId')
PETAG=$(curl -s -b "$JAR" -H "$IP" -X PUT --data-binary "@$TMP/pic.png" "$BASE/api/upload/$PUPID/part/1" | jget 'o.etag')
DONE=$(curl -s -b "$JAR" -H "$IP" -H 'Content-Type: application/json' -d "{\"parts\":[{\"partNumber\":1,\"etag\":\"$PETAG\"}]}" -X POST "$BASE/api/upload/$PUPID/complete")
DRIVEPIC=$(echo "$DONE" | jget 'o.item.id')
chk "网盘内图片上传完成" "drive-pic.png" "$(echo "$DONE" | jget 'o.item.name')"

IB=$(curl -s -b "$JAR" -H "$IP" -H 'Content-Type: application/json' -d "{\"fileId\":\"$DRIVEPIC\"}" -X POST "$BASE/api/imagebed/from-drive")
IBURL=$(echo "$IB" | jget 'o.item.url')
chk "网盘图片转存图床" "yes" "$(echo "$IBURL" | grep -qE '^/i/[0-9a-f-]{36}\.png$' && echo yes || echo no)"
curl -s "$BASE$IBURL" -o "$TMP/ib.png"
chk "转存内容与源一致" "$(sha256sum "$TMP/pic.png" | cut -d' ' -f1)" "$(sha256sum "$TMP/ib.png" | cut -d' ' -f1)"

code=$(curl -s -o /dev/null -w '%{http_code}' -b "$JAR" -H "$IP" -X DELETE "$BASE/api/imagebed/$IMGID")
chk "删除图片 200" 200 "$code"
code=$(curl -s -o /dev/null -w '%{http_code}' "$BASE$IMGURL")
chk "删除后直链失效 404" 404 "$code"
code=$(curl -s -o /dev/null -w '%{http_code}' -b "$JAR" -H "$IP" -X DELETE "$BASE/api/imagebed/$IMGID")
chk "重复删除 404" 404 "$code"

me=$(curl -s -b "$JAR" -H "$IP" "$BASE/api/me")
chk "me 统计图床数量" "4" "$(echo "$me" | jget 'o.imageCount')"
chk "me 统计图床占用" "yes" "$([ "$(echo "$me" | jget 'o.imageUsage')" -gt 0 ] && echo yes || echo no)"

echo "===== 8. 限流与登出 ====="
# 清空限流计数后重发 6 次：每邮箱 5 次/15 分钟，第 6 次应触发 429
printf "DELETE FROM login_failures;\n" > "$TMP/rl.sql"
npx wrangler d1 execute DB --local --file="$TMP/rl.sql" > /dev/null 2>&1
last=0
for i in $(seq 1 6); do
  last=$(curl -s -o /dev/null -w '%{http_code}' -H "$IP" -H 'Content-Type: application/json' -d '{"email":"junwind.xqw@gmail.com"}' -X POST "$BASE/api/auth/send-code")
  sleep 0.3
done
chk "验证码发送超限 429" 429 "$last"

code=$(curl -s -o /dev/null -w '%{http_code}' -b "$JAR" -c "$JAR" -H "$IP" -X POST "$BASE/api/logout")
chk "登出 200" 200 "$code"
code=$(curl -s -o /dev/null -w '%{http_code}' -b "$JAR" -H "$IP" "$BASE/api/list")
chk "登出后 list 401" 401 "$code"

echo "===== 9. 静态资源与 SPA ====="
code=$(curl -s -o /dev/null -w '%{http_code}' "$BASE/style.css")
chk "style.css 200" 200 "$code"
ct=$(curl -s -D - -o /dev/null "$BASE/s/whatever" | grep -i '^content-type' | tr -d '\r')
chk "SPA 回退 index.html" "yes" "$(echo "$ct" | grep -qi 'content-type: text/html' && echo yes || echo no)"

echo ""
echo "================================"
echo "结果: PASS=$PASS FAIL=$FAIL"
echo "================================"
rm -rf "$TMP" "$JAR" "$JAR2" "$JAR3"
exit $FAIL
