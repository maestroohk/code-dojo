# Boss fight: incident night

> **02:47.** Your phone lights up the whole bedroom. *CRITICAL: shop.bytebiscuit.example is DOWN.* Somewhere, a person who wanted ginger snaps at 3 a.m. is staring at an error page.
>
> You are the sysadmin now. Gary is on a llama farm with no phone signal. Brenda is asleep, and you'd like to keep it that way. Log in to `biscotti` and bring the shop back.

This mission has no new commands. It is a **fight**: every tool from the earlier missions, with several faults stacked on top of each other. Fixing one reveals the next, exactly like real incidents.

## The incident loop

1. **Read the alert.** `cat /root/PAGER.txt`: what is broken, and what should "working" look like?
2. **Look before you touch.** Status first, then logs. Note the time; write down what you change.
3. **Fix one thing.** The smallest change that addresses what the logs say.
4. **Check again.** Did the error change? A *new* error is progress.
5. Repeat until it's green. Then make sure it **stays** green.

## Your toolbox from the previous missions

| symptom | look with | mission |
|---|---|---|
| disk full | `df -h`, `du -sh dir/*`, `ls -lhS` | Disk full! |
| permission denied | `ls -l`, `namei -l path`, `id user`, `su -s /bin/sh user -c '...'` | Permission heist |
| something hogging CPU | `ps aux --sort=-%cpu`, `top -b -n 1` | Process hunt |
| a service won't start | its status command, its logs, running it by hand | Packages and services |
| not listening | `ss -ltn`, `curl -v http://127.0.0.1:port/` | Packages and services |
| what did it say? | `tail -n 30 log`, `grep -i error log` | Pipes and plumbing |

On this server:

```
shopctl status | start | stop | restart       # the shop (a supervisor that runs shop-api as user shop)
/var/log/shop/supervisor.log                  # starts, crashes, giving up
/var/log/shop/shop-api.log                    # the app's own errors (Python tracebacks: read the LAST line)
/etc/shop/shop.conf                           # the app's config
runuser -u shop -- /srv/shop/bin/shop-api     # run the app by hand, as its user, to see errors live (Ctrl+C to stop)
```

> **Supervisors that give up** are a feature: an app that crashes on start would otherwise restart in a tight loop forever, filling logs and hiding the first, useful error. systemd does the same (`StartLimitBurst`), and you'd see it in `systemctl status` as *start request repeated too quickly*.

Beat this one and you have earned the title. **Linux boss.**

This mission is the boss of the whole *Linux & the shell* track: it draws on every module.
