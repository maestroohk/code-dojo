# The process hunt

> Monday morning. The build server `digestive` sounds like it is about to take off. Nobody is building anything. The load graph looks like a ski jump. Brenda, from the doorway: "Is it mining something? Tell me it's not mining something."

A **process** is a running program. Each has a **PID** (process ID), a **parent** (PPID: the process that started it), an owner, a state and a share of the CPU. Your mission: find out who is running what, and deal with the troublemakers.

## Looking

```
ps aux                          # every process, with user, %CPU, %MEM and command
ps aux --sort=-%cpu | head      # the hungriest first
ps -eo pid,ppid,ni,stat,args    # pick your own columns
ps -p 1234 -o pid,ppid,args     # one process
pgrep -f oven                   # PIDs whose command line contains "oven"
top                             # live view (q quits, P sorts by CPU, M by memory)
top -b -n 1 | head -15          # one snapshot, handy in scripts
```

The **STAT** column: `R` running, `S` sleeping (waiting for something), `T` stopped, `Z` zombie.

## Signals

`kill` doesn't only kill: it sends a **signal**.

```
kill 1234            # TERM (15): "please stop" - the program can clean up, or ignore it
kill -INT 1234       # INT (2): what Ctrl+C sends
kill -HUP 1234       # HUP (1): many daemons reload their config on HUP
kill -9 1234         # KILL (9): stop immediately; cannot be caught or ignored
pkill -f name        # signal by name instead of PID
```

Always try TERM first. KILL gives the program no chance to save its work or remove lock files.

## Zombies and orphans

When a process exits, it stays in the table as a **zombie** until its parent reads its exit status. A few zombies are harmless; a parent that never collects them is a bug. You can't kill a zombie (it is already dead): you deal with its **parent**. When a parent dies, its children are adopted by PID 1, which collects them.

## Priority: nice

```
nice -n 10 ./long-job        # start with lower priority (nice 10)
renice -n 15 -p 1234         # change a running process
```

Nice values run from -20 (first in the queue) to 19 (after everyone else). Only root may make a process *less* nice.

## Jobs in your own shell

```
sleep 300 &          # run in the background; prints [1] 4321
jobs                 # your shell's background jobs
fg %1                # bring job 1 to the foreground
Ctrl+Z, then bg      # pause the foreground job, then continue it in the background
nohup cmd &          # keep running after you log out
```

This mission practises module 4 of the *Linux & the shell* track (processes and signals).
