# Lesson 5 (and its cold rebuild): programs to ship in containers. Which base image can each one run on?
set -e -o pipefail
mkdir -p ~/bins
cp /usr/sbin/ldconfig ~/bins/ldconfig     # static-pie: no shared libraries at all
cp /usr/bin/jq ~/bins/jq                  # dynamic: libjq, libonig, libc
cp /usr/bin/sleep ~/bins/sleep            # dynamic: only libc
cp /usr/bin/sqlite3 ~/bins/sqlite3        # dynamic: libsqlite3, libreadline, libc ...
printf '#!/usr/bin/python3\nprint("report")\n' > ~/bins/report.py
printf '#!/bin/sh\necho start\n' > ~/bins/entrypoint.sh
chmod 755 ~/bins/*
