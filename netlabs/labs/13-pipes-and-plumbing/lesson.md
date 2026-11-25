# Pipes and plumbing

> Yesterday a celebrity tweeted "biscuits by drone?? obsessed", and the order system on `hobnob` had the busiest day in company history. Brenda has questions. Brenda wants them answered **by lunch**. Brenda does not want a spreadsheet.

The log `/var/log/orders.log` has one line per order:

```
2026-11-24T09:14:02 order=10342 customer=hana cookie=jammy-dodger qty=3 city=york status=ok
```

You will answer every question with a **pipeline**: small commands joined with `|`, each doing one job and passing its output to the next.

## The plumbing kit

```
grep 'x'           keep lines containing x          grep -v 'x'   lines NOT containing x
grep -o 'k=[^ ]*'  print only the matching part     grep -c 'x'   count matching lines
cut -d= -f2        split on "=", keep field 2        cut -d' ' -f3 split on spaces, keep field 3
sort               sort lines alphabetically         sort -n       numerically   -r reversed
uniq -c            collapse runs of equal lines, with a count (sort first!)
head -3            first 3 lines                     tail -3       last 3 lines
wc -l              count lines
```

## Building a pipeline, step by step

Never write a long pipeline in one go. Add one stage at a time and look at the output each time (put `| head` at the end while experimenting):

```
grep -o 'qty=[^ ]*' /var/log/orders.log | head            # qty=3, qty=7...
grep -o 'qty=[^ ]*' /var/log/orders.log | sort | uniq -c   # how often each quantity
... | sort | uniq -c | sort -rn | head -5                  # the five most common, biggest first
```

`sort | uniq -c | sort -rn | head` is the classic **"top N"** recipe. You will use it for the rest of your career.

## Redirection

```
cmd > file         stdout into a file (replaces it)       cmd >> file    append
cmd 2> file        stderr (errors) into a file             cmd 2>&1       stderr goes where stdout goes
cmd < file         a file as input                         cmd > /dev/null  throw the output away
```

Every program has two output streams: **stdout** (stream 1) for results and **stderr** (stream 2) for complaints. On screen they look the same; redirection tells them apart.

This mission practises module 2 of the *Linux & the shell* track (streams, redirection and text pipelines).
