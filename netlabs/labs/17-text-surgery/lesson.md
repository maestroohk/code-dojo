# Text surgery

> Marketing exported the customer list from "the new CRM". It arrived as `/srv/export/customers.csv` on `garibaldi`, and it is a crime scene: semicolons instead of commas, spaces everywhere, `JOAN.JOHNSON@EXAMPLE.COM` shouting, Windows line endings and customers listed twice.
>
> Brenda: "I need a clean list and a per-city report. Without Excel. Excel ate the last one."

Scrub in. Your instruments are the classic Unix text tools: each does one small thing to a stream of lines, and you chain them with `|`.

## The instruments

```
tr -d '\r'               delete characters            tr 'A-Z' 'a-z'     translate (lowercase)
tr -s ' '                squeeze repeats into one     cat -A file        show invisible characters
cut -d';' -f2,4          fields 2 and 4, split on ;   tail -n +2         everything from line 2 on (drop a header)
sort -t, -k3,3           sort on field 3, split on ,  sort -n / -r / -u  numeric / reversed / unique
uniq                     drop repeated adjacent lines uniq -c            ...and count them
```

## sed: find and replace

```
sed 's/old/new/'         first match on each line     sed 's/old/new/g'  every match
sed 's/^ *//'            ^ = start of line            sed 's/ *$//'      $ = end of line
sed 's/ *; */,/g'        ; with any spaces around it -> ,
sed 's/a/b/; s/c/d/'     several edits in one go      sed -n '5,10p'     print only lines 5 to 10
```

In a pattern, ` *` means "zero or more spaces" and `.` means "any character".

## awk: a tiny language for columns

awk splits each line into fields `$1`, `$2`... (`$0` is the whole line, `NF` the number of fields) and runs your program on every line:

```
awk -F, '{ print $2 }' file                     # column 2 of a comma-separated file
awk -F, '$5 > 20' file                          # only rows where column 5 is over 20
awk -F, '{ sum += $5 } END { print sum }' file  # add up a column
awk -F, -v OFS=, '{ $3 = tolower($3); print }'  # change a column, keep commas on output
awk -F, '{ t[$4] += $5 } END { for (k in t) print k, t[k] }'   # totals per group
```

`-F` sets the input field separator, `OFS` the output one. `END { ... }` runs once, after the last line.

## Surgical technique

1. Look first: `head`, and `cat -A` for hidden characters.
2. Add **one stage** to the pipeline at a time, with `| head` on the end.
3. Only when it looks right, redirect it with `> file`.

This mission practises module 2 of the *Linux & the shell* track (text pipelines).
