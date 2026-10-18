#!/usr/bin/env bash
# One-command health check for the shared Perfect Design server (Vantage co-hosted).
# Read-only: it changes nothing. Run on the server as root:
#
#   /opt/vantage/deploy/single-host/check.sh
#
# or from a machine with the server key:
#
#   ssh -i ~/.ssh/hetzner_perfectdesign root@46.225.78.249 /opt/vantage/deploy/single-host/check.sh
#
# Exit status: 0 = every check passed (warnings allowed), 1 = at least one FAIL.
set -u

PASS=0; WARN=0; FAIL=0
pass() { printf '  \033[32mPASS\033[0m  %s\n' "$1"; PASS=$((PASS + 1)); }
warn() { printf '  \033[33mWARN\033[0m  %s\n' "$1"; WARN=$((WARN + 1)); }
fail() { printf '  \033[31mFAIL\033[0m  %s\n' "$1"; FAIL=$((FAIL + 1)); }
code() { curl -s -o /dev/null -m 10 -w '%{http_code}' "$@" 2>/dev/null || echo 000; }
hours_since() { echo $(( ( $(date +%s) - $(stat -c %Y "$1") ) / 3600 )); }

VANTAGE=/opt/vantage
COMPOSE="docker compose -p vantage --env-file $VANTAGE/.env -f $VANTAGE/deploy/docker-compose.yml -f $VANTAGE/deploy/single-host/compose.override.yml"

echo "Perfect Design services (must be unaffected by Vantage)"
api_local=$(code http://127.0.0.1:3001/health); api_public=$(code https://api.perfectdesign.app/health)
[ "$api_local" = 200 ] && [ "$api_public" = 200 ] && pass "Perfect Design API: local $api_local, public $api_public" || fail "Perfect Design API: local $api_local, public $api_public (expected 200/200)"
icaur=$(code https://icaur.com.sg/)
[ "$icaur" = 301 ] && pass "icaur.com.sg redirects ($icaur)" || fail "icaur.com.sg answered $icaur (expected 301)"
pm2_state=$(pm2 jlist 2>/dev/null | node -e 'let s="";process.stdin.on("data",d=>s+=d).on("end",()=>{try{console.log(JSON.parse(s).map(p=>p.name+"="+p.pm2_env.status).join(" "))}catch{console.log("unreadable")}})')
for app in perfectdesign-api perfectdesign-comms-worker; do
  echo "$pm2_state" | grep -q "$app=online" && pass "PM2 $app online" || fail "PM2 $app not online ($pm2_state)"
done
waha=$(docker inspect -f '{{.State.Status}} {{if .State.Health}}{{.State.Health.Status}}{{end}}' waha 2>/dev/null || echo missing)
case "$waha" in
  "running healthy"|"running ") pass "WhatsApp bridge (waha): $waha" ;;
  running*) warn "WhatsApp bridge (waha): $waha — it reported unhealthy before Vantage was installed" ;;
  *) fail "WhatsApp bridge (waha): $waha" ;;
esac
if systemctl is-active --quiet caddy && caddy validate --config /etc/caddy/Caddyfile --adapter caddyfile >/dev/null 2>&1; then
  pass "Caddy active and its config validates"
else
  fail "Caddy inactive or /etc/caddy/Caddyfile does not validate"
fi
mem=$(free -m | awk '/Mem:/{print $7}'); disk=$(df -BG --output=avail / | tail -1 | tr -dc 0-9)
if [ "$mem" -lt 1024 ]; then fail "memory available ${mem} MB (under 1 GB)"; elif [ "$mem" -lt 1536 ]; then warn "memory available ${mem} MB"; else pass "memory available ${mem} MB"; fi
if [ "$disk" -lt 5 ]; then fail "disk free ${disk} GB (under 5 GB)"; elif [ "$disk" -lt 10 ]; then warn "disk free ${disk} GB"; else pass "disk free ${disk} GB"; fi

echo "Vantage (partners.perfectdesign.my)"
for svc in postgres api worker; do
  st=$(docker inspect -f '{{.State.Status}} {{if .State.Health}}{{.State.Health.Status}}{{end}}' "vantage-$svc-1" 2>/dev/null || echo missing)
  [ "$st" = "running healthy" ] && pass "container vantage-$svc-1: $st" || fail "container vantage-$svc-1: $st"
