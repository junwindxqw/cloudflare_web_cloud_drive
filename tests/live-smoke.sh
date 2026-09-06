#!/usr/bin/env bash
# 生产环境冒烟测试：上传 -> 下载哈希 -> 分享 -> 公开访问
set -u
BASE=https://drive.junwind.site
JAR=$(mktemp)
PW=$(cat /tmp/jundrive-pw.txt)
PASS=0; FAIL=0
chk() { if [ "$2" = "$3" ]; then PASS=$((PASS+1)); echo "PASS: $1"; else FAIL=$((FAIL+1)); echo "FAIL: $1 (expected=[$2] actual=[$3])"; fi; }
jget() { node -e "let d='';process.stdin.on('data',c=>d+=c).on('end',()=>{try{const o=JSON.parse(d);const v=$1;console.log(typeof v==='object'&&v!==null?JSON.stringify(v):v)}catch(e){console.log('PARSE_ERR')}})"; }

code=$(curl -s -o /dev/null -w '%{http_code}' -c "$JAR" -H 'Content-Type: application/json' -d "{\"password\":\"$PW\"}" -X POST "$BASE/api/login")
chk "线上登录 200" 200 "$code"

head -c 1048576 /dev/urandom > /tmp/live-test.bin
SHA=$(sha256sum /tmp/live-test.bin | cut -d' ' -f1)

UP=$(curl -s -b "$JAR" -H 'Content-Type: application/json' -d '{"name":"live-test.bin","size":1048576,"mime":"application/octet-stream","parentId":null}' -X POST "$BASE/api/upload/init")
UPID=$(echo "$UP" | jget 'o.uploadId')
chk "线上 upload/init" "yes" "$([ -n "$UPID" ] && [ "$UPID" != "PARSE_ERR" ] && echo yes || echo no)"

ET=$(curl -s -b "$JAR" -X PUT --data-binary "@/tmp/live-test.bin" "$BASE/api/upload/$UPID/part/1" | jget 'o.etag')
DONE=$(curl -s -b "$JAR" -H 'Content-Type: application/json' -d "{\"parts\":[{\"partNumber\":1,\"etag\":\"$ET\"}]}" -X POST "$BASE/api/upload/$UPID/complete")
FID=$(echo "$DONE" | jget 'o.item.id')
chk "线上上传完成 1048576" "1048576" "$(echo "$DONE" | jget 'o.item.size')"

curl -s -b "$JAR" "$BASE/api/file/$FID/download" -o /tmp/live-dl.bin
SHA2=$(sha256sum /tmp/live-dl.bin | cut -d' ' -f1)
chk "线上下载哈希一致" "$SHA" "$SHA2"

SH=$(curl -s -b "$JAR" -H 'Content-Type: application/json' -d "{\"fileId\":\"$FID\"}" -X POST "$BASE/api/share")
TOKEN=$(echo "$SH" | jget 'o.token')
code=$(curl -s -o /dev/null -w '%{http_code}' "$BASE/s/$TOKEN")
chk "公开分享页 200" 200 "$code"
PM=$(curl -s "$BASE/api/pub/$TOKEN")
chk "公开 meta 名称" "live-test.bin" "$(echo "$PM" | jget 'o.name')"
curl -s "$BASE/api/pub/$TOKEN/file/$FID/download" -o /tmp/live-sdl.bin
SHA3=$(sha256sum /tmp/live-sdl.bin | cut -d' ' -f1)
chk "公开下载哈希一致" "$SHA" "$SHA3"

code=$(curl -s -o /dev/null -w '%{http_code}' -b "$JAR" -X DELETE "$BASE/api/item/$FID")
chk "清理测试文件" 200 "$code"

echo "结果: PASS=$PASS FAIL=$FAIL"
rm -f /tmp/live-test.bin /tmp/live-dl.bin /tmp/live-sdl.bin "$JAR"
exit $FAIL
