# Disk full!

> 03:12. Your phone buzzes. Then buzzes again. The order server `bourbon` is shouting **No space left on device**, and customers can't order biscuits at 3 a.m. (they absolutely do, every night).
>
> Its data disk `/srv/data` is only 64 MB (Gary bought it "on sale"). Make room, without losing anything that matters.

## Measure first

```
df -h                       # every filesystem: size, used, available, Use%
df -h /srv/data             # the one holding this path
du -sh /srv/data            # total size of everything under a folder
du -sh /srv/data/*          # one total per item (folders included)
du -sh /srv/data/* | sort -h    # smallest to biggest (-h understands K/M/G)
find /srv/data -type f -size +10M -exec ls -lh {} \;   # big files, wherever they are
```

`df` asks the **filesystem** how full it is. `du` adds up the **files it can see**. When those two disagree, something interesting is going on (task 6).

## Freeing space safely

| Situation | Do | Don't |
|---|---|---|
| a junk file | `rm file` | `rm -rf` with a wildcard you haven't checked with `ls` first |
| old logs to keep | `gzip app.log.1` (read later with `zcat` or `zgrep`) | delete evidence you might need |
| a log a program is writing | `truncate -s 0 app.log` or `: > app.log` | `rm app.log` (see below) |

## Deleted, but not gone

A file's space is freed only when **no name and no open handle** refers to it. `rm` removes the name. If a program still has the file open, it keeps writing into the invisible file and the space stays used. `du` can't see it, `df` can.

Every process's open files are under `/proc/<PID>/fd/`:

```
ls -l /proc/1234/fd                              # what process 1234 has open
ls -l /proc/[0-9]*/fd 2>/dev/null | grep deleted # open-but-deleted files anywhere
lsof +L1                                         # the same, if lsof is installed
```

The fix: restart the process (it closes the file), or truncate the file through its handle: `: > /proc/1234/fd/3`.

> On real servers, `logrotate` does the rotate, compress and truncate dance for you every night. Its `copytruncate` option exists precisely because of task 5.

This mission practises modules 2 and 8 of the *Linux & the shell* track (files, and how the system is laid out).