done
v_local=$(code http://127.0.0.1:18787/health); v_public=$(code https://partners.perfectdesign.my/api/health); v_web=$(code https://partners.perfectdesign.my/)
[ "$v_local" = 200 ] && [ "$v_public" = 200 ] && [ "$v_web" = 200 ] && pass "Vantage API local $v_local, public $v_public; web app $v_web" || fail "Vantage API local $v_local, public $v_public, web app $v_web (expected 200)"
signup=$(code -X POST -H 'content-type: application/json' -d '{"email":"check@example.com","password":"a-long-password","name":"C","merchantName":"C"}' https://partners.perfectdesign.my/api/auth/signup)
[ "$signup" = 403 ] && pass "public signup is closed (403)" || fail "public signup answered $signup (expected 403 — strangers could create accounts)"
cert_end=$(echo | openssl s_client -connect partners.perfectdesign.my:443 -servername partners.perfectdesign.my 2>/dev/null | openssl x509 -noout -enddate 2>/dev/null | cut -d= -f2)
if [ -n "$cert_end" ]; then
  days=$(( ( $(date -d "$cert_end" +%s) - $(date +%s) ) / 86400 ))
  [ "$days" -ge 14 ] && pass "certificate valid for $days more days (Caddy renews it automatically)" || warn "certificate expires in $days days — check Caddy's renewal"
else
  fail "could not read the partners.perfectdesign.my certificate"
fi

echo "Isolation (Vantage must not reach anything else on this server)"
ufw status 2>/dev/null | grep -qE "on br-vantage +DENY( IN)?( |$)" && pass "firewall rule 'deny in on br-vantage' is present" || fail "firewall rule 'deny in on br-vantage' is missing (ufw insert 1 deny in on br-vantage)"
probe=$(docker exec vantage-api-1 node -e '
const net=require("node:net");
const t=(h,p)=>new Promise(r=>{const s=net.connect({host:h,port:p,timeout:2500});const d=x=>{s.destroy();r(x)};s.on("connect",()=>d("open"));s.on("timeout",()=>d("blocked"));s.on("error",()=>d("blocked"))});
(async()=>{const open=[];for(const h of ["172.31.250.1","46.225.78.249"])for(const p of [22,80,443,2019,3000,3001,5432,6379])if(await t(h,p)==="open")open.push(h+":"+p);
const net443=await t("1.1.1.1",443);console.log((open.join(",")||"none")+" "+net443)})()' 2>/dev/null || echo "error error")
open_ports=${probe% *}; egress=${probe##* }
[ "$open_ports" = none ] && pass "from inside Vantage, every host service is blocked (SSH, web, Caddy admin, WhatsApp, PD API, Postgres, Redis)" || fail "from inside Vantage these host services are reachable: $open_ports"
[ "$egress" = open ] && pass "Vantage can reach the internet (needed for email)" || warn "Vantage cannot reach the internet ($egress) — outbound email would fail"
exposed=$(ss -ltnH 2>/dev/null | awk '{print $4}' | grep -E ':(18787|18788)$' | grep -vE '^(127\.0\.0\.1|\[::1\]):' || true)
[ -z "$exposed" ] && pass "Vantage listens on loopback only (127.0.0.1:18787)" || fail "Vantage port exposed beyond loopback: $exposed"
pg_ports=$(docker port vantage-postgres-1 2>/dev/null)
[ -z "$pg_ports" ] && pass "Vantage's database has no host port" || fail "Vantage's database is published: $pg_ports"
limits=$(for svc in postgres api worker; do docker inspect -f '{{.HostConfig.Memory}}' "vantage-$svc-1" 2>/dev/null; done | sort -u | tr '\n' ' ')
[ "$limits" = "536870912 " ] && pass "memory limit 512 MB on every Vantage container" || fail "Vantage memory limits not as expected: $limits"

echo "Backups"
latest=$(ls -1t /opt/backups/vantage/vantage-*.dump 2>/dev/null | head -1)
if [ -n "$latest" ]; then
  age=$(hours_since "$latest")
  [ "$age" -le 26 ] && pass "Vantage dump $(basename "$latest") is ${age}h old" || fail "latest Vantage dump is ${age}h old (nightly job at 02:45 — see /var/log/vantage-backup.log)"
else
  fail "no Vantage dump in /opt/backups/vantage"
fi
comms=$(ls -1t /opt/backups/postgres/perfectdesign_comms-*.dump 2>/dev/null | head -1)
[ -n "$comms" ] && { age=$(hours_since "$comms"); [ "$age" -le 26 ] && pass "Perfect Design comms dump is ${age}h old" || warn "Perfect Design comms dump is ${age}h old"; } || warn "no Perfect Design comms dump found"
warn "both backups live on this server only — no off-server copy yet"

echo
if [ "$FAIL" -eq 0 ]; then
  printf 'Result: all checks passed (%d passed, %d warnings)\n' "$PASS" "$WARN"; exit 0
else
  printf 'Result: %d FAILED, %d passed, %d warnings\n' "$FAIL" "$PASS" "$WARN"; exit 1
fi
