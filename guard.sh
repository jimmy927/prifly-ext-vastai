#!/bin/sh
# prifly lease guard: destroys this Vast.ai box when its lease is over, even
# while the prifly that watches it is closed.
#
# The prifly Vast.ai extension copies this to /root/.lease/guard.sh and keeps
# /root/.lease/until (the lease's end, epoch seconds) current. Once the lease
# is over by more than the extension's grace — plus a margin, so the extension
# goes first whenever it is running — this runs /root/.lease/save if the box
# has one (again after 10 minutes if it fails), and then destroys the box with
# its own restricted key, CONTAINER_API_KEY, which Vast.ai gives every box.
# What it did is in /root/.lease/guard.log.

dir=/root/.lease
grace=${LEASE_GRACE_SECONDS:-1800}

# Vast.ai sets these in the container's first process; an ssh login may not have them.
from_init() { tr '\0' '\n' </proc/1/environ | sed -n "s/^$1=//p" | head -n 1; }
id=${CONTAINER_ID:-$(from_init CONTAINER_ID)}
key=${CONTAINER_API_KEY:-$(from_init CONTAINER_API_KEY)}

say() { echo "$(date -u +%FT%TZ) $*"; }

# The lease is over, and has been for longer than the grace.
over() {
  until=$(cat "$dir/until" 2>/dev/null) || return 1
  case $until in '' | *[!0-9]*) return 1 ;; esac
  [ "$(date +%s)" -gt $((until + grace)) ]
}

save() {
  [ -x "$dir/save" ] || return 0
  say "saving"
  timeout 600 "$dir/save"
}

# Save; if that fails, once more after 10 minutes. False only when the lease
# was extended meanwhile — a second failure still goes on to destroy.
save_twice() {
  save && return 0
  say "save failed; trying once more in 10 minutes"
  sleep 600
  over || return 1
  save || say "save failed again; destroying anyway"
  return 0
}

if [ -z "$id" ] || [ -z "$key" ]; then
  say "no CONTAINER_ID or CONTAINER_API_KEY: this box cannot destroy itself"
  exit 1
fi
say "watching instance $id"

saved=
while :; do
  sleep 60
  over || { saved=; continue; }
  if [ -z "$saved" ]; then
    say "lease over"
    save_twice || continue
    saved=1
  fi
  over || { saved=; continue; }
  say "destroying instance $id"
  curl -fsS -X DELETE -H "Authorization: Bearer $key" \
    "https://console.vast.ai/api/v0/instances/$id/" && exit 0
  say "destroy failed; trying again in a minute"
done
