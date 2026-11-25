# Cron and automation

> Brenda's new rule: "If a human does it twice, a robot does it the third time." The automation server `oreo` runs **cron**, the classic Unix scheduler, and Gary's old crontab is still on it. Gary's jobs have a reputation. Nobody knows why the crumbs folder is empty every Tuesday morning.

> **About this server:** containers don't run a full init system, so `oreo` runs **minicron**, a small stand-in that behaves like classic cron: same crontab format, same `crontab` command, same tiny environment for jobs, output mailed to `/var/mail/root`, log in `/var/log/cron.log`. One extra it has that real cron lacks: `minicron --run-now <text>` runs a job immediately, exactly as cron would, so you don't have to wait for the clock.

## The crontab

Each user has a crontab: a list of jobs, one per line.

```
# ┌ minute (0-59)
# │  ┌ hour (0-23)
# │  │ ┌ day of month (1-31)
# │  │ │ ┌ month (1-12)
# │  │ │ │ ┌ day of week (0-7, 0 and 7 are Sunday; or mon, tue...)
# │  │ │ │ │
  30 4 * * 1-5   /usr/local/bin/cleanup    # 04:30, Monday to Friday
  */15 * * * *   /usr/local/bin/ping-oven  # every 15 minutes
  0 9,17 * * *   /usr/local/bin/remind     # 09:00 and 17:00
  @daily         /usr/local/bin/rotate     # once a day at midnight
```

`*` means "every", `a-b` a range, `a,b` a list, `*/n` every n-th. [crontab.guru](https://crontab.guru) explains any schedule in plain English.

```
crontab -l          # list my jobs
crontab -e          # edit them (installs on save, after a syntax check)
crontab -r          # remove ALL of them (careful: no confirmation)
crontab file        # install a file as my crontab;  crontab -  reads stdin
(crontab -l; echo '0 6 * * * /usr/local/bin/wake-up') | crontab -   # add a job in one line
```

## Cron is not your shell

The most common cron bug in the world: *"It works when I run it!"* Cron starts jobs with a **minimal environment**:

| | your terminal | a cron job |
|---|---|---|
| shell | bash, reads `~/.bashrc` | `/bin/sh`, reads nothing |
| PATH | long, with your additions | `/usr/bin:/bin` |
| aliases, functions | yes | no |
| output | your screen | mailed to the user (or lost) |

Fixes: use **full paths** (`/opt/tool/bin/tool`), or set variables at the top of the crontab (they apply to the job lines below them):

```
PATH=/usr/local/bin:/usr/bin:/bin:/opt/tool/bin
MAILTO=ops@example.com
```

## The percent sign

In a crontab, an unescaped `%` ends the command, and everything after it is fed to the job as input. `date +%F` must be written `date +\%F` there. (Or put the command in a script, and schedule the script.)

## Where to look when a job misbehaves

```
cat /var/log/cron.log        # did it start? what exit status?  (real systems: journalctl -u cron or /var/log/syslog)
cat /var/mail/root           # what did it print? (cron mails all output)
```

> On systemd machines, **timers** (`systemctl list-timers`) are the modern alternative to cron. The track's module 4 compares the two. The ideas carry over: schedule, environment, logs.

This mission practises module 4 of the *Linux & the shell* track (systemd and cron).
